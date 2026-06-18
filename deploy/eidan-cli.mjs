#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// `eidan` — the interactive operator CLI. A @clack/prompts wizard (arrow-key menus, multiselect,
// spinners, colour) over the deploy verbs, so an operator builds + deploys without hand-editing
// YAML/.env. `eidan <verb> …` still delegates to eidan-deploy.mjs for CI.
import * as p from "@clack/prompts";
import pc from "picocolors";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { env, stdin } from "node:process";
import { loadConfig, ROOT } from "./assemble.mjs";
import { bundleNames, DEFAULT_PROVIDERS, catalogueOf, installedPlugins, CORE_PLUGINS } from "./manifest.mjs";
import { parseEnvMap } from "./env-model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOY = join(HERE, "eidan-deploy.mjs");
const MANIFEST = join(ROOT, "eidan.deploy.json");
const CATALOGUE_FILE = join(ROOT, "eidan.catalogue.json");

// The bundle catalogue = org knowledge that must SURVIVE a from-zero re-init, so it lives in its own
// gitignored file (not eidan.deploy.json, which gets deleted/recreated). Merge file over config for
// back-compat. Private repo names live here (gitignored), never in tracked code.
function loadCatalogue(cfg) {
  let fileCat = {};
  try { if (existsSync(CATALOGUE_FILE)) fileCat = JSON.parse(readFileSync(CATALOGUE_FILE, "utf8")); } catch { /* ignore */ }
  const merged = { ...catalogueOf(cfg), ...fileCat };
  // drop "//" comment keys + non-object values so they never become selectable bundles.
  return Object.fromEntries(Object.entries(merged).filter(([k, v]) => !k.startsWith("//") && v && typeof v === "object"));
}

// Remember a custom-defined bundle as org knowledge: write it to the gitignored catalogue file so it
// SURVIVES a from-zero re-init of eidan.deploy.json and shows up in the pick-list next time. The
// catalogue stores the source shape ({git|path, subdir, kind}); the per-target `name` is the key.
function rememberInCatalogue(entry) {
  let cat = {};
  try { if (existsSync(CATALOGUE_FILE)) cat = JSON.parse(readFileSync(CATALOGUE_FILE, "utf8")); } catch { /* ignore — overwrite a corrupt file */ }
  if (cat[entry.name]) return; // already catalogued — don't clobber a richer hand-authored entry
  const { name, ...source } = entry;
  cat[name] = source;
  writeFileSync(CATALOGUE_FILE, JSON.stringify(cat, null, 2) + "\n");
}

// provider names from the catalogue (DEFAULT_PROVIDERS + config.providers), minus "//" comments.
function providerNames(cfg) {
  return [...new Set([...Object.keys(DEFAULT_PROVIDERS), ...Object.keys(cfg.providers ?? {})])].filter((n) => !n.startsWith("//"));
}

const ROBOT = [
  "    .-=========-.",
  "    | [o]   [o] |",
  "    |     ∆     |",
  "    |   '---'   |",
  "    '-==[___]==-'",
  "       /     \\",
];

// Local git status (no network): branch, short sha, dirty, and ahead/behind vs the last-fetched upstream.
function gitInfo() {
  const g = (args) => { try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return ""; } };
  const branch = g(["rev-parse", "--abbrev-ref", "HEAD"]);
  const sha = g(["rev-parse", "--short", "HEAD"]);
  const dirty = g(["status", "--porcelain"]) !== "";
  let status = "";
  const lr = g(["rev-list", "--left-right", "--count", "HEAD...@{u}"]); // "<ahead>\t<behind>"
  if (lr) { const [ahead, behind] = lr.split(/\s+/).map(Number); status = behind > 0 ? `${behind} behind` : (ahead > 0 ? `${ahead} ahead` : "up to date"); }
  return { branch, sha, dirty, status };
}

export function hero() {
  let version = "?";
  try { version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version ?? "?"; } catch { /* ignore */ }
  const g = gitInfo();
  const sc = g.status === "up to date" ? pc.green : (g.status ? pc.yellow : pc.dim);
  const head = g.branch ? `${pc.dim(`${g.branch}@${g.sha}${g.dirty ? "*" : ""}`)}  ${sc(g.status || "untracked")}` : "";
  const lines = ROBOT.map((l, i) => pc.cyan(l) + (i === 1 ? "   " + pc.bold(pc.cyanBright("e i d a n")) : i === 2 ? "   " + pc.dim("v" + version) : i === 3 ? "   " + head : ""));
  console.log("\n" + lines.join("\n") + "\n");
}

