#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan deploy CLI — one command to assemble bundles, build the images, and ship to any target
// (local docker compose, a remote box over ssh, or Fly). Targets + bundles live in eidan.deploy.json.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig, assemble, ROOT } from "./assemble.mjs";
import {
  parsePlugins, pluginDrift, renderNodeYaml, parseEnvKeys, envDrift,
} from "./node-config.mjs";
import * as secrets from "./secrets.mjs";
import {
  resolveNodeEnv, missingValues, undeclaredKeys, presentKeysOf, parseEnvMap, renderEnv,
  renderExample, scaffoldEnv, validateFile, TARGETS, ENV_SCHEMA, specOf,
} from "./env-model.mjs";
import { makeSource, presentOf } from "./secret-source.mjs";
import { renderMatbotYaml, summarize, jobKindsFor, domainOf, corsOf, STARTER_MANIFEST, renderFlyToml, publicWebUrl, engineUrlFor, derivedEnv } from "./manifest.mjs";
import { crossTargetShared } from "./env-schema.mjs";

function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
}

// Preflight: the matbot runtime is a git submodule (external/matbot). A fresh clone leaves it empty,
// and the Docker build then dies with `ERR_PNPM_NO_PKG_MANIFEST`. Auto-init it so deploy stays
// hand-step-free. No-op once populated.
function ensureMatbot() {
  if (existsSync(join(ROOT, "external/matbot/package.json"))) return;
  if (!existsSync(join(ROOT, ".gitmodules"))) {
    console.error("external/matbot is empty and there's no .gitmodules — cannot init the matbot submodule.");
    process.exit(1);
  }
  console.log("external/matbot is empty — initialising the matbot submodule…");
  try { sh("git", ["submodule", "update", "--init", "--recursive", "external/matbot"]); }
  catch { console.error("Failed to init the submodule. Run: git submodule update --init --recursive"); process.exit(1); }
  if (!existsSync(join(ROOT, "external/matbot/package.json"))) {
    console.error("external/matbot still has no package.json after submodule update — check the submodule URL/commit.");
    process.exit(1);
  }
}

// Which env file a target reads its values from: root .env (engine types) or apps/web/.env (vercel).
// Resolved by the target's TYPE (targets may be named anything), falling back to the string as a type.
function fileRoleFor(name) {
  const type = config.targets?.[name]?.type ?? name;
  return TARGETS[type]?.file === "web" ? "web" : "root";
}
function envFileFor(name) {
  return join(ROOT, fileRoleFor(name) === "web" ? "apps/web/.env" : ".env");
}

// Capture a command's stdout (read-only ssh probes etc.). Throws on non-zero.
function cap(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", cwd: ROOT, ...opts });
}

// Read the assembled host config as-is (no side effects). The deploy path runs assemble() before
// this, so the file already carries core + bundles when --sync-config reads it.
function readAssembled() {
  return readFileSync(join(ROOT, "infra/fly-mb/matbot.yaml"), "utf8");
}

// The plugin set a node SHOULD load, computed read-only (no vendoring/network): the committed/base
// plugins in matbot.yaml UNION the configured bundle names, minus this node's role-disables. Robust
// whether or not the working tree is currently in assembled state.
function intendedPluginSet(t) {
  const base = parsePlugins(readAssembled());
  const bundles = (config.bundles ?? []).map((b) => b.name);
  const dis = new Set(t.disable ?? []);
  return [...new Set([...base, ...bundles])].filter((p) => !dis.has(p));
}

// Push the node's matbot.yaml, backing up the current one first so a bad sync is one `cp` to undo.
// Used by `deploy --sync-config`. Renders PER-NODE from the manifest (renderMatbotYaml) so the node's
// own providers (e.g. kesha's local ollama) are emitted — NOT the assembled fly config, whose provider
// set is fly's. Plugins are pluginsFor(target): core + bundles − this node's disables.
function syncNodeConfig(t, host, dir, targetName) {
  const rendered = renderMatbotYaml(config, targetName);
  const tmp = join(mkdtempSync(join(tmpdir(), "eidan-nodeyaml-")), "matbot.yaml");
  writeFileSync(tmp, rendered);
  sh("ssh", [host, `cd ${dir} && cp -f matbot.yaml matbot.yaml.bak-predeploy 2>/dev/null || true`]);
  sh("scp", [tmp, `${host}:${dir}/matbot.yaml`]);
  console.log(`  synced rendered matbot.yaml -> ${host}:${dir}/matbot.yaml (backup: matbot.yaml.bak-predeploy)`);
}

const config = loadConfig();
const cmd = process.argv[2];
const targetName = process.argv[3];

// The configured SecretSource (dotenv default | sops | exec). Tooling reads VALUES only through this.
const source = makeSource(config, ROOT);
const loadValues = (target) => source.resolve(fileRoleFor(target));

