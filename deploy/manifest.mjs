// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

// The deployment manifest model: per-target CAPABILITIES — which plugins, providers, models, job
// kinds, domain and CORS each target runs. Layered on eidan.deploy.json (the wizard reads/writes it;
// hand-editing optional). The compiler renders each target's matbot.yaml + env from this; values come
// from the SecretSource, so this module deals in STRUCTURE only (never a secret value).
//
//   targets.<name>.plugins   : ["ventures","sage", …] | "*"   (which bundle plugins; core is always on)
//   targets.<name>.providers : ["claude","ollama"]    | "*"   (from the providers catalogue)
//   targets.<name>.models    : ["claude-…"]            | "*"   (allowlist; "*" = any the providers offer)
//   targets.<name>.jobs      : ["chat","code","clone"]         (job kinds this node serves)
//   targets.<name>.domain    : "e.sielay.com" | null
//   targets.<name>.cors      : ["https://e.sielay.com"]

// Core plugins are ALWAYS loaded, in dependency order (storage first; vault early so ${…} resolves
// from the DB vault for later plugins).
export const CORE_PLUGINS = [
  "storage-postgres", "vault-postgres", "llm-calls", "telemetry", "tool-guard", "tool-failure-handler", "transcribe", "memory", "tool-store", "decisions", "journal", "content", "auth", "notify", "jobs",
  "frontend-agui", "mcp-server", "a2a-server", "secrets-api", "procedures", "escalations", "agents", "frontend-telegram",
  // integrations: read-through mail / calendar / drive / gmail over the operator's vault-sealed
  // accounts, each with its own admin screen.
  "imap", "ical", "google", "gdrive",
  // reddit-research: market trends and pain points across ventures
  "reddit-research",
  // matbot engine tool plugins (vendored submodule) enabled by default — general, dependency-free
  // capabilities: a file scratchpad, web requests, human-in-the-loop prompts, detached sub-turns.
  "workspace", "http", "ask-user", "ask-user-fallback", "background",
  // knowledge cluster (matbot): skills + cognition + rumsfeld. They read/write eidan.knowledge via
  // the KnowledgeIndex adapter @eidandev/memory registers (one unified store). skills runs a per-turn
  // trigger/analysis classifier on the `skills-classifier` provider (defined in eidan.deploy.json).
  "skills", "cognition", "rumsfeld",
];

// A few core plugins are matbot built-ins loaded from the vendored submodule rather than eidan
// packages/. Map their names to the submodule path; everything else resolves to ./packages/<name>.
export const MATBOT_PLUGIN_PATHS = {
  "tool-store": "./external/matbot/packages/plugins/tool-store",
  "workspace": "./external/matbot/packages/plugins/workspace",
  "http": "./external/matbot/packages/plugins/http",
  "ask-user": "./external/matbot/packages/plugins/ask-user",
  "background": "./external/matbot/packages/plugins/background",
  "skills": "./external/matbot/packages/plugins/skills",
  "cognition": "./external/matbot/packages/plugins/cognition",
  "rumsfeld": "./external/matbot/packages/plugins/rumsfeld",
};
export function moduleForPlugin(name) {
  return MATBOT_PLUGIN_PATHS[name] ?? `./packages/${name}`;
}