const guard = (v) => { if (p.isCancel(v)) { p.cancel("Cancelled."); process.exit(0); } return v; };

// --- value checks (so each entered secret is verified before we move on) ---------------------
async function checkDb(url) {
  try { const { default: pg } = await import("pg"); const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000 }); await c.connect(); await c.query("select 1"); await c.end(); return null; }
  catch (e) { return (e?.message || String(e)).split("\n")[0]; }
}
// Validate a provider's key against its /models endpoint (anthropic = x-api-key; rest = OpenAI Bearer).
async function checkProviderKey(prov, key) {
  try {
    const isAnthropic = /anthropic/.test(prov.module || "");
    // pick an AUTH-GATED endpoint per provider (openrouter's /models is public → use its key endpoint).
    const url = isAnthropic ? "https://api.anthropic.com/v1/models"
      : /openrouter\.ai/.test(prov.endpoint) ? "https://openrouter.ai/api/v1/auth/key"
        : prov.endpoint.replace(/\/$/, "") + "/models";
    const headers = isAnthropic ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { Authorization: "Bearer " + key };
    const r = await fetch(url, { headers });
    return r.ok ? null : (r.status === 401 ? "rejected (401 — bad key)" : `unexpected ${r.status}`);
  } catch (e) { return "network error: " + (e?.message || e); }
}
const urlValidate = (v) => { if (!v) return undefined; try { new URL(v); return undefined; } catch { return "enter a full URL incl. http(s)://"; } };
const emailValidate = (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? undefined : "enter a valid email");

// Prompt → live-check the value → on failure, offer retry or "use anyway" (offline / known-good).
async function askValid(label, promptFn, check) {
  for (;;) {
    const v = guard(await promptFn());
    const sp = p.spinner(); sp.start(`Checking ${label}`);
    const err = await check(v);
    if (!err) { sp.stop(pc.green(`${label}: ok`)); return v; }
    sp.stop(pc.yellow(`${label}: ${err}`));
    if (guard(await p.confirm({ message: `Use this ${label} anyway?`, initialValue: false }))) return v;
  }
}

// Is the project set up enough to use? (manifest + .env with the essentials filled, no placeholders)
function isConfigured() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(MANIFEST) || !existsSync(envPath)) return false;
  const v = parseEnvMap(readFileSync(envPath, "utf8"));
  // provider-agnostic essentials (the chosen provider's key is checked in onboarding, not here)
  return ["DATABASE_URL", "EIDAN_AUTH_MASTER_KEY", "EIDAN_AUTH_JWT_SECRET", "EIDAN_AUTH_ALLOWED_EMAIL"]
    .every((k) => v[k] && !/‹FILL|<.*>/.test(v[k]));
}