function target(name) {
  const t = config.targets?.[name];
  if (!t) {
    console.error(`unknown target "${name}". Known: ${Object.keys(config.targets ?? {}).join(", ") || "(none)"}`);
    process.exit(1);
  }
  return t;
}

function buildImages(platform) {
  const p = platform ? ["--platform", platform] : [];
  sh("docker", ["build", ...p, "-t", "eidan-engine:local", "-f", "infra/fly-mb/Dockerfile", "."]);
  sh("docker", ["build", ...p, "-t", "eidan-web:local", "apps/web"]);
}

function pushMultiArch(registry, platform) {
  sh("docker", ["buildx", "build", "--platform", platform, "-t", `${registry}/eidan-engine:latest`, "-f", "infra/fly-mb/Dockerfile", "--push", "."]);
  sh("docker", ["buildx", "build", "--platform", platform, "-t", `${registry}/eidan-web:latest`, "--push", "apps/web"]);
}

// Apply a rendered env to a target's remote store (no dry-run). Shared by `env-push` and the deploy
// preflight so they push identically. fly: `fly secrets import`. ssh-node: write env_files[0], blank
// the rest, restart. vercel: rm+add each key across the target environments. Never prints values.
function applyEnvPush(t, targetName, text) {
  const nKeys = Object.keys(parseEnvMap(text)).length;
  if (t.type === "fly") {
    execFileSync("flyctl", ["secrets", "import", "--app", t.app], { input: text, stdio: ["pipe", "inherit", "inherit"], cwd: ROOT });
    console.log(`✓ pushed ${nKeys} secrets to fly "${t.app}"`);
  } else if (t.type === "ssh-node") {
    const host = `${t.user}@${t.host}`;
    const files = t.env_files ?? [];
    if (!files.length) throw new Error("ssh-node env-push needs env_files in the target");
    const primary = files[0];
    const extras = files.slice(1);
    const svc = t.service ?? "eidan-mb.service";
    const tmp = join(mkdtempSync(join(tmpdir(), "eidan-env-")), "node.env");
    writeFileSync(tmp, text, { mode: 0o600 });
    sh("scp", ["-q", tmp, `${host}:/tmp/eidan-env.new`]);
    const blank = extras.map((f) => `sudo cp -f ${f} ${f}.bak-predeploy 2>/dev/null || true; printf '# collapsed into ${primary} by env-push\\n' | sudo tee ${f} >/dev/null`).join("; ");
    const remote = [
      `sudo cp -f ${primary} ${primary}.bak-predeploy 2>/dev/null || true`,
      `sudo install -m 600 -o root -g root /tmp/eidan-env.new ${primary}`,
      `rm -f /tmp/eidan-env.new`,
      blank,
      `sudo systemctl restart ${svc}`,
    ].filter(Boolean).join("; ");
    sh("ssh", [host, remote]);
    console.log(`✓ pushed ${nKeys} keys to ${host}:${primary} + restarted ${svc} (rollback: ${primary}.bak-predeploy)`);
  } else if (t.type === "vercel") {
    const cwd = join(ROOT, t.dir ?? "apps/web");
    const envs = t.vercel_envs ?? ["production"];
    const scope = t.scope ? ["--scope", t.scope] : [];
    const map = parseEnvMap(text);
    const keys = Object.keys(map);
    if (!existsSync(join(cwd, ".vercel", "project.json"))) {
      sh("vercel", ["link", "--yes", "--project", t.project, ...scope], { cwd });
    }
    for (const k of keys) {
      for (const env of envs) {
        // rm first (add fails if the key already exists for that environment); ignore "not found".
        try { execFileSync("vercel", ["env", "rm", k, env, "--yes", ...scope], { cwd, stdio: "ignore" }); } catch { /* absent */ }
        // Pipe the value with NO trailing newline — `vercel env add` stores stdin verbatim, so a
        // trailing "\n" would be baked into the value (a `\n`-suffixed DATABASE_URL / JWT secret
        // silently breaks the app). Strip any trailing CR/LF defensively; EOF submits the value.
        execFileSync("vercel", ["env", "add", k, env, ...scope], { input: String(map[k]).replace(/[\r\n]+$/, ""), stdio: ["pipe", "ignore", "inherit"], cwd });
      }
    }
    console.log(`✓ set ${keys.length} env var(s) on Vercel "${t.project}" (${envs.join(",")})`);
  } else {
    console.log(`env-push supports fly + ssh-node + vercel targets; "${targetName}" is "${t.type}".`);
  }
}