// Default provider catalogue (eidan.deploy.json `providers` overrides/extends per key). `key` is the
// env var holding the API key (resolved on the node); null = no key (e.g. local ollama).
export const DEFAULT_PROVIDERS = {
  claude:     { module: "./external/matbot/packages/plugins/providers/anthropic",     endpoint: "https://api.anthropic.com", model: "claude-sonnet-4-6", key: "ANTHROPIC_API_KEY", parameters: { maxTokens: 16384 } },
  // openai-compat posts to config.endpoint VERBATIM (its DEFAULT_ENDPOINT is a full
  // …/chat/completions URL), so every endpoint here must be the full completions path, not the
  // API base — a base URL silently 200s with the provider's HTML homepage, yielding an empty
  // stream and a turn that finishes with zero iterations (no error). Only `claude` (anthropic
  // adapter) appends its own path, so it stays a base URL.
  openai:     { module: "./external/matbot/packages/plugins/providers/openai-compat", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o", key: "OPENAI_API_KEY" },
  // promptCaching: OpenRouter needs explicit cache_control breakpoints to cache Anthropic models
  // (unlike OpenAI/DeepSeek, which cache automatically); without it every call re-bills the full
  // prompt. The openai-compat adapter only emits the breakpoints when this is set.
  openrouter: { module: "./external/matbot/packages/plugins/providers/openai-compat", endpoint: "https://openrouter.ai/api/v1/chat/completions", model: "anthropic/claude-sonnet-4.6", key: "OPENROUTER_API_KEY", parameters: { promptCaching: true, maxTokens: 16384 } },
  grok:       { module: "./external/matbot/packages/plugins/providers/openai-compat", endpoint: "https://api.x.ai/v1/chat/completions", model: "grok-2", key: "XAI_API_KEY" },
  ollama:     { module: "./external/matbot/packages/plugins/providers/openai-compat", endpoint: "http://localhost:11434/v1/chat/completions", model: "llama3", key: null },
};

// named bundles (drop "//" comment entries). assemble additionally requires a source (path|git).
export const bundleNames = (config) => (config.bundles ?? []).filter((b) => b && b.name && !String(b.name).startsWith("//")).map((b) => b.name);

// Plugins physically present in the current checkout = packages/<name> dirs with a package.json
// (core + any vendored bundles). The wizard lists these for "which run here".
export function installedPlugins(root) {
  const dir = join(root, "packages");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => { try { return statSync(join(dir, n)).isDirectory() && existsSync(join(dir, n, "package.json")); } catch { return false; } });
}

// The operator's catalogue of available bundles to pick from (gitignored eidan.deploy.json
// `catalogue`, so private repo names never reach tracked/public code). { name: {git|path, subdir, kind, desc} }.
export const catalogueOf = (config) => Object.fromEntries(Object.entries(config.catalogue ?? {}).filter(([k, v]) => !k.startsWith("//") && v && typeof v === "object"));

// The plugin set for a target = core (always) + selected bundle plugins ("*" = all) − disable.
export function pluginsFor(config, target) {
  const t = config.targets?.[target] ?? {};
  const sel = ((t.plugins === undefined || t.plugins === "*") ? bundleNames(config) : (Array.isArray(t.plugins) ? t.plugins : []))
    .filter((n) => n && !String(n).startsWith("//"));
  const disable = new Set(t.disable ?? []);
  return [...CORE_PLUGINS, ...sel].filter((p) => !disable.has(p));
}

// The providers (resolved from the catalogue) for a target. "*"/absent = all in the catalogue.
export function providersFor(config, target) {
  const t = config.targets?.[target] ?? {};
  const cat = { ...DEFAULT_PROVIDERS, ...(config.providers ?? {}) };
  const names = (Array.isArray(t.providers)) ? t.providers : Object.keys(cat);
  const out = {};
  for (const n of names) if (cat[n]) out[n] = cat[n];
  return out;
}

