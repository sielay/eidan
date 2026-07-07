// SPDX-License-Identifier: AGPL-3.0-or-later
// THE catalog of Tier-1 (file) config for an eidan deploy. One place a developer reads to understand
// every env var: what it's for, whether it's required, whether it's a secret, how to generate it,
// and WHICH targets receive it. Values never live here — only the schema. (Tier-2, per-user secrets,
// lives in the DB vault and is set via the UI; it is NOT in this file.)
//
// Targets & where their values live. TARGETS is keyed by the target's TYPE (not its name) — a manifest
// may name targets anything (kesha/backend/frontend); roles are resolved from `targets.<name>.type`:
//   fly         (engine on Fly)         <- root .env      (via `fly secrets`)
//   ssh-node    (engine+worker on a box) <- root .env      (rendered to /etc/eidan/eidan.env)
//   compose[-ssh] (engine+worker, docker) <- root .env
//   vercel      (web/Next.js)           <- apps/web/.env   (set in the Vercel dashboard / `vercel env`)
//
// roles let a key target a group without listing nodes: 'engine' = fly+ssh-node+compose, 'worker' =
// ssh-node+compose (a box that also runs jobs), 'web' = vercel. A role may also be a literal TYPE
// (e.g. 'fly') to pin one kind of node. generate: 'hex:32' | 'base64:48' -> `init` auto-fills it;
// null -> you must paste it. file: which .env a target reads from ('root' for engines, 'web' for web).

export const TARGETS = {
  fly:           { roles: ['engine'],            file: 'root' },
  'ssh-node':    { roles: ['engine', 'worker'],  file: 'root' },
  compose:       { roles: ['engine', 'worker'],  file: 'root' },
  'compose-ssh': { roles: ['engine', 'worker'],  file: 'root' },
  vercel:        { roles: ['web'],               file: 'web'  },
};

