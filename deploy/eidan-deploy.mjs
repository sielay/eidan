#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan deploy CLI — one command to assemble bundles, build the images, and ship to any target
// (local docker compose, a remote box over ssh, or Fly). Targets + bundles live in eidan.deploy.json.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig, assemble, ROOT } from "./assemble.mjs";
import {
  parsePlugins, pluginDrift, renderNodeYaml, parseEnvKeys, envDrift,
} from "./node-config.mjs";
import * as secrets from "./secrets.mjs";

function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
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

// Push the rendered node matbot.yaml (assembled minus the node's `disable`), backing up the node's
// current one first so a bad sync is one `cp` to undo. Used by `deploy --sync-config`.
function syncNodeConfig(t, host, dir) {
  const rendered = renderNodeYaml(readAssembled(), t.disable ?? []);
  const tmp = join(mkdtempSync(join(tmpdir(), "eidan-nodeyaml-")), "matbot.yaml");
  writeFileSync(tmp, rendered);
  sh("ssh", [host, `cd ${dir} && cp -f matbot.yaml matbot.yaml.bak-predeploy 2>/dev/null || true`]);
  sh("scp", [tmp, `${host}:${dir}/matbot.yaml`]);
  console.log(`  synced rendered matbot.yaml -> ${host}:${dir}/matbot.yaml (backup: matbot.yaml.bak-predeploy)`);
}

const config = loadConfig();
const cmd = process.argv[2];
const targetName = process.argv[3];

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

switch (cmd) {
  case "assemble": {
    const { bundles, kinds } = assemble(config);
    console.log(`assembled ${bundles.length} bundle(s): ${bundles.map((b) => b.name).join(", ") || "(none)"} | kinds=${kinds.join(",")}`);
    break;
  }

  case "build": {
    assemble(config);
    buildImages(process.argv.includes("--arm") ? "linux/arm64" : undefined);
    break;
  }

  case "up":
  case "deploy": {
    const t = target(targetName);
    assemble(config); // vendor bundles + fold into the host config BEFORE any build
    if (t.type === "compose") {
      sh("docker", ["compose", "up", "-d", "--build"]);
    } else if (t.type === "fly") {
      // Fly builds remotely from the Dockerfile, which now carries the assembled matbot.yaml + bundles.
      sh("flyctl", ["deploy", "--app", t.app, "--config", t.config ?? "fly.toml", "--dockerfile", "infra/fly-mb/Dockerfile", "--yes"]);
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
      sh("rsync", [
        "-azR", "--stats", ...dry,
        "--exclude", "node_modules", "--exclude", ".git",
        "packages", "migrations", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
        `${host}:${dir}/`,
      ]);
      if (dry.length) {
        console.log("\n(dry-run) skipped pnpm install + service restart");
        break;
      }
      // Opt-in (default off): also render + push the node's matbot.yaml from the assembled config, so
      // the node's plugin list can't silently drift. Off by default preserves any node-local hand
      // tuning (e.g. kesha's ponytail matbot.yaml); the previous matbot.yaml is backed up first.
      if (process.argv.includes("--sync-config")) syncNodeConfig(t, host, dir);
      sh("ssh", [host, `cd ${dir} && pnpm install --prefer-offline && sudo systemctl restart ${service}`]);
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
    const t = target(targetName);
    const url = t.database_url ?? process.env.EIDAN_DATABASE_URL;
    if (!url) throw new Error(`migrate ${targetName}: set "database_url" on the target or EIDAN_DATABASE_URL`);
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
  secrets <sub>           encrypted-at-rest secrets (durably track the canonical set, no plaintext
                          in git): seal (.env -> .env.enc, commit the .enc) | open [--force]
                          (.env.enc -> .env) | status | selftest. Passphrase: .vault-pass / $EIDAN_VAULT_PASS.
  migrate <target>        apply the eidan.* schema to a target's database

Targets + bundles come from eidan.deploy.json (copy eidan.deploy.example.json).`);
}
