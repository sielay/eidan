// SPDX-License-Identifier: AGPL-3.0-or-later
// Vendor the configured paid/extra bundles into packages/<name>/ and fold them into the engine
// host config, so the built image carries them. Bundles are AGPL packages/<name> (eidan's own) or an operator's external plugin repo
// is gitignored; this runs at build time, never committed. Idempotent.
import { readFileSync, writeFileSync, cpSync, rmSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { CORE_PLUGINS } from "./manifest.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MATBOT_YAML = join(ROOT, "infra/fly-mb/matbot.yaml");
const PLUGIN_API_LINK = "link:../../external/matbot/packages/core/plugin-api";
const WEB_PLUGINS_DIR = join(ROOT, "apps/web/src/plugins");
const WEB_REGISTRY = join(WEB_PLUGINS_DIR, "registry.generated.ts");
const BUNDLE_CSS = join(WEB_PLUGINS_DIR, "bundles.generated.css");
const APP_DIR = join(ROOT, "apps/web/src/app");

export function loadConfig(path = join(ROOT, "eidan.deploy.json")) {
  if (!existsSync(path)) return { bundles: [], targets: {} };
  return JSON.parse(readFileSync(path, "utf8"));
}

// Copy a bundle (local path or git owner/repo#ref) into packages/<name>, drop its node_modules, and
// point its matbot-plugin-api dep at the host's vendored copy (matbot isn't published to npm).
export function vendorBundle(bundle) {
  if (!bundle.name) throw new Error("bundle needs a name");
  const dest = join(ROOT, "packages", bundle.name);
  rmSync(dest, { recursive: true, force: true });

  if (bundle.path) {
    cpSync(resolve(ROOT, bundle.path), dest, { recursive: true });
  } else if (bundle.git) {
    const [repo, ref] = bundle.git.split("#");
    const tmp = mkdtempSync(join(tmpdir(), "eidan-bundle-"));
    execFileSync("git", ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), `https://github.com/${repo}.git`, tmp], { stdio: "inherit" });
    const sub = bundle.subdir ? join(tmp, bundle.subdir) : tmp;
    cpSync(sub, dest, { recursive: true });
    rmSync(join(dest, ".git"), { recursive: true, force: true });
  } else {
    throw new Error(`bundle ${bundle.name}: provide "path" or "git"`);
  }

  rmSync(join(dest, "node_modules"), { recursive: true, force: true });
  const pkgPath = join(dest, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies ??= {};
  if (pkg.dependencies["@matatbread/matbot-plugin-api"]) {
    pkg.dependencies["@matatbread/matbot-plugin-api"] = PLUGIN_API_LINK;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
  return dest;
}

// Effective job kinds for a vendored bundle: the kinds it DECLARES (package.json `eidan.kinds`) are
// authoritative, unioned with any kinds pinned in the deploy manifest (`kinds[]`, or legacy `kind`).
export function bundleKinds(b) {
  let declared = [];
  try { declared = (JSON.parse(readFileSync(join(ROOT, "packages", b.name, "package.json"), "utf8")).eidan?.kinds) ?? []; } catch { /* not vendored / no manifest */ }
  const pinned = Array.isArray(b.kinds) ? b.kinds : (b.kind ? [b.kind] : []);
  return [...new Set([...declared, ...pinned].filter((k) => typeof k === "string" && k))];
}

// Fold the bundles into infra/fly-mb/matbot.yaml in place (idempotent: strip any prior bundle lines,
// then re-insert before the "# Bundles append here" slot). The committed file stays core-only.
export function applyMatbotYaml(bundles) {
  const lines = readFileSync(MATBOT_YAML, "utf8").split("\n").filter((l) => !/# eidan-bundle:/.test(l));
  const slot = lines.findIndex((l) => /# Bundles append here/.test(l));
  const inserts = bundles.map((b) => { const k = bundleKinds(b); return `  - ./packages/${b.name} # eidan-bundle: ${b.name} (kinds=${k.join("|") || "?"})`; });
  if (slot >= 0) lines.splice(slot, 0, ...inserts);
  else lines.push(...inserts);
  writeFileSync(MATBOT_YAML, lines.join("\n"));
}

// A bundle plugin contributes UI by declaring `eidan.frontend` in its package.json (the eidan#284
// contract):
//   "eidan": { "frontend": {
//      "package": "frontend",                              // dir copied to apps/web/src/plugins/<name>/
//      "stylesheet": "bundle.css",                        // imported globally
//      "routes": [{ "path": "/", "component": "Reports.tsx" }],     // -> /p/<name>/<path>
//      "api":    [{ "path": "/api/mybundle/reports", "handler": "api/route.ts" }],  // Next route handler
//      "nav":    { "group": "My Bundle", "sections": [ /* NavSection[] */ ] } } }
// vendorFrontend copies the package dir + mounts the api handlers into the Next app tree, and returns
// the route/slot/nav/style info for the registry.
export function vendorFrontend(name) {
  const pkgPath = join(ROOT, "packages", name, "package.json");
  if (!existsSync(pkgPath)) return null;
  const fe = (JSON.parse(readFileSync(pkgPath, "utf8")).eidan ?? {}).frontend;
  if (!fe) return null; // logic-only plugin — no UI

  const srcDir = join(ROOT, "packages", name, fe.package);
  const destDir = join(WEB_PLUGINS_DIR, name);
  rmSync(destDir, { recursive: true, force: true });
  cpSync(srcDir, destDir, { recursive: true });

  // Mount each declared API handler as a Next route: apps/web/src/app/<path>/route.ts
  for (const a of fe.api ?? []) {
    const dest = join(APP_DIR, a.path.replace(/^\//, ""), "route.ts");
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(srcDir, a.handler), dest);
  }

  const drop = (f) => String(f).replace(/\.(t|j)sx?$/, "");
  return {
    name,
    stylesheet: fe.stylesheet ? `./${name}/${fe.stylesheet}` : null,
    routes: (fe.routes ?? []).map((r) => ({ path: r.path, component: drop(r.component) })),
    slots: (fe.slots ?? []).map((s) => ({ slot: s.slot, component: drop(s.component) })),
    nav: fe.nav ? { bundle: name, group: fe.nav.group, sections: fe.nav.sections } : null,
  };
}

// Regenerate apps/web/src/plugins/registry.generated.ts (routes/slots/nav) + bundles.generated.css
// (global @imports) from the vendored frontends. Each route/slot is a literal dynamic import so Next
// code-splits it.
export function writeFrontendRegistry(fronts) {
  const routes = [];
  const slots = [];
  const navs = [];
  const styles = [];
  for (const f of fronts) {
    for (const r of f.routes)
      routes.push(`  { plugin: ${JSON.stringify(f.name)}, path: ${JSON.stringify(r.path)}, load: () => import("@/plugins/${f.name}/${r.component}") }`);
    for (const s of f.slots)
      slots.push(`  { plugin: ${JSON.stringify(f.name)}, slot: ${JSON.stringify(s.slot)}, load: () => import("@/plugins/${f.name}/${s.component}") }`);
    if (f.nav) navs.push(`  ${JSON.stringify(f.nav)}`);
    if (f.stylesheet) styles.push(`@import "${f.stylesheet}";`);
  }
  const ts = [
    "// SPDX-License-Identifier: AGPL-3.0-or-later",
    "// AUTO-GENERATED by eidan deploy assembly (#284). Do not edit — regenerated from each plugin's eidan.frontend manifest.",
    'import type { ComponentType } from "react";',
    'import type { NavContribution } from "@/lib/shell/nav";',
    "",
    "// eslint-disable-next-line @typescript-eslint/no-explicit-any",
    "export type PluginLoad = () => Promise<{ default: ComponentType<any> }>;",
    "export type PluginRoute = { plugin: string; path: string; load: PluginLoad };",
    "export type PluginSlotEntry = { plugin: string; slot: string; load: PluginLoad };",
    "",
    `export const pluginRoutes: PluginRoute[] = [\n${routes.join(",\n")}${routes.length ? "\n" : ""}];`,
    "",
    `export const pluginSlots: PluginSlotEntry[] = [\n${slots.join(",\n")}${slots.length ? "\n" : ""}];`,
    "",
    `export const pluginNav: NavContribution[] = [\n${navs.join(",\n")}${navs.length ? "\n" : ""}];`,
    "",
  ].join("\n");
  writeFileSync(WEB_REGISTRY, ts);
  writeFileSync(BUNDLE_CSS, `/* AUTO-GENERATED: bundle stylesheets (eidan deploy assembly). */\n${styles.join("\n")}\n`);
}

export function assemble(config) {
  // Skip "//" comment entries and anything without a name + source (path|git) — never crash on them.
  const bundles = (config.bundles ?? []).filter((b) => b && b.name && !String(b.name).startsWith("//") && (b.path || b.git));
  for (const b of bundles) vendorBundle(b);
  applyMatbotYaml(bundles);
  // Frontends: vendor each plugin's eidan.frontend (admin screens, routes, nav), regenerate the
  // registry + bundle CSS. Core plugins (always-on, e.g. the folded-in integrations imap/ical/google)
  // ship UI too. NB: vendor frontends for ALL configured bundle names — INCLUDING sourceless folded
  // AGPL bundles (charles-*, social-*) that have no path/git (their code already lives in
  // packages/<name>, so there's nothing to vendor-copy, but their eidan.frontend admin screens still
  // must be mounted). Using the path/git-filtered `bundles` here silently dropped those screens.
  // vendorFrontend returns null for logic-only plugins, so this is a no-op for the rest.
  const allBundleNames = (config.bundles ?? [])
    .filter((b) => b && b.name && !String(b.name).startsWith("//"))
    .map((b) => b.name);
  const fronts = [...CORE_PLUGINS, ...allBundleNames]
    .map((name) => vendorFrontend(name))
    .filter(Boolean);
  if (fronts.length) writeFrontendRegistry(fronts);
  const kinds = ["chat", ...bundles.flatMap((b) => bundleKinds(b))];
  return { bundles, fronts, kinds: [...new Set(kinds)] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig(process.argv[2]);
  const { bundles, fronts, kinds } = assemble(cfg);
  console.log(`[assemble] vendored ${bundles.length} bundle(s): ${bundles.map((b) => b.name).join(", ") || "(none)"}`);
  console.log(`[assemble] frontends from ${fronts.length} bundle(s): ${fronts.map((f) => f.name).join(", ") || "(none)"}`);
  console.log(`[assemble] job kinds -> ${kinds.join(",")}`);
}