// Set (or replace) one KEY=value in a .env file, preserving everything else. 0600.
function setEnv(path, key, value) {
  let t = existsSync(path) ? readFileSync(path, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  t = re.test(t) ? t.replace(re, () => `${key}=${value}`) : (t && !t.endsWith("\n") ? t + "\n" : t) + `${key}=${value}\n`;
  writeFileSync(path, t, { mode: 0o600 });
}

// Add/configure one LLM provider: pick from the catalogue, enter + validate its key (local = none),
// write the key to .env. eidan supports MANY providers — add more anytime; targets pick per-target.
async function setupProvider(message) {
  const cfg = loadConfig();
  const cat = { ...DEFAULT_PROVIDERS, ...(cfg.providers ?? {}) };
  const envVals = existsSync(join(ROOT, ".env")) ? parseEnvMap(readFileSync(join(ROOT, ".env"), "utf8")) : {};
  const provName = guard(await p.select({
    message,
    options: providerNames(cfg).map((n) => ({ value: n, label: n, hint: cat[n].key ? (envVals[cat[n].key] ? pc.green("configured") : cat[n].key) : "local / no key" })),
  }));
  const prov = cat[provName];
  if (prov.key) {
    const key = await askValid(`${provName} key`, () => p.password({ message: `${provName} API key  (${prov.key})` }), (k) => checkProviderKey(prov, k));
    setEnv(join(ROOT, ".env"), prov.key, key);
  } else p.note(`${provName} is local — no API key needed.`);
  return provName;
}

// First-run: scaffold + walk through the essentials (config, secrets, DB) so a fresh project works.
async function onboard() {
  p.note("This project isn't set up yet — let's do the essentials: config, secrets, and the database.", pc.yellow("first run"));
  const envPath = join(ROOT, ".env");
  if (!existsSync(MANIFEST) || !existsSync(envPath)) runVerb(["init"]); // manifest + .env (KEK/JWT auto-generated, matching)
  const cur = existsSync(envPath) ? parseEnvMap(readFileSync(envPath, "utf8")) : {};
  const isSet = (k) => cur[k] && !/‹FILL|<.*>/.test(cur[k]);
  const webEnv = join(ROOT, "apps/web/.env");

  const db = await askValid("database", () => p.password({ message: "Postgres connection string  (DATABASE_URL)" }), checkDb);
  setEnv(envPath, "DATABASE_URL", db);
  const email = guard(await p.text({ message: "Your login email  (the only account allowed to sign in)", initialValue: isSet("EIDAN_AUTH_ALLOWED_EMAIL") ? cur.EIDAN_AUTH_ALLOWED_EMAIL : "", validate: emailValidate }));
  setEnv(envPath, "EIDAN_AUTH_ALLOWED_EMAIL", email);
  // Your FIRST LLM provider (you can add more later; targets can use different ones). It becomes the default.
  const provName = await setupProvider("Add your first LLM provider  (add more later; targets can differ)");
  setEnv(envPath, "EIDAN_AGUI_PROVIDER", provName);

  // Optional SMTP for magic-link sign-in. Without it, the login link + code are shown on the login
  // screen instead of emailed. The WEB (Vercel) sends the mail, so these mirror to apps/web/.env below.
  if (guard(await p.confirm({ message: "Set up email (SMTP) so sign-in links are emailed?  (skip → link shown on screen)", initialValue: false }))) {
    setEnv(envPath, "EIDAN_SMTP_HOST", guard(await p.text({ message: "SMTP host", placeholder: "smtp.example.com" })));
    setEnv(envPath, "EIDAN_SMTP_PORT", guard(await p.text({ message: "SMTP port", initialValue: "587" })));
    const smtpUser = guard(await p.text({ message: "SMTP username  (blank if none)", initialValue: "" }));
    if (smtpUser) setEnv(envPath, "EIDAN_SMTP_USER", smtpUser);
    const smtpPass = guard(await p.password({ message: "SMTP password  (blank if none)" }));
    if (smtpPass) setEnv(envPath, "EIDAN_SMTP_PASSWORD", smtpPass);
    setEnv(envPath, "EIDAN_SMTP_FROM", guard(await p.text({ message: "From header", initialValue: `eidan <no-reply@${email.split("@")[1] ?? "example.com"}>` })));
    p.note("SMTP set — sign-in links will be emailed.", pc.green("email"));
  } else {
    p.note("No SMTP — the sign-in link + code show on the login screen (you can add SMTP later).", "email");
  }

  // apps/web/.env: mirror the shared auth trio (KEK/JWT/email MUST be byte-identical), the web's DB,
  // and any SMTP (the web mailer reads these). The public + engine URLs are NOT asked here — they're
  // DERIVED from target domains at compile (vercel target's domain → EIDAN_WEB_URL; engine ref → URL).
  const root = parseEnvMap(readFileSync(envPath, "utf8"));
  const mirror = ["EIDAN_AUTH_MASTER_KEY", "EIDAN_AUTH_JWT_SECRET", "EIDAN_AUTH_ALLOWED_EMAIL",
    "EIDAN_SMTP_HOST", "EIDAN_SMTP_PORT", "EIDAN_SMTP_USER", "EIDAN_SMTP_PASSWORD", "EIDAN_SMTP_FROM"];
  for (const k of mirror) if (root[k]) setEnv(webEnv, k, root[k]);
  setEnv(webEnv, "EIDAN_DATABASE_URL", db);

  if (guard(await p.confirm({ message: "Set up the database now (run migrations)?", initialValue: true }))) {
    const sp = p.spinner(); sp.start("Running migrations");
    const r = spawnSync(process.execPath, [join(ROOT, "migrations/migrate.mjs")], { env: { ...env, EIDAN_DATABASE_URL: db }, cwd: ROOT, encoding: "utf8" });
    if (r.status === 0) sp.stop(pc.green("database ready"));
    else { sp.stop(pc.red("migration failed — check the connection string")); console.log(pc.dim((r.stderr || r.stdout || "").trim().split("\n").slice(-4).join("\n"))); }
  }
  p.note("Essentials done. Next: add bundles + targets, then deploy.", pc.green("set up"));
}
function runVerb(args) { return spawnSync(process.execPath, [DEPLOY, ...args], { stdio: "inherit", cwd: ROOT }).status ?? 0; }

export function targetList() {
  const cfg = loadConfig();
  return Object.entries(cfg.targets ?? {}).map(([name, t]) => ({ name, type: t.type }));
}

export const MENU = [
  { value: "init", label: "Init a project", hint: "scaffold config + generate secrets" },
  { value: "add-target", label: "Add a target", hint: "fly / ssh-node / vercel" },
  { value: "add-bundle", label: "Add a bundle / plugin" },
  { value: "add-provider", label: "Add an LLM provider", hint: "+ key; targets pick per-target" },
  { value: "configure", label: "Configure a target", hint: "plugins / providers / jobs / domain" },
  { value: "keys", label: "Add keys / secrets", hint: "edit in $EDITOR" },
  { value: "doctor", label: "Doctor", hint: "validate all config" },
  { value: "compile", label: "Compile a target", hint: "preview matbot.yaml + env" },
  { value: "env-plan", label: "Plan a target's env" },
  { value: "env-push", label: "Push env to a target" },
  { value: "migrate", label: "Run migrations" },
  { value: "deploy", label: "Deploy a target", hint: "code + restart" },
  { value: "seal", label: "Seal secrets", hint: ".env → .env.enc" },
  { value: "quit", label: "Quit" },
];

async function pickTarget() {
  const ts = targetList();
  if (!ts.length) { p.note("No targets yet — run Add a target first.", "empty"); return null; }
  return guard(await p.select({ message: "Which target?", options: ts.map((t) => ({ value: t.name, label: `${t.name}`, hint: t.type })) }));
}

async function keysFlow() {
  const which = guard(await p.select({ message: "Keys / secrets (edited in your $EDITOR — never shown here):", options: [
    { value: "root", label: ".env (engine: fly + pi)" },
    { value: "web", label: "apps/web/.env (web: vercel)" },
    { value: "doctor", label: "Show what's missing (doctor)" },
  ] }));
  const editor = env.EDITOR || env.VISUAL || "nano";
  if (which === "root") spawnSync(editor, [join(ROOT, ".env")], { stdio: "inherit" });
  else if (which === "web") spawnSync(editor, [join(ROOT, "apps/web/.env")], { stdio: "inherit" });
  else runVerb(["doctor"]);
}

async function addTargetFlow() {
  const cfg = loadConfig(); cfg.targets ??= {};
  // default a new target's provider to the one chosen at onboarding (EIDAN_AGUI_PROVIDER), not claude.
  const defProv = (() => { try { return parseEnvMap(readFileSync(join(ROOT, ".env"), "utf8")).EIDAN_AGUI_PROVIDER; } catch { return null; } })() || "claude";
  const name = guard(await p.text({ message: "New target name", placeholder: "fly | pi | vercel" }));
  if (!name) return;
  if (cfg.targets[name]) { p.note(`"${name}" exists — use Configure.`); return; }
  const type = guard(await p.select({ message: "Type", options: [
    { value: "fly", label: "Fly.io", hint: "engine, container" },
    { value: "ssh-node", label: "ssh-node", hint: "Pi/VM under systemd" },
    { value: "vercel", label: "Vercel", hint: "web UI" },
  ] }));
  const t = { type };
  if (type === "fly") {
    t.app = guard(await p.text({ message: "Fly app name", initialValue: `${name}-api` }));
    t.region = guard(await p.text({ message: "Region", initialValue: "lhr" }));
    Object.assign(t, { plugins: "*", providers: [defProv], jobs: ["chat"], domain: guard(await p.text({ message: "Public domain (optional)", placeholder: "" })) || null });
    // fly.toml is compiled from the manifest at deploy time (not stored).
  } else if (type === "ssh-node") {
    t.host = guard(await p.text({ message: "Host / IP" }));
    t.user = guard(await p.text({ message: "SSH / deploy user", placeholder: "who you ssh+rsync+sudo as" }));
    t.run_user = guard(await p.text({ message: "Runtime user (systemd User= the app runs as)", initialValue: t.user, placeholder: "owns ~/.claude, git identity, WorkingDirectory" }));
    t.dir = guard(await p.text({ message: "Remote dir (under the runtime user's home)", initialValue: "eidan-mb" }));
    t.service = guard(await p.text({ message: "systemd service", initialValue: "eidan-mb.service" }));
    t.env_files = ["/etc/eidan/eidan.env", "/etc/eidan/matbot.env"];
    Object.assign(t, { plugins: "*", providers: [defProv], jobs: ["chat", "code"], domain: null, env_set: { EIDAN_NODE_ID: name, EIDAN_NODE_TYPE: "node" } });
  } else {
    t.project = guard(await p.text({ message: "Vercel project", initialValue: `${name}-web` }));
    t.env_file = "apps/web/.env";
    t.domain = guard(await p.text({ message: "Public domain (→ EIDAN_WEB_URL)", placeholder: "e.example.com" })) || null;
    // pick the engine target it proxies to from existing targets (not free text).
    const engTargets = Object.entries(cfg.targets).filter(([, x]) => x.type === "fly" || x.type === "ssh-node").map(([nm]) => nm);
    let eng = "";
    if (engTargets.length) eng = guard(await p.select({ message: "Engine target the web proxies to (→ EIDAN_ENGINE_URL)", options: [...engTargets.map((nm) => ({ value: nm, label: nm })), { value: "", label: pc.dim("(decide later / auto)") }] }));
    else p.note("No engine (fly/ssh-node) target yet — add one first; EIDAN_ENGINE_URL auto-derives.");
    Object.assign(t, { plugins: "*", ...(eng ? { engine: eng } : {}) });
  }
  cfg.targets[name] = t;
  writeFileSync(MANIFEST, JSON.stringify(cfg, null, 2) + "\n");
  p.note(`Added "${name}" (${type}) — now let's configure what runs there.`, pc.green("saved"));
  await configureFlow(name); // continuation: creating a target flows straight into configuring it
  if (guard(await p.confirm({ message: `Deploy "${name}" now?`, initialValue: false }))) runVerb(["deploy", name]);
}

// Choose a branch for a git bundle: list the repo's remote branches (if we have access) and pick.
async function pickBranch(repo, current) {
  let branches = [];
  try {
    const out = execFileSync("git", ["ls-remote", "--heads", `https://github.com/${repo}.git`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    branches = out.split("\n").map((l) => (l.split("\t")[1] || "").replace("refs/heads/", "")).filter(Boolean);
  } catch { /* no access / offline — fall back to free text */ }
  const def = current || "main";
  if (!branches.length) return guard(await p.text({ message: `Branch for ${repo} (no remote access — type it)`, initialValue: def }));
  return guard(await p.select({ message: `Branch for ${repo}`, options: branches.map((b) => ({ value: b, label: b })), initialValue: branches.includes(def) ? def : branches[0] }));
}

// A bundle declares the job kinds it registers in its package.json under `eidan.kinds` (string[]).
// This is the source of truth — the operator shouldn't have to know/retype it.
const declaredKinds = (pkg) => (Array.isArray(pkg?.eidan?.kinds) ? pkg.eidan.kinds.filter((k) => typeof k === "string" && k) : []);

// Validate a local path is a real, well-formed matbot bundle: an existing directory with a
// package.json that declares `matbotRuntime` or an `exports["."]` entry that actually exists on disk.
// Returns { ok, reason, pkg } — `reason` is shown to the operator on failure.
function inspectLocalBundle(dir) {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return { ok: false, reason: "path does not exist" };
  let st; try { st = statSync(abs); } catch { return { ok: false, reason: "cannot read path" }; }
  if (!st.isDirectory()) return { ok: false, reason: "not a directory" };
  const pkgPath = join(abs, "package.json");
  if (!existsSync(pkgPath)) return { ok: false, reason: "no package.json — not a bundle" };
  let pkg; try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { return { ok: false, reason: "package.json is not valid JSON" }; }
  const entry = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."];
  if (!Array.isArray(pkg.matbotRuntime) && !entry) return { ok: false, reason: "package.json has no matbotRuntime/exports — not a matbot plugin" };
  if (entry && !existsSync(join(abs, entry))) return { ok: false, reason: `entry "${entry}" is missing` };
  return { ok: true, pkg };
}

// Find the matbot bundles at a local path: the dir itself if it's a plugin, otherwise its
// `packages/*` children that are plugins (a monorepo of bundles). Returns [{ dir, pkg }].
function discoverBundles(dir) {
  const self = inspectLocalBundle(dir);
  if (self.ok) return [{ dir, pkg: self.pkg }];
  const pkgsDir = join(resolve(ROOT, dir), "packages");
  if (!existsSync(pkgsDir)) return [];
  let children = []; try { children = readdirSync(pkgsDir); } catch { return []; }
  return children.map((n) => {
    const child = `${dir.replace(/\/+$/, "")}/packages/${n}`;
    const r = inspectLocalBundle(child);
    return r.ok ? { dir: child, pkg: r.pkg } : null;
  }).filter(Boolean);
}

// Best-effort read of a git bundle's package.json (raw.githubusercontent, no clone) so we can pick up
// its declared kinds at add time. Returns the parsed pkg or null (private repo / offline / 404).
async function fetchGitManifest(repo, branch, subdir) {
  const sub = subdir ? subdir.replace(/^\/+|\/+$/g, "") + "/" : "";
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/${sub}package.json`;
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  try {
    const res = await fetch(url, token ? { headers: { Authorization: `token ${token}` } } : undefined);
    if (!res.ok) return null;
    return JSON.parse(await res.text());
  } catch { return null; }
}

// Turn a source ({git|path, subdir?}) + its manifest into a finished bundle entry: confirm the name
// and resolve kinds (declared wins; ask only when none are declared / the manifest is unreadable).
async function finalizeBundle(b, pkg) {
  const guess = (pkg?.name ? String(pkg.name).split("/").pop() : null)
    ?? (b.subdir ? b.subdir.split("/").filter(Boolean).pop()
      : b.git ? b.git.split("#")[0].split("/").pop()
      : b.path ? b.path.split("/").filter(Boolean).pop() : "");
  const name = guard(await p.text({ message: "Bundle name (becomes packages/<name>)", initialValue: guess }));
  if (!name) return null;
  b.name = name.trim();
  const declared = declaredKinds(pkg);
  if (declared.length) {
    b.kinds = declared;
    p.note(`Bundle declares job kind(s): ${pc.cyan(declared.join(", "))}`, "kinds");
  } else {
    p.note(pc.dim(pkg ? "this bundle declares no eidan.kinds — list them if it registers job handlers" : "couldn't read the repo's manifest (private/offline) — list any job kinds it registers"), "kinds");
    const kind = guard(await p.text({ message: "Job kind(s) it registers (comma list; blank = none)", placeholder: "chat | code | …" }));
    const ks = (kind ?? "").split(/[\s,]+/).filter(Boolean);
    if (ks.length) b.kinds = ks;
  }
  return b;
}

// Build a bundle entry straight from a discovered local plugin (no prompts) — used for bulk-add when
// the operator points at a monorepo and multi-selects several packages.
const bundleFromLocal = ({ dir, pkg }) => {
  const kinds = declaredKinds(pkg);
  return { name: String(pkg.name).split("/").pop(), path: dir, ...(kinds.length ? { kinds } : {}) };
};

// Define one or more custom bundles. Returns an array of bundle entries (a monorepo path can yield
// several), or null if cancelled.
async function customBundle() {
  const src = guard(await p.select({ message: "Source", options: [{ value: "git", label: "GitHub repo", hint: "owner/name" }, { value: "path", label: "local path" }] }));
  if (src === "git") {
    // Lead with the org/name pair (no #ref in here) — branch is picked separately from the live remote.
    let repo = guard(await p.text({ message: "GitHub repo (owner/name)", placeholder: "owner/my-bundle", validate: (v) => (v && /^[\w.-]+\/[\w.-]+$/.test(v.trim())) ? undefined : "enter owner/name, e.g. owner/my-bundle" }));
    if (!repo) return null;
    repo = repo.trim();
    const branch = await pickBranch(repo);
    const b = { git: `${repo}#${branch}` };
    const sd = guard(await p.text({ message: "subdir (optional)", placeholder: "packages/<plugin> — leave blank if the repo root is the plugin" }));
    if (sd) b.subdir = sd.trim();
    const pkg = await fetchGitManifest(repo, branch, b.subdir); // null for private/offline — we ask for kinds
    const done = await finalizeBundle(b, pkg);
    return done ? [done] : null;
  }
  // local path: discover the bundle(s) at the path (the dir itself, or its packages/* children).
  for (;;) {
    const path = guard(await p.text({ message: "local path", placeholder: "../my-bundle (a repo) or ../my-bundle/packages/<plugin>" }));
    if (!path) return null;
    const found = discoverBundles(path.trim());
    if (!found.length) {
      p.note(pc.red(inspectLocalBundle(path.trim()).reason ?? "no bundles found under this path"), "not a valid bundle");
      if (!guard(await p.confirm({ message: "Try a different path?", initialValue: true }))) return null;
      continue;
    }
    // A single plugin → confirm name + kinds. A monorepo → multi-select which packages to add (bulk).
    if (found.length === 1) { const done = await finalizeBundle({ path: found[0].dir }, found[0].pkg); return done ? [done] : null; }
    const picks = guard(await p.multiselect({
      message: `${found.length} bundles found under ${path.trim()} — add which?`,
      options: found.map((f) => ({ value: f.dir, label: String(f.pkg.name).split("/").pop(), hint: declaredKinds(f.pkg).length ? `kinds: ${declaredKinds(f.pkg).join(",")}` : "no job kinds" })),
      required: false,
    }));
    const chosen = found.filter((f) => picks.includes(f.dir));
    return chosen.length ? chosen.map(bundleFromLocal) : null;
  }
}

// Accept freshly-defined custom bundles (customBundle returns an array): record each in the manifest
// + catalogue, skipping any name already present so a re-add never duplicates a row.
function acceptCustom(cfg, have, added, bundles) {
  for (const b of bundles ?? []) {
    if (have.has(b.name)) { p.note(pc.yellow(`"${b.name}" is already added — skipped.`), "skip"); continue; }
    have.add(b.name); cfg.bundles.push(b); rememberInCatalogue(b); added.push(b.name);
  }
}

async function addBundleFlow() {
  const cfg = loadConfig(); cfg.bundles ??= [];
  const catalogue = loadCatalogue(cfg);
  const have = new Set(cfg.bundles.map((b) => b.name));
  const avail = Object.entries(catalogue).filter(([n]) => !have.has(n));
  const added = [];
  if (avail.length) {
    // Choose from the catalogue (not free text) + an explicit "custom" escape hatch.
    const picks = guard(await p.multiselect({
      message: "Add bundles",
      options: [...avail.map(([n, m]) => ({ value: n, label: n, hint: m.desc ?? (m.git ?? m.path) })), { value: "__custom__", label: pc.dim("+ custom (define a new one)") }],
      required: false,
    }));
    for (const n of picks) {
      if (n === "__custom__") { acceptCustom(cfg, have, added, await customBundle()); continue; }
      const m = catalogue[n];
      const entry = { name: n };
      if (m.git) { const [repo, ref] = m.git.split("#"); const branch = await pickBranch(repo, ref); entry.git = `${repo}#${branch}`; }
      else if (m.path) entry.path = m.path;
      if (m.subdir) entry.subdir = m.subdir;
      if (Array.isArray(m.kinds) && m.kinds.length) entry.kinds = m.kinds;
      else if (m.kind) entry.kind = m.kind; // legacy single-kind catalogue entries
      cfg.bundles.push(entry);
      added.push(n);
    }
  } else {
    // No catalogue yet (e.g. AGPL core ships none — private bundle names never live in tracked code).
    // Ask for the bundle's GitHub repo (owner/name) directly, and loop so several can be added at once.
    p.note("No bundles known yet — add them by GitHub repo (owner/name). I'll remember each for next time.", "new catalogue");
    do {
      acceptCustom(cfg, have, added, await customBundle());
    } while (guard(await p.confirm({ message: "Add another bundle?", initialValue: false })));
  }
  if (!added.length) return;
  writeFileSync(MANIFEST, JSON.stringify(cfg, null, 2) + "\n");
  p.note(`Added: ${added.join(", ")}. Pick them per target in Configure.`, pc.green("saved"));
}

async function configureFlow(preselected) {
  const cfg = loadConfig();
  const tName = preselected ?? await pickTarget(); if (!tName) return;
  const t = cfg.targets[tName];
  // the plugins you can run here = bundles declared in the manifest + any present in this checkout
  // (packages/<name>), minus the always-on core.
  const allBundles = [...new Set([...bundleNames(cfg), ...installedPlugins(ROOT).filter((n) => !CORE_PLUGINS.includes(n))])].sort();
  const allProviders = providerNames(cfg);
  for (;;) {
    const field = guard(await p.select({ message: `Configure ${pc.cyan(tName)}`, options: [
      { value: "plugins", label: "Plugins", hint: Array.isArray(t.plugins) ? `${t.plugins.length} selected` : "all (*)" },
      { value: "providers", label: "Providers", hint: Array.isArray(t.providers) ? t.providers.join(",") : "all (*)" },
      { value: "jobs", label: "Job kinds", hint: (t.jobs ?? ["chat"]).join(",") },
      { value: "models", label: "Models", hint: Array.isArray(t.models) ? `${t.models.length}` : (t.models ?? "*") },
      { value: "domain", label: "Domain", hint: t.domain ?? "none" },
      { value: "save", label: pc.green("Save + back") },
      { value: "back", label: "Back (discard)" },
    ] }));
    if (field === "plugins") {
      if (!allBundles.length) { p.note("No extra plugins yet — core plugins are always on. Use 'Add a bundle' to install some.", "plugins"); continue; }
      const sel = guard(await p.multiselect({ message: "Plugins to run here (core is always on)", options: allBundles.map((b) => ({ value: b, label: b })), initialValues: t.plugins === "*" ? allBundles : (t.plugins ?? []), required: false }));
      t.plugins = sel.length === allBundles.length ? "*" : sel;
    } else if (field === "providers") {
      const sel = guard(await p.multiselect({ message: "Providers", options: allProviders.map((x) => ({ value: x, label: x })), initialValues: Array.isArray(t.providers) ? t.providers : allProviders, required: false }));
      t.providers = sel;
    } else if (field === "jobs") { const v = guard(await p.text({ message: "Job kinds (comma list)", initialValue: (t.jobs ?? ["chat"]).join(",") })); t.jobs = v.split(/[\s,]+/).filter(Boolean); }
    else if (field === "models") { const v = guard(await p.text({ message: "Models ('*' or comma list)", initialValue: Array.isArray(t.models) ? t.models.join(",") : (t.models ?? "*") })); t.models = v.trim() === "*" ? "*" : v.split(/[\s,]+/).filter(Boolean); }
    else if (field === "domain") { const v = guard(await p.text({ message: "Domain (blank = none)", initialValue: t.domain ?? "" })); t.domain = v || null; }
    else if (field === "save") {
      writeFileSync(MANIFEST, JSON.stringify(cfg, null, 2) + "\n");
      p.note(`Saved ${tName}.`, pc.green("saved"));
      if (guard(await p.confirm({ message: "Compile it now to preview?", initialValue: false }))) runVerb(["compile", tName]);
      return;
    } else return;
  }
}

async function targetVerb(verb) {
  const t = await pickTarget(); if (!t) return;
  if (verb === "deploy") { if (!guard(await p.confirm({ message: `Deploy ${t} (assemble + ship + restart)?`, initialValue: false }))) return; runVerb(["deploy", t]); }
  else if (verb === "env-push") {
    runVerb(["env-push", t]); // dry-run preview
    if (guard(await p.confirm({ message: `Apply env-push to ${t}?`, initialValue: false }))) runVerb(["env-push", t, "--yes"]);
  } else runVerb([verb, t]); // env-plan | migrate | compile
}

async function main() {
  hero();
  if (!stdin.isTTY) { console.log(pc.dim("  (interactive menu needs a terminal — use `eidan-deploy.mjs <verb>` for non-interactive)\n")); return; }
  p.intro(pc.bgCyan(pc.black(" eidan operator ")));
  if (!isConfigured()) await onboard(); // fresh project → walk through the essentials first
  for (;;) {
    const v = guard(await p.select({ message: "What do you want to do?", options: MENU }));
    if (v === "quit") break;
    if (v === "init") runVerb(["init"]);
    else if (v === "add-target") await addTargetFlow();
    else if (v === "add-bundle") await addBundleFlow();
    else if (v === "add-provider") { const n = await setupProvider("Add an LLM provider"); p.note(`"${n}" ready — select it per target in Configure.`, pc.green("provider")); }
    else if (v === "configure") await configureFlow();
    else if (v === "keys") await keysFlow();
    else if (v === "doctor") runVerb(["doctor"]);
    else if (v === "seal") runVerb(["secrets", "seal"]);
    else if (v === "migrate") runVerb(["migrate"]); // DB is shared — not per-target
    else await targetVerb(v); // compile | env-plan | env-push | deploy
  }
  p.outro(pc.cyan("see you, operator."));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