const asUrl = (d) => (d ? (/^https?:\/\//.test(d) ? d : `https://${d}`) : "");

// The public URL users hit (EIDAN_WEB_URL) = the web (vercel) target's domain; else any target's domain.
export function publicWebUrl(config) {
  const ts = Object.values(config.targets ?? {});
  const web = ts.find((t) => t.type === "vercel" && t.domain) ?? ts.find((t) => t.domain);
  return web ? asUrl(web.domain) : "";
}

// The engine a web target proxies to (EIDAN_ENGINE_URL) = its `engine` ref's URL; else a domain'd
// engine; else any fly app (reachable at its default <app>.fly.dev hostname even without a custom
// domain). A fly engine with no custom domain falls back to https://<app>.fly.dev.
export function engineUrlFor(config, target) {
  const t = config.targets?.[target] ?? {};
  const eng = (t.engine && config.targets?.[t.engine])
    || Object.values(config.targets ?? {}).find((x) => x.domain && (x.type === "fly" || x.type === "ssh-node"))
    || Object.values(config.targets ?? {}).find((x) => x.type === "fly" && x.app);
  if (!eng) return "";
  if (eng.domain) return asUrl(eng.domain);
  if (eng.type === "fly" && eng.app) return `https://${eng.app}.fly.dev`;
  return "";
}

export const jobKindsFor = (config, target) => {
  const j = config.targets?.[target]?.jobs;
  return Array.isArray(j) && j.length ? j : ["chat"];
};
export const modelsFor = (config, target) => config.targets?.[target]?.models ?? "*";
export const domainOf = (config, target) => config.targets?.[target]?.domain ?? null;
export const corsOf = (config, target) => config.targets?.[target]?.cors ?? [];

// The env values DERIVED from the manifest for a target (compiled, not in .env): job kinds, public
// URL, CORS, and (web) the engine URL. Used by both `compile` and `env-push` so they agree.
export function derivedEnv(config, target) {
  const t = config.targets?.[target] ?? {};
  const d = { EIDAN_JOB_KINDS: jobKindsFor(config, target).join(",") };
  const web = publicWebUrl(config); if (web) d.EIDAN_WEB_URL = web;
  const cors = corsOf(config, target); if (cors.length) d.EIDAN_HTTP_CORS_ORIGINS = cors.join(",");
  if (t.type === "vercel") { const e = engineUrlFor(config, target); if (e) d.EIDAN_ENGINE_URL = e; }
  return d;
}

// Render a target's matbot.yaml (principal + plugins + providers). Provider credentials reference
// ${ENV}; the node resolves them from its pushed env. Pure — returns text, no secrets.
export function renderMatbotYaml(config, target) {
  const plugins = pluginsFor(config, target);
  const providers = providersFor(config, target);
  const lines = [
    `# AUTO-GENERATED by \`eidan compile ${target}\` from the manifest. Do not hand-edit.`,
    // No `principal:` line on purpose. matbot.yaml is NOT Vault-expanded (only credentials' ${NAME}
    // placeholders are), so a literal `principal: ${MATBOT_PRINCIPAL}` would be loaded verbatim as a
    // bogus non-UUID id wherever the env override is absent (e.g. a detached cognition reindex),
    // FK-failing every principal-scoped write (#380). Boot precedence is --principal > MATBOT_PRINCIPAL
    // env (routed to each node by env-schema) > yaml > systemPrincipal(); omitting the field lets the
    // env drive it, with systemPrincipal() as a sane fallback instead of a broken literal.
    "plugins:",
    ...plugins.map((p) => `  - ${moduleForPlugin(p)}`),
    "",
    "providers:",
  ];
  for (const [n, p] of Object.entries(providers)) {
    lines.push(`  ${n}:`);
    lines.push(`    module: ${p.module}`);
    if (p.endpoint) lines.push(`    endpoint: ${p.endpoint}`);
    if (p.model) lines.push(`    model: ${p.model}`);
    if (p.key) { lines.push("    credentials:"); lines.push(`      apiKey: \${${p.key}}`); }
    if (p.parameters && typeof p.parameters === "object") {
      lines.push("    parameters:");
      for (const [k, v] of Object.entries(p.parameters)) lines.push(`      ${k}: ${v}`);
    }
  }
  return lines.join("\n") + "\n";
}

// Minimal manifest for a brand-new project (init writes this when eidan.deploy.json is absent).
export const STARTER_MANIFEST = {
  "//": "eidan deployment manifest — managed by the wizard (node deploy/eidan-cli.mjs). Add targets/bundles there.",
  secrets: { source: "dotenv" },
  bundles: [],
  targets: {},
};

// A minimal fly.toml for a fly target (the wizard writes this when you add one; tweak as needed).
export function renderFlyToml(app, region = "lhr", port = 8090) {
  return [
    "# AUTO-GENERATED by the eidan wizard. Fly-specific bits (services/mounts/scale) are yours to tune.",
    `app = "${app}"`,
    `primary_region = "${region}"`,
    "",
    "[build]",
    '  dockerfile = "infra/fly-mb/Dockerfile"',
    "",
    "[http_service]",
    `  internal_port = ${port}`,
    "  force_https = true",
    "  auto_stop_machines = true",
    "  auto_start_machines = true",
    "  min_machines_running = 0",
    "",
    "[[vm]]",
    '  size = "shared-cpu-1x"',
    '  memory = "512mb"',
    "",
  ].join("\n");
}

// Capability summary for a target (for the wizard / `compile` output). Names only.
export function summarize(config, target) {
  return {
    plugins: pluginsFor(config, target),
    providers: Object.keys(providersFor(config, target)),
    models: modelsFor(config, target),
    jobs: jobKindsFor(config, target),
    domain: domainOf(config, target),
    cors: corsOf(config, target),
  };
}
