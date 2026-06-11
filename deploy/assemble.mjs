// SPDX-License-Identifier: AGPL-3.0-or-later
// Vendor the configured paid/extra bundles into packages/<name>/ and fold them into the engine
// host config, so the built image carries them. Bundles are private sibling repos — packages/<name>
// is gitignored; this runs at build time, never committed. Idempotent.
import { readFileSync, writeFileSync, cpSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MATBOT_YAML = join(ROOT, "infra/fly-mb/matbot.yaml");
const PLUGIN_API_LINK = "link:../../external/matbot/packages/core/plugin-api";

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

// Fold the bundles into infra/fly-mb/matbot.yaml in place (idempotent: strip any prior bundle lines,
// then re-insert before the "# Paid bundles append here" slot). The committed file stays core-only.
export function applyMatbotYaml(bundles) {
  const lines = readFileSync(MATBOT_YAML, "utf8").split("\n").filter((l) => !/# eidan-bundle:/.test(l));
  const slot = lines.findIndex((l) => /# Paid bundles append here/.test(l));
  const inserts = bundles.map((b) => `  - ./packages/${b.name} # eidan-bundle: ${b.name} (kind=${b.kind ?? "?"})`);
  if (slot >= 0) lines.splice(slot, 0, ...inserts);
  else lines.push(...inserts);
  writeFileSync(MATBOT_YAML, lines.join("\n"));
}

export function assemble(config) {
  for (const b of config.bundles ?? []) vendorBundle(b);
  applyMatbotYaml(config.bundles ?? []);
  const kinds = ["chat", ...(config.bundles ?? []).map((b) => b.kind).filter(Boolean)];
  return { bundles: config.bundles ?? [], kinds: [...new Set(kinds)] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig(process.argv[2]);
  const { bundles, kinds } = assemble(cfg);
  console.log(`[assemble] vendored ${bundles.length} bundle(s): ${bundles.map((b) => b.name).join(", ") || "(none)"}`);
  console.log(`[assemble] job kinds -> ${kinds.join(",")}`);
}