export const ENV_SCHEMA = [
  // --- Identity / crypto (required everywhere; the auth trio MUST match across engine + web) -----
  { key: 'DATABASE_URL', roles: ['engine'], required: true, secret: true, generate: null,
    desc: 'Postgres — Supabase transaction pooler (:6543). The engine connection.' },
  { key: 'EIDAN_AUTH_MASTER_KEY', roles: ['engine', 'web'], required: true, secret: true, generate: 'base64:48',
    desc: 'Vault KEK (Fernet) for per-user DB secrets. IDENTICAL on every node; rotating wipes the vault.' },
  { key: 'EIDAN_AUTH_JWT_SECRET', roles: ['engine', 'web'], required: true, secret: true, generate: 'hex:32',
    desc: 'HS256 session-token secret. IDENTICAL on engine + web or tokens won\'t validate across them.' },
  { key: 'EIDAN_AUTH_ALLOWED_EMAIL', roles: ['engine', 'web'], required: true, secret: false, generate: null,
    desc: 'The single operator email allowed to sign in (magic-link gate).' },

  // --- LLM providers (pick yours; the chosen provider's key is required, not a specific one) -------
  { key: 'ANTHROPIC_API_KEY', roles: ['engine'], required: false, secret: true, generate: null, desc: 'Key for the `claude` provider.' },
  { key: 'OPENAI_API_KEY', roles: ['engine'], required: false, secret: true, generate: null, desc: 'Key for the `openai` provider.' },
  { key: 'OPENROUTER_API_KEY', roles: ['engine'], required: false, secret: true, generate: null, desc: 'Key for the `openrouter` provider.' },
  { key: 'XAI_API_KEY', roles: ['engine'], required: false, secret: true, generate: null, desc: 'Key for the `grok` (xAI) provider.' },
  // Voice transcription (@eidandev/transcribe) — any Whisper-compatible /audio/transcriptions endpoint
  // (OpenAI or Groq; NOT OpenRouter, which has no audio API). Powers the chat mic + Telegram voice.
  { key: 'EIDAN_WHISPER_ENDPOINT', roles: ['engine'], required: false, secret: false, generate: null, desc: 'Whisper-compatible transcriptions URL (e.g. https://api.groq.com/openai/v1/audio/transcriptions).' },
  { key: 'EIDAN_WHISPER_MODEL', roles: ['engine'], required: false, secret: false, default: 'whisper-1', desc: 'STT model id (whisper-1 / whisper-large-v3-turbo).' },
  { key: 'EIDAN_WHISPER_KEY', roles: ['engine'], required: false, secret: true, generate: null, desc: 'Bearer key for the transcription endpoint (OpenAI/Groq).' },
  { key: 'EIDAN_PROVIDER', roles: ['engine'], required: false, secret: false, default: 'anthropic',
    desc: 'Legacy provider selector. EIDAN_AGUI_PROVIDER is the matbot chat one.' },
  { key: 'EIDAN_AGUI_PROVIDER', roles: ['engine'], required: false, secret: false, default: 'claude',
    desc: 'Web-chat (AG-UI) + routines provider — must name a provider key in matbot.yaml (claude).' },
  { key: 'EIDAN_DEFAULT_MODEL', roles: ['engine'], required: false, secret: false, default: 'claude-haiku-4-5-20251001',
    desc: 'Default model id.' },
  { key: 'EIDAN_CLASSIFIER_MODEL', roles: ['engine'], required: false, secret: false, default: 'claude-haiku-4-5-20251001',
    desc: 'Classifier model id.' },

  // --- Surfaces / notify -------------------------------------------------------------------------
  { key: 'EIDAN_WEB_URL', roles: ['engine', 'web'], required: true, secret: false, generate: null, derived: true,
    desc: 'Public URL users hit. DERIVED at compile from the web (vercel) target\'s domain — not entered.' },
  { key: 'EIDAN_NOTIFY_ROUTES', roles: ['engine'], required: false, secret: false, default: '',
    desc: 'Topic->channel routing JSON (slack/telegram). Empty = dry-run.' },
  { key: 'TELEGRAM_BOT_TOKEN', roles: ['engine'], required: false, secret: true, generate: null,
    desc: 'Telegram surface bot token (BotFather) — legacy name; EIDAN_TELEGRAM_BOT_TOKEN is canonical. Poll toggle EIDAN_TELEGRAM_POLL is a topology env_set.' },
  { key: 'EIDAN_TELEGRAM_BOT_TOKEN', roles: ['engine'], required: false, secret: true, generate: null,
    desc: 'Telegram surface bot token (BotFather), canonical name. Set via `eidan integrate`. Poll toggle EIDAN_TELEGRAM_POLL is a topology env_set.' },
  { key: 'EIDAN_TELEGRAM_PROVIDER', roles: ['engine'], required: false, secret: false, generate: null,
    desc: 'LLM provider name for Telegram replies (falls back to the first registered provider).' },
  { key: 'EIDAN_TELEGRAM_ALLOWLIST', roles: ['engine'], required: false, secret: false, generate: null,
    desc: 'Optional JSON {"<telegram_id>":"<eidan_principal_id>"} fallback before users /start-link.' },
  { key: 'EIDAN_SLACK_BOT_TOKEN', roles: ['engine'], required: false, secret: true, generate: null,
    desc: 'Slack bot token (xoxb-…, chat:write scope) for outbound notify. Pair with EIDAN_NOTIFY_ROUTES.' },

  // --- SMTP (engine side; optional — without it magic links print to screen) ---------------------
  // SMTP routes to BOTH engine + web: the web (Vercel) is what sends the magic-link mail (apps/web/
  // src/server/mail.ts), so the whole set must reach apps/web/.env, not just the password.
  { key: 'EIDAN_SMTP_HOST', roles: ['engine', 'web'], required: false, secret: false, default: '', desc: 'SMTP host (engine + web magic-link mail). Unset = link shown on the login screen.' },
  { key: 'EIDAN_SMTP_PORT', roles: ['engine', 'web'], required: false, secret: false, default: '587', desc: 'SMTP port.' },
  { key: 'EIDAN_SMTP_USER', roles: ['engine', 'web'], required: false, secret: false, default: '', desc: 'SMTP user.' },
  { key: 'EIDAN_SMTP_PASSWORD', roles: ['engine', 'web'], required: false, secret: true, generate: null, desc: 'SMTP password (engine + web magic-link mail).' },
  { key: 'EIDAN_SMTP_FROM', roles: ['engine', 'web'], required: false, secret: false, default: '', desc: 'SMTP From header.' },

  // --- Logging / runtime flags -------------------------------------------------------------------
  { key: 'EIDAN_LOG_FORWARD_URL', roles: ['engine'], required: false, secret: false, default: '', desc: 'Better Stack ingest URL.' },
  { key: 'EIDAN_LOG_FORWARD_TOKEN', roles: ['engine'], required: false, secret: true, generate: null, desc: 'Better Stack token.' },
  { key: 'EIDAN_LOG_LEVEL', roles: ['engine'], required: false, secret: false, default: 'info', desc: 'Log level.' },
  { key: 'EIDAN_DEPLOYMENT_MODE', roles: ['engine'], required: false, secret: false, default: 'production', desc: 'production|dev.' },
  { key: 'EIDAN_SENTRY_ENABLED', roles: ['engine'], required: false, secret: false, default: '1', desc: 'Amygdala/sentry loop on/off.' },
  { key: 'EIDAN_SIZER_ENABLED', roles: ['engine'], required: false, secret: false, default: '0', desc: 'Context sizer on/off.' },
  { key: 'EIDAN_HTTP_CORS_ORIGINS', roles: ['engine'], required: false, secret: false, derived: true, desc: 'Allowed CORS origins. DERIVED at compile from the target\'s cors.' },

  // --- Worker node only (kesha): sage + jobs + ollama + sentry loop ------------------------------
  { key: 'EIDAN_GH_PATS', roles: ['worker'], required: false, secret: true, generate: null, desc: 'GitHub PAT(s) for sage/gh (plural form the matbot gh plugin reads).' },
  { key: 'EIDAN_CLAUDE_OAUTH_TOKEN', roles: ['worker'], required: false, secret: true, generate: null, desc: 'Claude Code CLI OAuth token for sage (`claude setup-token`).' },
  { key: 'EIDAN_CLAUDE_DEFAULT_MODEL', roles: ['worker'], required: false, secret: false, default: 'claude-haiku-4-5-20251001', desc: 'Sage Claude Code model.' },
  { key: 'OLLAMA_BASE_URL', roles: ['worker'], required: false, secret: false, default: 'http://localhost:11434', desc: 'Local Ollama endpoint.' },
  { key: 'EIDAN_HTTP_HOST', roles: ['worker'], required: false, secret: false, default: '0.0.0.0', desc: 'Engine bind host.' },
  { key: 'EIDAN_HTTP_PORT', roles: ['worker'], required: false, secret: false, default: '8090', desc: 'Engine bind port.' },
  { key: 'EIDAN_OPENAI_TIMEOUT_SECONDS', roles: ['worker'], required: false, secret: false, default: '120', desc: 'Provider request timeout.' },
  { key: 'EIDAN_SENTRY_MODEL', roles: ['worker'], required: false, secret: false, default: 'claude-haiku-4-5-20251001', desc: 'Sentry/amygdala loop model.' },
  { key: 'EIDAN_SENTRY_TICK_INTERVAL', roles: ['worker'], required: false, secret: false, default: 'PT5M', desc: 'Sentry loop interval (ISO-8601 duration).' },
  { key: 'GIT_AUTHOR_NAME', roles: ['worker'], required: false, secret: false, default: 'sage-eidan', desc: 'Sage git author name.' },
  { key: 'GIT_AUTHOR_EMAIL', roles: ['worker'], required: false, secret: false, generate: null, desc: 'Sage git author email.' },
  { key: 'GIT_COMMITTER_NAME', roles: ['worker'], required: false, secret: false, default: 'sage-eidan', desc: 'Sage git committer name.' },
  { key: 'GIT_COMMITTER_EMAIL', roles: ['worker'], required: false, secret: false, generate: null, desc: 'Sage git committer email.' },
  { key: 'EIDAN_JOB_KINDS', roles: ['worker'], required: false, secret: false, derived: true, desc: 'Job kinds this node serves. DERIVED at compile from the target\'s jobs.' },
  { key: 'EIDAN_SAGE_PONYTAIL', roles: ['worker'], required: false, secret: false, default: 'full', desc: 'Sage ponytail activation.' },
  { key: 'MATBOT_A2A_PORT', roles: ['worker'], required: false, secret: false, default: '8095', desc: 'A2A surface port.' },
  { key: 'MATBOT_AGUI_PORT', roles: ['worker'], required: false, secret: false, default: '8090', desc: 'AG-UI surface port.' },
  { key: 'MATBOT_MCP_PORT', roles: ['worker'], required: false, secret: false, default: '8091', desc: 'MCP surface port.' },
  { key: 'MATBOT_PRINCIPAL', roles: ['engine'], required: false, secret: false, generate: null, desc: 'Boot principal (a real eidan.users UUID). engine-wide: detached work (e.g. cognition reindex) runs as the boot principal, so every engine — fly included, not just worker boxes — needs it or it FK-fails (#380).' },

  // --- Fly engine only ---------------------------------------------------------------------------
  { key: 'EIDAN_COMPANIES_HOUSE_KEY', roles: ['fly'], required: false, secret: true, generate: null, desc: 'Companies House API key (ventures bundle).' },

  // --- Object storage: fs large-file offload (S3 / R2 / MinIO). Engine holds the vault; the web tier
  //     offloads through the engine's /api/fs/upload. Unset = files stay in Postgres bytea. ----------
  { key: 'EIDAN_S3_ACCESS_KEY_ID', roles: ['engine'], required: false, secret: true, generate: null, desc: 'S3 access key id for fs offload (AWS S3 / S3-compatible).' },
  { key: 'EIDAN_S3_SECRET_ACCESS_KEY', roles: ['engine'], required: false, secret: true, generate: null, desc: 'S3 secret access key.' },
  { key: 'EIDAN_S3_BUCKET', roles: ['engine'], required: false, secret: false, generate: null, desc: 'S3 bucket name for fs offload.' },
  { key: 'EIDAN_S3_REGION', roles: ['engine'], required: false, secret: false, default: 'us-east-1', desc: 'S3 region (default us-east-1).' },
  { key: 'EIDAN_S3_ENDPOINT', roles: ['engine'], required: false, secret: false, generate: null, desc: 'S3 endpoint for S3-compatible providers (R2/MinIO). Omit for AWS.' },
  { key: 'EIDAN_FS_DIRECT_UPLOAD', roles: ['engine'], required: false, secret: false, default: '0', desc: 'Enable presigned direct-to-S3 browser uploads (needs bucket CORS for the app origin). 1 = on; off = server-side multipart offload.' },

  // --- Web / Vercel (apps/web/.env). Note distinct names + a SEPARATE restricted DB role ---------
  { key: 'NEXT_PUBLIC_EIDAN_BACKEND_URL', roles: ['web'], required: false, secret: false, default: '', desc: 'Browser API base. EMPTY = same-origin (recommended; keeps the auth cookie first-party).' },
  { key: 'NEXT_PUBLIC_APP_URL', roles: ['web'], required: false, secret: false, generate: null, desc: 'Public app URL baked into the browser bundle.' },
  { key: 'EIDAN_ENGINE_URL', roles: ['web'], required: true, secret: false, generate: null, derived: true, desc: 'Where the web proxy forwards auth/chat/conversations. DERIVED at compile from the engine target\'s domain (vercel target\'s `engine` ref).' },
  { key: 'EIDAN_DATABASE_URL', roles: ['web'], required: true, secret: true, generate: null, desc: 'Postgres for the dashboard data routes. Use a SEPARATE restricted role (eidan_app), not the engine superuser.' },
  { key: 'EIDAN_ADMIN_PANELS', roles: ['web'], required: false, secret: false, default: '', desc: 'Admin-panel registry config.' },
];