// Names of env vars already present on the remote (fly secrets / vercel env). Returns a Set, or null
// if it couldn't be determined (not linked / not logged in) — caller treats null as "must push".
function remoteEnvKeys(t) {
  const keyOf = (l) => (l.match(/^\s*([A-Z][A-Z0-9_]+)\b/) || [])[1];
  try {
    if (t.type === "fly") {
      const out = cap("flyctl", ["secrets", "list", "--app", t.app]);
      return new Set(out.split("\n").map(keyOf).filter((k) => k && k !== "NAME"));
    }
    if (t.type === "vercel") {
      const cwd = join(ROOT, t.dir ?? "apps/web");
      const scope = t.scope ? ["--scope", t.scope] : [];
      const envs = t.vercel_envs ?? ["production"];
      // A key counts as present only if it's set in EVERY target environment.
      let common = null;
      for (const env of envs) {
        const here = new Set(cap("vercel", ["env", "ls", env, ...scope], { cwd }).split("\n").map(keyOf).filter(Boolean));
        common = common ? new Set([...common].filter((k) => here.has(k))) : here;
      }
      return common ?? new Set();
    }
  } catch { return null; }
  return null;
}

// Deploy preflight: ensure the target's env is on the remote BEFORE we build/ship. Pushes ONLY the
// keys missing remotely (env persists server-side on fly + vercel, so we never rewrite existing
// secrets each deploy). Aborts if .env lacks a value the schema requires for this target.
function ensureEnvPushed(t, targetName) {
  if (t.type !== "fly" && t.type !== "vercel") return; // compose/ssh-node manage env their own way
  const { text, missing } = renderEnv(config, targetName, { ...loadValues(targetName), ...derivedEnv(config, targetName) });
  if (missing.length) {
    console.error(`✗ cannot deploy ${targetName}: ${missing.length} required env key(s) lack a value in .env: ${missing.join(", ")}`);
    console.error("  fill them (or run `init` / `env-plan`), then deploy again.");
    process.exit(1);
  }
  const want = Object.keys(parseEnvMap(text));
  const have = remoteEnvKeys(t);
  const where = t.type === "fly" ? `fly "${t.app}"` : `vercel "${t.project}"`;
  const absent = have ? want.filter((k) => !have.has(k)) : want; // null = couldn't verify → push all
  if (!absent.length) { console.log(`env: all ${want.length} key(s) already on ${where} — skipping push.`); return; }
  console.log(`env: ${absent.length}/${want.length} key(s) missing on ${where}${have ? "" : " (could not verify — pushing all)"} — pushing before deploy…`);
  applyEnvPush(t, targetName, text);
}

