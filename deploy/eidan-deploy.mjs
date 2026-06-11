#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan deploy CLI — one command to assemble bundles, build the images, and ship to any target
// (local docker compose, a remote box over ssh, or Fly). Targets + bundles live in eidan.deploy.json.
import { execFileSync } from "node:child_process";

import { loadConfig, assemble, ROOT } from "./assemble.mjs";

function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
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
    } else {
      throw new Error(`unknown target type "${t.type}" for "${targetName}"`);
    }
    console.log(`\n✓ deployed to ${targetName}`);
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
  up | deploy <target>    assemble + ship to a target (compose / fly / compose-ssh)
  migrate <target>        apply the eidan.* schema to a target's database

Targets + bundles come from eidan.deploy.json (copy eidan.deploy.example.json).`);
}