// The role set for a target, resolved from its TYPE (with the type + optional name added as literal
// pins). `type` defaults to the passed string so callers may pass a type directly (fly/ssh-node/…).
const all = (type, name) => new Set([...(TARGETS[type]?.roles ?? []), type, name].filter(Boolean));

// Keys a target receives (role overlap or pinned by type/name), in schema order. Pass the target's
// TYPE (fly/ssh-node/vercel); `name` is only needed for hypothetical name-pinned roles.
export function keysForTarget(type, name) {
  const roles = all(type, name);
  return ENV_SCHEMA.filter((e) => e.roles.some((r) => roles.has(r)));
}

// Required keys for a target type.
export function requiredForTarget(type, name) {
  // derived keys are required at RUNTIME but filled by the compiler from the manifest, not from .env.
  return keysForTarget(type, name).filter((e) => e.required && !e.derived).map((e) => e.key);
}

// Keys present in the schema for a given file ('root' = engine types, 'web' = vercel).
export function keysForFile(file) {
  const types = Object.entries(TARGETS).filter(([, t]) => t.file === file).map(([ty]) => ty);
  const seen = new Set();
  return ENV_SCHEMA.filter((e) => types.some((ty) => keysForTarget(ty).some((k) => k.key === e.key)))
    .filter((e) => (seen.has(e.key) ? false : seen.add(e.key)));
}

// Keys that live in BOTH the root and web files (the auth trio + EIDAN_WEB_URL/SMTP password) — their
// values MUST be identical across engine + web, since each file is set independently.
export function crossTargetShared() {
  const root = new Set(keysForFile('root').map((e) => e.key));
  const web = new Set(keysForFile('web').map((e) => e.key));
  return ENV_SCHEMA.filter((e) => root.has(e.key) && web.has(e.key)).map((e) => e.key);
}

export function specOf(key) {
  return ENV_SCHEMA.find((e) => e.key === key) ?? null;
}
