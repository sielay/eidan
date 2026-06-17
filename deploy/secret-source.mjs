// SPDX-License-Identifier: AGPL-3.0-or-later
// Pluggable SecretSource: WHERE Tier-1 values come from. The rest of the deploy tooling (schema,
// routing, doctor, env-plan, env-push) is source-agnostic — only this module knows how to FETCH
// values. Selected in eidan.deploy.json:
//
//   "secrets": { "source": "dotenv" }      default, zero-dependency — reads .env / apps/web/.env
//   "secrets": { "source": "sops" }         encrypted files via `sops -d` (age / KMS / Vault backends)
//   "secrets": { "source": "exec",          the UNIVERSAL adapter for any secret server —
//     "command": {                          give it a command per file that prints KEY=value or JSON:
//       "root": "doppler secrets download --no-file --format env",
//       "web":  "infisical export --env=prod --path=/web" } }
//
// `exec` covers Delinea, HashiCorp Vault, Doppler, Infisical, AWS/GCP Secret Manager, 1Password, etc.
// without a bespoke adapter each — the operator points it at their CLI. resolve(file) -> { KEY: value }.
// Values are returned to the caller (who must not log them); this module never prints them.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FILES = { root: ".env", web: "apps/web/.env" };

// Parse KEY=value lines OR a JSON object into a { key: value } map.
export function parseKv(text) {
  const t = (text ?? "").trim();
  if (t.startsWith("{")) {
    const obj = JSON.parse(t);
    const m = {};
    for (const [k, v] of Object.entries(obj)) m[k] = v == null ? "" : String(v);
    return m;
  }
  const map = {};
  for (const line of (text ?? "").split("\n")) {
    const mm = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (mm) map[mm[1]] = mm[2];
  }
  return map;
}

// Keys with a non-empty value (for presence/coverage checks). Never holds values past the filter.
export function presentOf(map) {
  return new Set(Object.entries(map).filter(([, v]) => String(v).trim() !== "").map(([k]) => k));
}

export function makeSource(config, root) {
  const cfg = config?.secrets ?? {};
  const kind = cfg.source ?? "dotenv";
  const pathFor = (file) => join(root, cfg.files?.[file] ?? FILES[file]);

  if (kind === "dotenv") {
    return { kind, resolve(file) { const p = pathFor(file); return existsSync(p) ? parseKv(readFileSync(p, "utf8")) : {}; } };
  }
  if (kind === "sops") {
    return {
      kind,
      resolve(file) {
        const p = join(root, cfg.files?.[file] ?? `${FILES[file]}.sops`);
        if (!existsSync(p)) return {};
        return parseKv(execFileSync("sops", ["-d", p], { encoding: "utf8", cwd: root }));
      },
    };
  }
  if (kind === "exec") {
    return {
      kind,
      resolve(file) {
        const cmd = cfg.command?.[file];
        if (!cmd) return {};
        return parseKv(execSync(cmd, { encoding: "utf8", cwd: root, stdio: ["ignore", "pipe", "inherit"] }));
      },
    };
  }
  throw new Error(`unknown secrets.source "${kind}" — use dotenv | sops | exec`);
}