switch (cmd) {
  case "assemble": {
    ensureMatbot();
    const { bundles, kinds } = assemble(config);
    console.log(`assembled ${bundles.length} bundle(s): ${bundles.map((b) => b.name).join(", ") || "(none)"} | kinds=${kinds.join(",")}`);
    break;
  }

  case "build": {
    ensureMatbot();
    assemble(config);
    buildImages(process.argv.includes("--arm") ? "linux/arm64" : undefined);
    break;
  }

  case "up":
  case "deploy": {
    const t = target(targetName);
    ensureMatbot(); // matbot submodule must be populated before assemble/build (fresh clones are empty)
    assemble(config); // vendor bundles + fold into the host config BEFORE any build
    if (t.type === "compose") {
      sh("docker", ["compose", "up", "-d", "--build"]);
    } else if (t.type === "fly") {
      // Ensure we're logged in to Fly, and the app exists, before deploying.
      try { execFileSync("flyctl", ["auth", "whoami"], { stdio: "ignore" }); }
      catch { console.log("Not logged in to Fly — launching `fly auth login`…"); sh("flyctl", ["auth", "login"]); }
      try { execFileSync("flyctl", ["status", "--app", t.app], { stdio: "ignore" }); }
      catch {
        console.log(`Fly app "${t.app}" not found — creating it${t.org ? ` in org ${t.org}` : ""}…`);
        // Pass --org when the target pins one (non-interactive, reproducible); else flyctl prompts.
        sh("flyctl", ["apps", "create", t.app, ...(t.org ? ["--org", t.org] : [])]);
      }
      // Compile this target's artifacts FROM THE MANIFEST and deploy them: fly.toml + matbot.yaml are
      // generated each deploy (never stored/drifting). assemble() above vendored the bundle files;
      // here we write the manifest-driven matbot.yaml as the image's host config + a fresh fly.toml.
      const cdir = join(ROOT, ".eidan-runtime", targetName);
      mkdirSync(cdir, { recursive: true });
      const flyToml = renderFlyToml(t.app, t.region ?? "lhr");
      writeFileSync(join(cdir, "fly.toml"), flyToml); // review copy
      writeFileSync(join(ROOT, "infra/fly-mb/matbot.yaml"), renderMatbotYaml(config, targetName));
      // flyctl resolves the fly.toml's [build].dockerfile + build context relative to the fly.toml's
      // OWN location, so the deploy config must sit at ROOT (where infra/fly-mb/Dockerfile resolves).
      // ROOT/fly.toml is gitignored & generated each deploy — never drifts.
      const rootToml = join(ROOT, "fly.toml");
      writeFileSync(rootToml, flyToml);
      ensureEnvPushed(t, targetName); // secrets must be on the app before the release
      sh("flyctl", ["deploy", ROOT, "--app", t.app, "--config", rootToml, "--yes"]);
    } else if (t.type === "vercel") {
      // Web (Next.js) → Vercel. Deploy via the vercel CLI if present; else guide the operator.
      const hasVercel = (() => { try { execFileSync("vercel", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
      if (hasVercel) {
        // CLI deploys treat the cwd as the upload root + detect the framework locally — so deploy FROM the
        // app dir with the project's Root Directory left at root. (Root Directory is a git-integration
        // setting; for CLI deploys it would double the path.) The .vercel link lives in the app dir.
        const webDir = join(ROOT, t.dir ?? "apps/web");
        ensureEnvPushed(t, targetName); // env (incl. NEXT_PUBLIC_*) must exist BEFORE the build bakes it
        sh("vercel", ["deploy", "--prod", "--yes", ...(t.scope ? ["--scope", t.scope] : [])], { cwd: webDir });
      } else {
        console.log(`Vercel CLI not found — deploy the web (${t.project}) one of:`);
        console.log("  • dashboard: import the repo / push to the connected branch");
        console.log("  • CLI: npm i -g vercel && (cd apps/web && vercel link && vercel deploy --prod)");
        console.log(`  • env: set apps/web/.env values in Vercel — see \`eidan-deploy.mjs compile ${targetName}\``);
      }
    } else if (t.type === "compose-ssh") {
      if (!t.registry) throw new Error('compose-ssh target needs "registry"');
      pushMultiArch(t.registry, t.platform ?? "linux/arm64");
      sh("scp", ["docker-compose.yml", `${t.user}@${t.host}:${t.dir ?? "eidan"}/docker-compose.yml`]);
      sh("ssh", [`${t.user}@${t.host}`, `cd ${t.dir ?? "eidan"} && EIDAN_ENGINE_IMAGE=${t.registry}/eidan-engine:latest EIDAN_WEB_IMAGE=${t.registry}/eidan-web:latest docker compose pull && docker compose up -d`]);
    } else if (t.type === "ssh-node") {
      // A node-process deploy over ssh (e.g. a Pi running the engine under systemd, not Docker):
      // rsync the assembled engine runtime, install deps, restart the service. We NEVER sync the
      // node's own matbot.yaml or .env (or node_modules/.git) — the node keeps its config and decides
      // which plugins load. Pass --dry-run to preview the file transfer without installing/restarting.
      const host = `${t.user}@${t.host}`;
      const dir = t.dir ?? "eidan-mb";
      const service = t.service ?? "eidan-mb.service";
      const dry = process.argv.includes("--dry-run") ? ["--dry-run"] : [];
      // -R keeps each source's relative path under <dir>/. No --delete: never remove node-local files.
      // external/matbot (the vendored runtime submodule) MUST ship too — a node runs the engine from
      // these files, so a matbot bump only reaches the node if its source is synced. Omitting it lets
      // the node silently run a stale runtime (strip-only TS hides the drift until a real runtime
      // import from a new matbot module fails to resolve at boot).
      sh("rsync", [
        "-azR", "--stats", ...dry,
        "--exclude", "node_modules", "--exclude", ".git",
        "packages", "external/matbot", "migrations", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
        `${host}:${dir}/`,
      ]);
      if (dry.length) {
        console.log("\n(dry-run) skipped pnpm install + service restart");
        break;
      }
      // Opt-in (default off): also render + push the node's matbot.yaml from the assembled config, so
      // the node's plugin list can't silently drift. Off by default preserves any node-local hand
      // tuning (e.g. kesha's ponytail matbot.yaml); the previous matbot.yaml is backed up first.
      if (process.argv.includes("--sync-config")) syncNodeConfig(t, host, dir, targetName);
      // Install BOTH workspaces: the eidan root, then the vendored matbot runtime (its own pnpm
      // workspace, not an eidan workspace member — so the root install never links its packages).
      // A matbot bump can add packages (e.g. storage-base) the node's old node_modules lack.
      sh("ssh", [host, `cd ${dir} && pnpm install --prefer-offline && (cd external/matbot && pnpm install --prefer-offline) && sudo systemctl restart ${service}`]);
    } else {
      throw new Error(`unknown target type "${t.type}" for "${targetName}"`);
    }
    console.log(`\n✓ deployed to ${targetName}`);
    break;
  }

  case "check": {
    // Read-only drift detector: does the node actually load what the assembled config intends?
    // Catches the silent-drift failure (a bundle rsynced but never added to the node's matbot.yaml).
    const t = target(targetName);
    if (t.type !== "ssh-node") {
      console.log(`drift-check targets ssh-node nodes; "${targetName}" is "${t.type}".`);
      if (t.type === "fly") {
        console.log("Fly bakes the assembled matbot.yaml into the image, so its plugin set == the last");
        console.log("assembled+deployed build by construction. Re-run `deploy fly` after any bundle change.");
      }
      break;
    }
    const intended = intendedPluginSet(t);
    const host = `${t.user}@${t.host}`;
    const dir = t.dir ?? "eidan-mb";
    let nodeYaml;
    try {
      nodeYaml = cap("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, `cat ${dir}/matbot.yaml`]);
    } catch (e) {
      console.error(`✗ cannot read ${host}:${dir}/matbot.yaml — node down or ssh failed (${e.message.split("\n")[0]})`);
      process.exit(2);
    }
    const { missing, extra } = pluginDrift(intended, parsePlugins(nodeYaml));
    console.log(`plugins: intended ${intended.length}, node loads ${parsePlugins(nodeYaml).length}`);
    if (missing.length) console.log(`  ✗ MISSING on node (assembled but not loaded): ${missing.join(", ")}`);
    if (extra.length) console.log(`  ⚠ EXTRA on node (loaded but not in assembled∖disable): ${extra.join(", ")}`);
    if (!missing.length && !extra.length) console.log("  ✓ no plugin drift");

    // Env-key drift is opt-in: only when the target declares `env_files` (paths the deploy user can
    // read). Names only — never values. Combine with `env_keys` (the keys the node must have).
    let envMissing = [];
    if (Array.isArray(t.env_files) && Array.isArray(t.env_keys)) {
      try {
        const envText = cap("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host,
          `cat ${t.env_files.join(" ")} 2>/dev/null`]);
        envMissing = envDrift(t.env_keys, parseEnvKeys(envText)).missing;
        console.log(`env: ${t.env_keys.length} declared keys, ${envMissing.length} missing`);
        if (envMissing.length) console.log(`  ✗ MISSING env keys: ${envMissing.join(", ")}`);
        else console.log("  ✓ all declared env keys present");
      } catch (e) {
        console.log(`  (env-key check skipped: ${e.message.split("\n")[0]})`);
      }
    }
    process.exit(missing.length || extra.length || envMissing.length ? 1 : 0);
  }

  case "env-plan": {
    // Read-only: show the env-key set the topology assigns this node (shared + node + overrides),
    // which keys still have no value in .env, and (for ssh-node) which keys the node has that the
    // topology doesn't declare. Values are never read or printed — only key names + a present bit.
    const t = target(targetName);
    const rel = source.kind === "dotenv" ? envFileFor(targetName).replace(ROOT + "/", "") : `source:${source.kind}`;
    const present = presentOf(loadValues(targetName));
    const resolved = resolveNodeEnv(config, targetName, present);
    const schemaKeys = Object.entries(resolved).filter(([, v]) => v.source === "schema").map(([k]) => k);
    const overrides = Object.entries(resolved).filter(([, v]) => v.source === "override").map(([k]) => k);
    console.log(`env plan for "${targetName}" (${Object.keys(resolved).length} keys, file ${rel}):`);
    console.log(`  from schema (${schemaKeys.length}): ${schemaKeys.join(", ") || "(none)"}`);
    console.log(`  overrides   (${overrides.length}): ${overrides.join(", ") || "(none)"}`);
    const miss = missingValues(resolved);
    if (miss.length) console.log(`  ✗ declared but NO value in ${rel}: ${miss.join(", ")}`);
    else console.log(`  ✓ every declared key has a value in ${rel}`);
    // Optional: compare to the node's actual env (ssh-node only) to surface undeclared drift.
    if (t.type === "ssh-node" && Array.isArray(t.env_files)) {
      try {
        const host = `${t.user}@${t.host}`;
        const txt = cap("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host,
          `sudo cat ${t.env_files.join(" ")} 2>/dev/null`]);
        const undeclared = undeclaredKeys(resolved, parseEnvKeys(txt));
        console.log(undeclared.length
          ? `  ⚠ on node but NOT in topology: ${undeclared.join(", ")}`
          : "  ✓ node has no env keys missing from the topology");
      } catch (e) {
        console.log(`  (node env compare skipped: ${e.message.split("\n")[0]})`);
      }
    }
    break;
  }

  case "env-pull": {
    // Consolidate an ssh-node's live env VALUES into the local .env (the single source for option A),
    // adding only keys .env is missing. Never overwrites an existing .env value; reports name-level
    // conflicts to reconcile by hand. Values are moved in memory only — never printed.
    const t = target(targetName);
    if (t.type !== "ssh-node" || !Array.isArray(t.env_files)) {
      console.log(`env-pull needs an ssh-node target with env_files; "${targetName}" doesn't qualify.`);
      break;
    }
    const envPath = join(ROOT, ".env");
    const localText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const local = parseEnvMap(localText);
    const host = `${t.user}@${t.host}`;
    const nodeText = cap("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host,
      `sudo cat ${t.env_files.join(" ")} 2>/dev/null`]);
    const node = parseEnvMap(nodeText);
    const added = [], conflict = [];
    const append = [];
    for (const [k, v] of Object.entries(node)) {
      if (v === "") continue;
      if (!(k in local) || local[k] === "") { append.push(`${k}=${v}`); added.push(k); }
      else if (local[k] !== v) conflict.push(k);
    }
    if (append.length) {
      const sep = localText && !localText.endsWith("\n") ? "\n" : "";
      writeFileSync(envPath, localText + sep + `# pulled from ${targetName} ${t.host}\n` + append.join("\n") + "\n");
    }
    console.log(`env-pull ${targetName}: added ${added.length} key(s) to .env${added.length ? ": " + added.sort().join(", ") : ""}`);
    if (conflict.length) console.log(`  ⚠ ${conflict.length} key(s) differ between .env and the node (left .env as-is): ${conflict.sort().join(", ")}`);
    console.log("  values were not printed. Re-seal with `secrets seal` once .env is complete.");
    break;
  }

  case "env-render": {
    // Read-only: render the node's would-be env file from the topology + .env values to a gitignored
    // file for review (NOT pushed). Shows exactly what `env-push` would write.
    target(targetName);
    const { text, missing } = renderEnv(config, targetName, loadValues(targetName));
    const outDir = join(ROOT, ".eidan-runtime");
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const out = join(outDir, `${targetName}.env`);
    writeFileSync(out, text, { mode: 0o600 });
    const keyCount = text.split("\n").filter((l) => /=/.test(l)).length;
    console.log(`env-render ${targetName}: wrote ${keyCount} key(s) -> .eidan-runtime/${targetName}.env (gitignored, 0600)`);
    if (missing.length) console.log(`  ✗ ${missing.length} declared key(s) had no value in .env (omitted): ${missing.join(", ")}`);
    else console.log("  ✓ every declared key resolved to a value");
    break;
  }

  case "env-push": {
    // Apply .env -> a node, via the topology routing. fly: `fly secrets import` (one restart). ssh-node:
    // render the full node env to env_files[0] (root-owned, atomic), blank the rest so the node has ONE
    // env file, restart. Dry-run unless --yes. Refuses if any declared key lacks a value. Never prints values.
    const t = target(targetName);
    const { text, missing } = renderEnv(config, targetName, { ...loadValues(targetName), ...derivedEnv(config, targetName) });
    const nKeys = Object.keys(parseEnvMap(text)).length;
    if (missing.length) {
      console.error(`✗ refusing to push ${targetName}: ${missing.length} declared key(s) lack a value in .env: ${missing.join(", ")}`);
      process.exit(1);
    }
    if (!process.argv.includes("--yes")) {
      const where = t.type === "fly" ? `fly "${t.app}"` : t.type === "ssh-node" ? `${t.user}@${t.host}:${(t.env_files ?? ["?"])[0]}` : t.type === "vercel" ? `Vercel "${t.project}" (${(t.vercel_envs ?? ["production"]).join(",")})` : `"${t.type}"`;
      console.log(`[dry-run] would push ${nKeys} key(s) to ${where}. Re-run with --yes.`);
      break;
    }
    applyEnvPush(t, targetName, text);
    if (t.type === "vercel") console.log(`  now \`deploy ${targetName}\` so the build picks them up.`);
    break;
  }

  case "compile": {
    // Render a target's native artifacts FROM THE MANIFEST: matbot.yaml (plugins + providers) + env
    // (job-kinds/domain/cors derived from the manifest, merged over the source values). Read-only ->
    // .eidan-runtime/<target>/ for review; env-push/deploy consume the same render.
    const tc = target(targetName);
    const sum = summarize(config, targetName);
    const dir = join(ROOT, ".eidan-runtime", targetName);
    rmSync(dir, { recursive: true, force: true });   // clean rebuild (no stale artifacts)
    mkdirSync(dir, { recursive: true });
    // matbot.yaml only for engine targets (fly/ssh-node). Vercel runs the Next app, not the engine.
    const isEngine = tc.type === "fly" || tc.type === "ssh-node";
    if (isEngine) writeFileSync(join(dir, "matbot.yaml"), renderMatbotYaml(config, targetName));
    // fly.toml is COMPILED here from the manifest (app/region/domain) — never a stored, drifting file.
    if (tc.type === "fly") writeFileSync(join(dir, "fly.toml"), renderFlyToml(tc.app, tc.region ?? "lhr"));
    const { text, missing } = renderEnv(config, targetName, { ...loadValues(targetName), ...derivedEnv(config, targetName) });
    writeFileSync(join(dir, "env"), text, { mode: 0o600 });
    const artifacts = ["env", ...(isEngine ? ["matbot.yaml"] : []), ...(tc.type === "fly" ? ["fly.toml"] : [])].sort();
    console.log(`compiled "${targetName}" -> .eidan-runtime/${targetName}/ (${artifacts.join(" + ")})`);
    if (isEngine) console.log(`  plugins (${sum.plugins.length}): ${sum.plugins.join(", ")}`);
    console.log(`  providers: ${sum.providers.join(", ") || "(none)"} | models: ${Array.isArray(sum.models) ? sum.models.join(",") : sum.models} | jobs: ${sum.jobs.join(",")}`);
    console.log(`  domain: ${sum.domain ?? "(none)"} | cors: ${sum.cors.join(",") || "(none)"}`);
    if (missing.length) console.log(`  ⚠ env still missing values: ${missing.join(", ")}`);
    break;
  }

  case "env-example": {
    // Regenerate the tracked .env.example (engine) + apps/web/.env.example (web) from env-schema.mjs.
    writeFileSync(join(ROOT, ".env.example"), renderExample("root"));
    writeFileSync(join(ROOT, "apps/web/.env.example"), renderExample("web"));
    console.log("✓ regenerated .env.example (engine) + apps/web/.env.example (web) from deploy/env-schema.mjs");
    break;
  }

  case "init": {
    // Scaffold .env (engine) and apps/web/.env (web) from the schema: auto-generate secrets, apply
    // defaults, leave ‹FILL› markers on the externals you must paste. Never clobbers existing values.
    const force = process.argv.includes("--force");
    // Brand-new project: create the manifest so the wizard has something to add targets/bundles to.
    const mf = join(ROOT, "eidan.deploy.json");
    if (!existsSync(mf)) {
      writeFileSync(mf, JSON.stringify(STARTER_MANIFEST, null, 2) + "\n");
      console.log("✓ wrote eidan.deploy.json (empty manifest — add targets + bundles via the wizard)");
    }
    const shared = crossTargetShared();   // auth trio — must be IDENTICAL across engine + web
    let rootVals = {};
    for (const [file, rel] of [["root", ".env"], ["web", "apps/web/.env"]]) {
      const p = join(ROOT, rel);
      const existing = existsSync(p) ? parseEnvMap(readFileSync(p, "utf8")) : {};
      // The web file inherits the engine's generated shared secrets, so KEK/JWT/email match.
      if (file === "web") for (const k of shared) if (rootVals[k]) existing[k] = rootVals[k];
      if (existsSync(p) && !force) {
        console.log(`• ${rel} exists — skipping (use --force to regenerate, merging existing values)`);
        if (file === "root") rootVals = existing; // capture so web inherits the SAME auth trio even when root isn't rewritten
        continue;
      }
      const { text, generated } = scaffoldEnv(file, existing);
      writeFileSync(p, text, { mode: 0o600 });
      if (file === "root") rootVals = parseEnvMap(text);
      console.log(`✓ wrote ${rel}  (auto-generated ${generated.length} secret(s): ${generated.join(", ") || "none"})`);
    }
    console.log("Next: fill the ‹FILL› markers, then `env-plan <target>` / `doctor`, then `env-push`.");
    break;
  }

  case "doctor": {
    // Validate the file-tier config against the schema: required present, no leftover ‹FILL›
    // placeholders, and the cross-target keys (auth trio) MATCH between .env and apps/web/.env.
    // Names only, never values. Exit 0 = healthy, 1 = problems.
    let problems = 0;
    console.log(`(secret source: ${source.kind})`);
    const root = source.resolve("root"), web = source.resolve("web");
    for (const [file, rel, vals] of [["root", source.kind === "dotenv" ? ".env" : "root", root], ["web", source.kind === "dotenv" ? "apps/web/.env" : "web", web]]) {
      console.log(`• ${rel}:`);
      if (!vals || Object.keys(vals).length === 0) { console.log("  ✗ no values from source — run `init` (dotenv) or check your source config"); problems++; continue; }
      const { missingRequired, placeholders } = validateFile(file, vals);
      if (missingRequired.length) { console.log(`  ✗ missing required: ${missingRequired.join(", ")}`); problems++; }
      if (placeholders.length) { console.log(`  ✗ unfilled placeholders: ${placeholders.join(", ")}`); problems++; }
      if (!missingRequired.length && !placeholders.length) console.log("  ✓ all required present, no placeholders");
    }
    // Cross-target consistency (auth trio must be byte-identical on engine + web).
    if (root && web) {
      const trio = ["EIDAN_AUTH_JWT_SECRET", "EIDAN_AUTH_MASTER_KEY", "EIDAN_AUTH_ALLOWED_EMAIL"];
      const mismatched = trio.filter((k) => root[k] !== undefined && web[k] !== undefined && root[k] !== web[k]);
      console.log("• cross-target (engine vs web):");
      if (mismatched.length) { console.log(`  ✗ values DIFFER (must match): ${mismatched.join(", ")}`); problems++; }
      else console.log("  ✓ shared auth keys match");
    }
    console.log(problems ? `\n${problems} problem(s). Fix, then re-run doctor.` : "\n✓ file-tier config healthy.");
    process.exit(problems ? 1 : 0);
  }

  case "secrets": {
    // Encrypted-at-rest secrets: durably track the canonical secret set without plaintext in git.
    const sub = process.argv[3];
    if (sub === "seal") secrets.seal();
    else if (sub === "open") secrets.open(process.argv.includes("--force"));
    else if (sub === "status") secrets.status();
    else if (sub === "selftest") secrets.selftest();
    else console.log("usage: secrets <seal | open [--force] | status | selftest>");
    break;
  }

  case "migrate": {
    // The DB is shared across ALL targets — migrate is NOT per-target. Default to .env's DATABASE_URL
    // (a target's database_url / EIDAN_DATABASE_URL still win if given).
    const t = targetName ? config.targets?.[targetName] : null;
    const fromEnv = (() => { try { return parseEnvMap(readFileSync(join(ROOT, ".env"), "utf8")).DATABASE_URL; } catch { return null; } })();
    const url = t?.database_url ?? process.env.EIDAN_DATABASE_URL ?? fromEnv;
    if (!url) throw new Error("migrate: no DATABASE_URL found (run `init`, or set EIDAN_DATABASE_URL)");
    sh("node", ["migrations/migrate.mjs"], { env: { ...process.env, EIDAN_DATABASE_URL: url } });
    break;
  }

  default:
    console.log(`eidan-deploy — assemble bundles + build + deploy to any target

  assemble                vendor the configured bundles + fold them into the host config
  build [--arm]           assemble + build the engine + web images locally
  up | deploy <target>    assemble + ship to a target (compose / fly / compose-ssh / ssh-node)
                          ssh-node: rsync the runtime to a node-process host + restart its service
                          (--dry-run previews the file transfer; --sync-config also renders + pushes
                           the node's matbot.yaml from the assembled config, backing up the old one)
  check <target>          read-only drift check for an ssh-node: does the node load the plugins the
                          assembled config intends (minus its 'disable')? Reports missing/extra
                          plugins (+ missing env keys when the target declares env_files/env_keys).
                          Exit 0 = clean, 1 = drift, 2 = node unreachable.
  init [--force]          scaffold .env (engine) + apps/web/.env (web) from deploy/env-schema.mjs:
                          auto-generate secrets, apply defaults, leave ‹FILL› markers for externals.
  doctor                  validate the file-tier config vs the schema: required present, no leftover
                          placeholders, auth keys match across engine + web. Exit 0 healthy / 1 not.
  compile <target>        render a target's native artifacts FROM THE MANIFEST (matbot.yaml plugins+
                          providers + env with job-kinds/domain/cors) -> .eidan-runtime/<target>/.
  env-example             regenerate .env.example + apps/web/.env.example from the schema.
  env-plan <target>       read-only: the env-key set the schema routes to this target (from schema +
                          topology overrides), and which declared keys still lack a value in its file
                          (.env or apps/web/.env). For ssh-node, also flags undeclared keys on the node.
  env-pull <ssh-node>     consolidate a node's live env values into .env (adds only missing keys,
                          flags conflicts; values never printed). Then run secrets seal.
  env-render <target>     render the node's would-be env file from topology + .env to a gitignored
                          .eidan-runtime/<target>.env for review (NOT pushed).
  env-push <target>       apply .env -> the node via topology routing. fly: fly secrets import.
                          ssh-node: write all keys to env_files[0] (root, atomic) + blank the rest +
                          restart. Dry-run unless --yes. Refuses if a declared key has no value.
  secrets <sub>           encrypted-at-rest secrets (durably track the canonical set, no plaintext
                          in git): seal (.env -> .env.enc, commit the .enc) | open [--force]
                          (.env.enc -> .env) | status | selftest. Passphrase: .vault-pass / $EIDAN_VAULT_PASS.
  migrate <target>        apply the eidan.* schema to a target's database

Targets + bundles come from eidan.deploy.json (copy eidan.deploy.example.json).`);
}
