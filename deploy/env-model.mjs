// SPDX-License-Identifier: AGPL-3.0-or-later
// Resolve / render / validate / scaffold Tier-1 env from the single source of truth (env-schema.mjs).
// A target's key set is DERIVED from the schema (keysForTarget) — eidan.deploy.json only declares the
// nodes + their non-secret literal overrides (env_set). Values live in .env (root) / apps/web/.env
// (web); this module never logs a value.
import { randomBytes } from "node:crypto";
import { keysForTarget, requiredForTarget, specOf, ENV_SCHEMA, TARGETS } from "./env-schema.mjs";

// key -> { source: 'schema'|'override', present } for a target (schema keys + topology env_set literals).
export function resolveNodeEnv(config, target, presentKeys = new Set()) {
  const type = config?.targets?.[target]?.type ?? target; // resolve roles by TYPE, not name
  const overrides = config?.targets?.[target]?.env_set ?? {};
  const out = {};
  for (const e of keysForTarget(type, target)) {
    out[e.key] = e.key in overrides ? { source: "override", present: true }
      : e.derived ? { source: "derived", present: true }   // compiler fills these from the manifest — not from .env
      : { source: "schema", present: presentKeys.has(e.key) };
  }
  for (const k of Object.keys(overrides)) if (!(k in out)) out[k] = { source: "override", present: true };
  return out;
}

// Declared-but-valueless REQUIRED keys (optional keys without a value are fine — just omitted).
export function missingValues(resolved) {
  return Object.entries(resolved).filter(([k, v]) => v.source !== "override" && !v.present && specOf(k)?.required).map(([k]) => k).sort();
}

// Keys present on the node but not in the schema/topology for this target -> undeclared drift.
export function undeclaredKeys(resolved, actualKeys = []) {
  return [...new Set(actualKeys)].filter((k) => !(k in resolved)).sort();
}

// Render a target's env-file content: schema keys' values from `values`, then env_set literals (win).
// Returns { text, missing }. Caller must not log `text`.
export function renderEnv(config, target, values = {}) {
  const present = presentKeysOf(Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n"));
  const resolved = resolveNodeEnv(config, target, present);
  const overrides = config?.targets?.[target]?.env_set ?? {};
  const lines = [];
  const missing = [];
  for (const k of Object.keys(resolved).sort()) {
    if (k in overrides) lines.push(`${k}=${overrides[k]}`);
    else if (present.has(k)) lines.push(`${k}=${values[k]}`);
    else if (specOf(k)?.required) missing.push(k); // optional keys without a value are just omitted
  }
  return { text: lines.length ? lines.join("\n") + "\n" : "", missing };
}

// Generate a secret value per the schema's `generate` hint ('hex:N' | 'base64:N').
export function genSecret(spec) {
  if (!spec) return null;
  const [enc, nStr] = spec.split(":");
  const n = Number(nStr) || 32;
  const buf = randomBytes(n);
  return enc === "base64" ? buf.toString("base64url") : buf.toString("hex");
}

// Build a complete, annotated .env.example body for one file ('root' = fly/kesha, 'web' = vercel).
// Keys are taken from the schema by file. Pure (no I/O, no real values).
export function renderExample(file) {
  const targetsForFile = Object.entries(TARGETS).filter(([, t]) => t.file === file).map(([n]) => n);
  const inFile = (e) => !e.derived && targetsForFile.some((t) => keysForTarget(t).some((k) => k.key === e.key));
  const keys = ENV_SCHEMA.filter(inFile);
  const head = file === "web"
    ? ["# apps/web/.env — the Next.js front door (Vercel). Copy to apps/web/.env; set the same in Vercel.",
       "# Browser sees NEXT_PUBLIC_* only — never put secrets there. Generated from deploy/env-schema.mjs."]
    : ["# eidan engine .env (fly + kesha). Copy to .env, fill in, then: node deploy/eidan-deploy.mjs secrets seal",
       "# WHICH key -> WHICH node is in eidan.deploy.json (target roles). Generated from deploy/env-schema.mjs.",
       "# Scaffold with generated secrets:  node deploy/eidan-deploy.mjs init"];
  const lines = [...head,
    "# Legend: [req]/[opt]  [secret]  (gen: …) = init auto-fills.  See deploy/README.md for the full model.",
    "# ============================================================================================="];
  for (const e of keys) {
    const tags = [e.required ? "[req]" : "[opt]", e.secret ? "[secret]" : "", e.generate ? `(gen: ${e.generate})` : ""].filter(Boolean).join(" ");
    lines.push(`# ${tags}  ${e.desc}`);
    lines.push(`${e.key}=${e.default ?? ""}`);
  }
  return lines.join("\n") + "\n";
}

// Scaffold a fresh .env body for a file: generated secrets filled, defaults applied, true externals
// left as ‹FILL: desc›. Preserves any values already present in `existing`.
export function scaffoldEnv(file, existing = {}) {
  const targetsForFile = Object.entries(TARGETS).filter(([, t]) => t.file === file).map(([n]) => n);
  const inFile = (e) => !e.derived && targetsForFile.some((t) => keysForTarget(t).some((k) => k.key === e.key));
  const lines = [`# eidan ${file === "web" ? "apps/web" : "engine"} .env — scaffolded by \`eidan-deploy init\`. Fill the ‹FILL› markers.`];
  const generated = [];
  for (const e of ENV_SCHEMA.filter(inFile)) {
    let v = existing[e.key];
    if (v === undefined || v === "") {
      if (e.generate) { v = genSecret(e.generate); generated.push(e.key); }
      else if (e.default !== undefined) v = e.default;
      else if (e.required) v = `‹FILL: ${e.desc}›`;
      else v = "";
    }
    lines.push(`${e.key}=${v}`);
  }
  return { text: lines.join("\n") + "\n", generated };
}

// Validate a file's parsed values against the schema for the targets that read it.
// Returns { missingRequired, placeholders } — names only.
export function validateFile(file, values = {}) {
  const targetsForFile = Object.entries(TARGETS).filter(([, t]) => t.file === file).map(([n]) => n);
  const reqd = new Set(targetsForFile.flatMap((t) => requiredForTarget(t)));
  const present = presentKeysOf(Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n"));
  const missingRequired = [...reqd].filter((k) => !present.has(k)).sort();
  // Placeholder = the scaffold's ‹FILL: …› marker, or an unfilled <angle-bracket> token. The bracket
  // form excludes anything containing "@" so a real email mailbox (e.g. `Acme <no-reply@example.com>`)
  // isn't mistaken for an unfilled value.
  const placeholders = Object.entries(values).filter(([, v]) => /‹FILL|<(?![^>]*@)[^>]*>/.test(v)).map(([k]) => k).sort();
  return { missingRequired, placeholders };
}

// --- parsing helpers ---------------------------------------------------------------------------
export function presentKeysOf(envText) {
  const present = new Set();
  for (const line of envText.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m && m[2].trim() !== "") present.add(m[1]);
  }
  return present;
}

export function parseEnvMap(envText) {
  const map = {};
  for (const line of envText.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

export { specOf, ENV_SCHEMA, TARGETS };
