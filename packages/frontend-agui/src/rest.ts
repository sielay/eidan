// SPDX-License-Identifier: AGPL-3.0-or-later
// Plain CRUD read surface the Next app uses alongside the AG-UI turn stream: conversation list,
// a single conversation, its message history, title edit/regenerate. Reads eidan.* directly
// (RLS-scoped via the ambient principal + an explicit user_id filter). Runs under runAs(principal).
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MatbotServices, Principal, Session, MessageContent } from '@matatbread/matbot-plugin-api';
import { getRegisteredPlugins } from '@matatbread/matbot-core';
import { withPrincipal } from './db.js';

// Structural view of the gdrive plugin's GoogleDrive service (registered under that key; no hard dep).
interface DriveEntryRest { id: string; name: string; mimeType: string }
interface GoogleDriveSvcRest {
  listFolder(ctx: unknown, folderId: string, limit?: number): Promise<DriveEntryRest[]>;
  readFile(ctx: unknown, fileId: string): Promise<{ file: DriveEntryRest; bytes: Uint8Array; mime: string }>;
}
// The fs plugin's reader (serves any fs file's bytes regardless of backend; resolves storage creds
// from the vault) — so the web can read offloaded/Drive files without ever holding those creds.
interface EidanFsRest {
  readBytes(ctx: unknown, nodeId: string): Promise<{ name: string; mime: string; bytes: Uint8Array } | null>;
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v ?? '');
}

function json(res: ServerResponse, code: number, obj: unknown, cors: Record<string, string>): void {
  res.writeHead(code, { 'content-type': 'application/json', ...cors });
  res.end(JSON.stringify(obj));
}

function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function checkJsonDepth(obj: unknown, maxDepth = 10): boolean {
  if (maxDepth < 0) return false;
  if (typeof obj !== 'object' || obj === null) return true;
  for (const val of Object.values(obj)) {
    if (!checkJsonDepth(val, maxDepth - 1)) return false;
  }
  return true;
}

// Raw bytes (for binary uploads like audio). Capped at 25MB — the Whisper API's own per-file limit.
function readRawBody(req: IncomingMessage, maxBytes = 25 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) { reject(new Error('audio too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Map an audio mime to the filename extension Whisper-style endpoints use to detect the codec.
function audioExt(mime: string): string {
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}

// matbot MessageContent[] -> the UI's flat {content, tool_calls, tool_results}.
function mapBlocks(blocks: MessageContent[] | null): {
  content: string | null;
  tool_calls: { id: string; name: string; input: Record<string, unknown> }[];
  tool_results: { tool_use_id: string; content: string; is_error: boolean }[];
} {
  let content = '';
  const tool_calls: { id: string; name: string; input: Record<string, unknown> }[] = [];
  const tool_results: { tool_use_id: string; content: string; is_error: boolean }[] = [];
  for (const b of blocks ?? []) {
    if (b.type === 'text' || b.type === 'refusal') content += b.text;
    else if (b.type === 'tool-call') tool_calls.push({ id: b.id, name: b.name, input: (b.input as Record<string, unknown>) ?? {} });
    else if (b.type === 'tool-result') {
      tool_results.push({ tool_use_id: b.id, content: typeof b.result === 'string' ? b.result : JSON.stringify(b.result), is_error: b.isError === true });
    }
  }
  return { content: content === '' ? null : content, tool_calls, tool_results };
}

function newSession(id: string, ownerId: string): Session {
  const now = new Date().toISOString();
  return { id, version: '0', ownerPrincipalId: ownerId, status: 'active', contexts: [], messages: [], createdAt: now, updatedAt: now };
}

// Fallback only: the configured plugin names, parsed from the host config (services.configPath),
// used when the runtime registry is unavailable. Minimal block parse of the YAML `plugins:` list.
function loadedPlugins(configPath: string | undefined): { name: string; spec: string }[] {
  if (!configPath) return [];
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    return [];
  }
  const out: { name: string; spec: string }[] = [];
  let inPlugins = false;
  for (const raw of text.split('\n')) {
    if (/^plugins:\s*$/.test(raw)) {
      inPlugins = true;
      continue;
    }
    if (!inPlugins) continue;
    if (/^\S/.test(raw)) break; // a new top-level key ends the list
    const m = raw.match(/^\s*-\s*([^#\s]+)/);
    if (m && m[1]) out.push({ spec: m[1], name: basename(m[1].replace(/\/+$/, '')) });
  }
  return out;
}

// ---- plugin catalogue cards -------------------------------------------------
// A rich, per-plugin "card" assembled from what the running engine knows: the loaded plugin's
// manifest (description, config keys), its package.json (version/license/authors), its README.md,
// and the tools it registered. Sourced from the live registry; falls back to the YAML name list.

// 'core' = always-on (CORE_PLUGINS); 'bundle' = an opt-in AGPL thematic bundle (sage/charles/social/
// finance/db/logs); 'matbot' = the vendored engine. (No paid tiers — everything is AGPL.)
type PluginTier = 'core' | 'bundle' | 'matbot';

interface PluginCard {
  name: string; // url-safe short id (basename, no scope) — what the UI routes on
  package_name: string; // full package name, e.g. @eidandev/memory
  display_name: string;
  tier: PluginTier;
  version: string;
  description: string | null;
  license: string | null;
  authors: { name: string; email: string | null }[];
  readme: string | null;
  config_keys: string[];
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
  enabled: boolean;
}

interface LoadedPlugin {
  name: string;
  specifier?: string;
  manifest?: { description?: string; config?: readonly string[] };
}

interface RegistryTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  pluginName?: string;
}

function humanize(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// The live loaded plugins (module-singleton in the runner). Defensive: if the runtime registry
// can't be reached, callers fall back to the YAML name list — no regression, just sparser cards.
function registeredPlugins(): readonly LoadedPlugin[] {
  try {
    return (getRegisteredPlugins() ?? []) as unknown as readonly LoadedPlugin[];
  } catch {
    return [];
  }
}

function readCatalogue(configPath: string | undefined): Record<string, { path?: string }> {
  if (!configPath) return {};
  try {
    return JSON.parse(readFileSync(join(dirname(configPath), 'eidan.catalogue.json'), 'utf8')) as Record<string, { path?: string }>;
  } catch {
    return {};
  }
}

// Walk up from a file/dir to the nearest directory containing package.json (the package root).
function findPackageRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    try {
      readFileSync(join(dir, 'package.json'), 'utf8');
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

// Best-effort resolve of a plugin's on-disk package dir from its load specifier (local path,
// file:// URL, or a catalogue entry). Remote (github:/https:) plugins have no local dir → null,
// so version/license/authors/readme simply stay empty for them.
function pluginDir(specifier: string, configPath: string | undefined, catalogue: Record<string, { path?: string }>): string | null {
  const base = configPath ? dirname(configPath) : undefined;
  const short = basename(specifier.replace(/\/+$/, ''));
  const cat = catalogue[short]?.path;
  if (cat && base) return findPackageRoot(resolvePath(base, cat));
  if (specifier.startsWith('file://')) {
    try {
      return findPackageRoot(fileURLToPath(specifier));
    } catch {
      return null;
    }
  }
  if (/^[./]/.test(specifier) && base) return findPackageRoot(resolvePath(base, specifier));
  return null;
}

function parseAuthors(pkg: Record<string, unknown>): { name: string; email: string | null }[] {
  const norm = (a: unknown): { name: string; email: string | null } | null => {
    if (typeof a === 'string') return { name: a, email: null };
    if (a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string') {
      const o = a as { name: string; email?: unknown };
      return { name: o.name, email: typeof o.email === 'string' ? o.email : null };
    }
    return null;
  };
  const out: { name: string; email: string | null }[] = [];
  const one = norm(pkg.author);
  if (one) out.push(one);
  if (Array.isArray(pkg.contributors)) for (const c of pkg.contributors) { const n = norm(c); if (n) out.push(n); }
  return out;
}

// Rich docs we author IN eidan for plugins that ship no README of their own — notably the
// vendored matbot plugins (we can't edit the Apache submodule). Lives at docs/plugins/<short>.md.
function overlayReadme(base: string | undefined, short: string): string | null {
  if (!base) return null;
  try {
    return readFileSync(join(base, 'docs', 'plugins', `${short}.md`), 'utf8');
  } catch {
    return null;
  }
}

function buildCard(p: LoadedPlugin, tools: readonly RegistryTool[], configPath: string | undefined, catalogue: Record<string, { path?: string }>): PluginCard {
  const base = configPath ? dirname(configPath) : undefined;
  // Short id = the dir basename of the load specifier (stable + url-safe), e.g. ./packages/memory
  // -> "memory", ./external/matbot/packages/plugins/tool-store -> "tool-store".
  const short = basename((p.specifier ?? p.name).replace(/\/+$/, ''));
  const dir = pluginDir(p.specifier ?? p.name, configPath, catalogue);
  let version = '';
  let license: string | null = 'AGPL-3.0-or-later';
  let authors: { name: string; email: string | null }[] = [];
  let pkgDescription: string | null = null;
  let tier: PluginTier = 'core';
  let readme: string | null = null;
  if (dir) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
      if (typeof pkg.version === 'string') version = pkg.version;
      if (typeof pkg.license === 'string') license = pkg.license;
      if (typeof pkg.description === 'string') pkgDescription = pkg.description;
      authors = parseAuthors(pkg);
    } catch { /* no package.json on disk */ }
    try { readme = readFileSync(join(dir, 'README.md'), 'utf8'); } catch { readme = null; }
    if (/external[/\\]matbot[/\\]/.test(dir)) tier = 'matbot';
    else if (/^(?:sage|db|logs|charles-|charlotte-|social-|finance-)/.test(short)) tier = 'bundle';
  }
  if (readme === null) readme = overlayReadme(base, short);
  const owned = tools.filter((t) => t.pluginName === p.name || t.pluginName === short);
  return {
    name: short,
    package_name: p.name,
    display_name: humanize(short),
    tier,
    version,
    description: (p.manifest?.description ?? pkgDescription) ?? null,
    license,
    authors,
    readme,
    config_keys: [...(p.manifest?.config ?? [])],
    tools: owned.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema ?? {} })),
    enabled: true,
  };
}

// The matbot plugins available in the vendored submodule but NOT loaded — surfaced as a browsable
// "available" catalogue (enabled:false). Info from each plugin's package.json (+ overlay README);
// tools are unknown until a plugin is actually loaded, so the list is empty here.
function availableMatbotPlugins(configPath: string | undefined, loadedShort: Set<string>): PluginCard[] {
  const base = configPath ? dirname(configPath) : undefined;
  if (!base) return [];
  const root = join(base, 'external', 'matbot', 'packages', 'plugins');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: PluginCard[] = [];
  for (const short of names.sort()) {
    if (loadedShort.has(short)) continue;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(join(root, short, 'package.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      continue; // not a standalone plugin dir (e.g. frontend/providers/storage)
    }
    let readme: string | null = null;
    try { readme = readFileSync(join(root, short, 'README.md'), 'utf8'); } catch { readme = null; }
    if (readme === null) readme = overlayReadme(base, short);
    out.push({
      name: short,
      package_name: typeof pkg.name === 'string' ? pkg.name : short,
      display_name: humanize(short),
      tier: 'matbot',
      version: typeof pkg.version === 'string' ? pkg.version : '',
      description: typeof pkg.description === 'string' ? pkg.description : null,
      license: typeof pkg.license === 'string' ? pkg.license : 'Apache-2.0',
      authors: parseAuthors(pkg),
      readme,
      config_keys: [],
      tools: [],
      enabled: false,
    });
  }
  return out;
}

function fallbackCard(name: string): PluginCard {
  return {
    name,
    package_name: name,
    display_name: humanize(name),
    tier: 'core',
    version: '',
    description: null,
    license: 'AGPL-3.0-or-later',
    authors: [],
    readme: null,
    config_keys: [],
    tools: [],
    enabled: true,
  };
}

function pluginSummary(c: PluginCard): Record<string, unknown> {
  return { name: c.name, display_name: c.display_name, tier: c.tier, version: c.version, description: c.description, enabled: c.enabled, tool_count: c.tools.length };
}

// Returns true if it owned the route. `parts` is the path split on '/', e.g. ['api','conversations','<id>','messages'].
export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  services: MatbotServices,
  principal: Principal,
  cors: Record<string, string>,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const uid = principal.id;

  // /api/commands — the live tool registry (a matbot tool is the host's notion of a command).
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'commands' && method === 'GET') {
    const tools = services.tools?.list() ?? [];
    json(
      res,
      200,
      {
        commands: tools.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          plugin: t.pluginName ?? null,
          // The JSON input schema lets the authoring UI render a per-tool param form so an agent's
          // tool call can be codified (e.g. job_cursor action=get) instead of left to inference.
          input_schema: t.inputSchema ?? null,
          idempotent: false,
        })),
      },
      cors,
    );
    return true;
  }

  // /api/fs/blob?id=<id> — serve any fs file's bytes (local pg / Supabase / S3 / Drive ref). Runs in
  // the engine under the ambient principal; a {vault} ctx lets the fs reader resolve storage creds, so
  // the web reads offloaded files WITHOUT ever holding the vault. (The web only stores small files
  // directly; everything else streams through here.)
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'fs' && parts[2] === 'blob' && method === 'GET') {
    const efs = (services as unknown as { EidanFs?: EidanFsRest }).EidanFs;
    if (!efs) { json(res, 501, { error: 'filesystem not available' }, cors); return true; }
    const id = new URL(req.url ?? '', 'http://x').searchParams.get('id') ?? '';
    if (!id) { json(res, 400, { error: 'id is required' }, cors); return true; }
    const ctx = { vault: (services as unknown as { vault: unknown }).vault };
    try {
      const r = await efs.readBytes(ctx, id);
      if (!r) { json(res, 404, { error: 'file not found' }, cors); return true; }
      const safe = (r.name || 'file').replace(/[\r\n"]/g, '');
      res.writeHead(200, { 'content-type': r.mime || 'application/octet-stream', 'content-disposition': `inline; filename="${safe}"`, 'cache-control': 'private, no-store', ...cors });
      res.end(Buffer.from(r.bytes));
    } catch (e) {
      json(res, 502, { error: e instanceof Error ? e.message : 'fs read failed' }, cors);
    }
    return true;
  }

  // /api/gdrive/list?folder=<id> — browse the operator's Google Drive live from the Files UI. Runs in
  // the engine (the web can't read the sealed vault) under the ambient principal; a minimal {vault}
  // context drives the GoogleDrive service (registered by the gdrive plugin). 'root' = the Drive root.
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'gdrive' && parts[2] === 'list' && method === 'GET') {
    const drive = (services as unknown as { GoogleDrive?: GoogleDriveSvcRest }).GoogleDrive;
    if (!drive) { json(res, 501, { error: 'Google Drive isn’t connected' }, cors); return true; }
    const folder = new URL(req.url ?? '', 'http://x').searchParams.get('folder') || 'root';
    const ctx = { vault: (services as unknown as { vault: unknown }).vault };
    try {
      const files = await drive.listFolder(ctx, folder, 200);
      const entries = files.map((f) => ({
        id: f.id,
        name: f.name,
        mime: f.mimeType,
        kind: f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
      }));
      json(res, 200, { entries }, cors);
    } catch (e) {
      json(res, 502, { error: e instanceof Error ? e.message : 'Drive list failed' }, cors);
    }
    return true;
  }

  // /api/gdrive/file?id=<id> — stream a Drive file's bytes (Google-native docs export to text/CSV).
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'gdrive' && parts[2] === 'file' && method === 'GET') {
    const drive = (services as unknown as { GoogleDrive?: GoogleDriveSvcRest }).GoogleDrive;
    if (!drive) { json(res, 501, { error: 'Google Drive isn’t connected' }, cors); return true; }
    const fileId = new URL(req.url ?? '', 'http://x').searchParams.get('id') ?? '';
    if (!fileId) { json(res, 400, { error: 'id is required' }, cors); return true; }
    const ctx = { vault: (services as unknown as { vault: unknown }).vault };
    try {
      const { file, bytes, mime } = await drive.readFile(ctx, fileId);
      const safe = (file.name || 'file').replace(/[\r\n"]/g, '');
      res.writeHead(200, { 'content-type': mime || 'application/octet-stream', 'content-disposition': `inline; filename="${safe}"`, 'cache-control': 'private, no-store', ...cors });
      res.end(Buffer.from(bytes));
    } catch (e) {
      json(res, 502, { error: e instanceof Error ? e.message : 'Drive read failed' }, cors);
    }
    return true;
  }

  // /api/providers — the live LLM provider registry. Each matbot provider is one fully-resolved
  // model, so the chat model picker reads this to build its menu from the engine's ACTUAL config:
  // a hardcoded client list silently falls back to the default whenever a name doesn't match
  // (which is how "DeepSeek" ended up running sonnet). No secrets here — just name + model.
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'providers' && method === 'GET') {
    const providers = [...services.providers.entries()].map(([name, cfg]) => ({ name, model: cfg.model ?? '' }));
    json(res, 200, { providers }, cors);
    return true;
  }

  // /api/transcribe (GET) — whether speech-to-text is configured, so the chat can show/hide the mic.
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'transcribe' && method === 'GET') {
    const tr = (services as { Transcribe?: { available(): boolean } }).Transcribe;
    json(res, 200, { available: tr?.available() ?? false }, cors);
    return true;
  }

  // /api/transcribe — speech-to-text for the chat mic button. The raw audio is the request body
  // (content-type = its mime); returns { text }. Delegates to the Transcribe service (narrowed; 501
  // when no STT endpoint/key is configured). No audio is persisted — bytes live only for the call.
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'transcribe' && method === 'POST') {
    const tr = (services as { Transcribe?: { available(): boolean; transcribe(a: Uint8Array, o: { mime: string; filename: string }): Promise<string> } }).Transcribe;
    if (!tr?.available()) { json(res, 501, { error: 'transcription not configured' }, cors); return true; }
    const mime = (req.headers['content-type'] ?? 'audio/webm').split(';')[0]?.trim() || 'audio/webm';
    let bytes: Buffer;
    try { bytes = await readRawBody(req); } catch { json(res, 413, { error: 'audio too large' }, cors); return true; }
    if (bytes.length === 0) { json(res, 400, { error: 'empty audio' }, cors); return true; }
    try {
      const text = await tr.transcribe(new Uint8Array(bytes), { mime, filename: `clip.${audioExt(mime)}` });
      json(res, 200, { text }, cors);
    } catch (e) {
      json(res, 502, { error: e instanceof Error ? e.message : 'transcription failed' }, cors);
    }
    return true;
  }

  // /api/agents/:id/run — manual "run now" (test). Fires the agent's persona as a turn under its own
  // provider and returns the conversation id immediately (the turn runs detached). The @eidandev/agents
  // service is narrowed here so frontend-agui keeps no hard dependency on it (501 if absent).
  if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'agents' && parts[3] === 'run' && method === 'POST') {
    const agents = (services as { Agents?: { runNow?: (agentId: string, userId: string) => Promise<{ conversationId: string } | null> } }).Agents;
    if (!agents?.runNow) { json(res, 501, { error: 'agents run-now unavailable' }, cors); return true; }
    const result = await agents.runNow(parts[2] ?? '', uid);
    if (!result) { json(res, 404, { error: 'agent not found' }, cors); return true; }
    json(res, 200, { conversation_id: result.conversationId }, cors);
    return true;
  }

  // /api/plugins (+ /:name) — rich catalogue cards from the live loaded-plugin set: manifest
  // description, package.json (version/license/authors), README.md, registered tools, config keys.
  if (parts.length >= 2 && parts[0] === 'api' && parts[1] === 'plugins' && method === 'GET') {
    const loaded = registeredPlugins();
    const tools = (services.tools?.list() ?? []) as unknown as readonly RegistryTool[];
    const catalogue = readCatalogue(services.configPath);
    const loadedCards: PluginCard[] =
      loaded.length > 0
        ? loaded.map((p) => buildCard(p, tools, services.configPath, catalogue))
        : loadedPlugins(services.configPath).map((p) => fallbackCard(p.name));
    const loadedShort = new Set(loadedCards.map((c) => c.name));
    // Append the not-loaded matbot plugins as a browsable "available" catalogue (enabled:false).
    const cards: PluginCard[] = [...loadedCards, ...availableMatbotPlugins(services.configPath, loadedShort)];
    if (parts.length === 2) {
      json(res, 200, { node: null, plugins: cards.map(pluginSummary) }, cors);
      return true;
    }
    const card = cards.find((c) => c.name === (parts[2] ?? ''));
    if (!card) {
      json(res, 404, { error: 'not found' }, cors);
      return true;
    }
    json(res, 200, card, cors);
    return true;
  }

  // /api/conversations
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'conversations') {
    if (method === 'GET') {
      // Keyset-paginated + searchable + kind-filtered. Cursor is `before` = the prior page's last
      // coalesce(updated_at,created_at) iso (stable under inserts). `kind`: all | agents | chats
      // (agents = metadata.origin='agent'). `q` = case-insensitive match on title or agent name.
      // Agent-driven conversations get a synthesized "[<slug>] …" title prefix so the client thread
      // filter still classifies them; human chats keep their own title.
      const qp = new URL(req.url ?? '', 'http://x').searchParams;
      const limit = Math.min(Math.max(Number(qp.get('limit')) || 50, 1), 100);
      const before = qp.get('before');
      const beforeStarredStr = qp.get('before_starred');
      const search = (qp.get('q') ?? '').trim();
      const kind = qp.get('kind');
      const conds: string[] = ['user_id = $1', 'deleted_at is null'];
      const vals: unknown[] = [uid];
      if (kind === 'agents') conds.push(`metadata->>'origin' = 'agent'`);
      else if (kind === 'chats') conds.push(`metadata->>'origin' is distinct from 'agent'`);
      if (search) { vals.push(`%${search}%`); conds.push(`(title ilike $${vals.length} or metadata->>'agent_name' ilike $${vals.length})`); }
      if (before != null) {
        const beforeStarredBool = beforeStarredStr === 'true';
        vals.push(beforeStarredBool, before);
        const beforeStarredIdx = vals.length - 1;
        const beforeTimestampIdx = vals.length;
        conds.push(`((starred = false AND $${beforeStarredIdx}::boolean = true) OR (starred = $${beforeStarredIdx}::boolean AND coalesce(updated_at, created_at) < $${beforeTimestampIdx}::timestamptz))`);
      }
      vals.push(limit);
      const r = await withPrincipal(principal, (q) =>
        q(
          `select id,
                  case when metadata->>'origin' = 'agent'
                       then '[' || coalesce(nullif(btrim(lower(regexp_replace(coalesce(metadata->>'agent_name','agent'), '[^a-z0-9]+', '-', 'gi')), '-'), ''), 'agent') || '] '
                            || coalesce(title, metadata->>'agent_name', '')
                       else title end as title,
                  metadata->>'origin' as origin, metadata->>'agent_name' as agent_name,
                  created_at, updated_at, starred
             from eidan.conversations
            where ${conds.join(' and ')}
            order by starred desc, coalesce(updated_at, created_at) desc limit $${vals.length}`,
          vals,
        ),
      );
      const rows = r.rows;
      const last = rows[rows.length - 1] as { updated_at?: unknown; created_at?: unknown; starred?: boolean } | undefined;
      const nextBefore = rows.length === limit && last ? iso(last.updated_at ?? last.created_at) : null;
      // starred is NOT NULL in schema, but be defensive: default to false if missing (should never happen)
      const nextBeforeStarred = rows.length === limit && last ? (last.starred ?? false) : null;
      json(res, 200, {
        conversations: rows.map((row) => ({
          id: row.id, title: row.title ?? null, origin: row.origin ?? null, agent_name: row.agent_name ?? null,
          created_at: iso(row.created_at), updated_at: iso(row.updated_at), starred: row.starred === true,
        })),
        next_before: nextBefore,
        next_before_starred: nextBeforeStarred,
      }, cors);
      return true;
    }
    if (method === 'POST') {
      let title: string | null = null;
      try {
        const b = JSON.parse(await readBody(req, 64 * 1024)) as { title?: string | null };
        if (!checkJsonDepth(b, 10)) throw new Error('body structure too deeply nested');
        title = b.title ?? null;
      } catch { /* empty body ok */ }
      const id = crypto.randomUUID();
      const sessions = services.sessions;
      if (!sessions) { json(res, 500, { error: 'sessions unavailable' }, cors); return true; }
      await sessions.set(id, newSession(id, uid));
      if (title) await withPrincipal(principal, (q) => q('update eidan.conversations set title=$2, updated_at=now() where id=$1 and user_id=$3', [id, title, uid]));
      json(res, 201, { id, title }, cors);
      return true;
    }
  }

  // /api/conversations/:id  and  /api/conversations/:id/(messages|regenerate_title)
  if (parts.length >= 3 && parts[0] === 'api' && parts[1] === 'conversations') {
    const id = parts[2] ?? '';
    const sub = parts[3];

    if (sub === undefined && method === 'GET') {
      const r = await withPrincipal(principal, (q) => q('select id, title, created_at, updated_at, starred from eidan.conversations where id=$1 and user_id=$2 and deleted_at is null', [id, uid]));
      const row = r.rows[0];
      if (!row) { json(res, 404, { error: 'not found' }, cors); return true; }
      json(res, 200, { id: row.id, title: row.title ?? null, created_at: iso(row.created_at), updated_at: iso(row.updated_at), starred: row.starred === true }, cors);
      return true;
    }

    if (sub === undefined && method === 'PATCH') {
      let body: { title?: string | null; starred?: boolean } = {};
      // 64KB limit covers title (typical max ~256 bytes) and starred boolean; sufficient for current schema
      try {
        const parsed = JSON.parse(await readBody(req, 64 * 1024)) as unknown;
        if (!checkJsonDepth(parsed, 10)) { json(res, 400, { error: 'request body structure too deeply nested' }, cors); return true; }
        body = parsed as { title?: string | null; starred?: boolean };
      } catch { /* */ }
      const updates: string[] = ['updated_at=now()'];
      const vals: unknown[] = [id, uid];
      if ('title' in body) { vals.push((body.title ?? '').toString().trim() || null); updates.push(`title=$${vals.length}`); }
      if ('starred' in body) { vals.push(body.starred ?? false); updates.push(`starred=$${vals.length}`); }
      try {
        if (updates.length > 1) await withPrincipal(principal, (q) => q(`update eidan.conversations set ${updates.join(', ')} where id=$1 and user_id=$2`, vals));
      } catch (err) {
        json(res, 500, { error: 'failed to update conversation' }, cors);
        return true;
      }
      const r = await withPrincipal(principal, (q) => q('select title, starred, updated_at from eidan.conversations where id=$1 and user_id=$2', [id, uid]));
      const row = r.rows[0];
      if (!row) { json(res, 404, { error: 'not found' }, cors); return true; }
      json(res, 200, { id, title: row.title ?? null, starred: row.starred === true, updated_at: iso(row.updated_at) }, cors);
      return true;
    }

    if (sub === 'messages' && method === 'GET') {
      const r = await withPrincipal(principal, (q) =>
        q("select id, role, content_blocks, parent_message_id, provider, model, metadata, created_at from eidan.messages where conversation_id=$1 and user_id=$2 and role <> 'marker' and deleted_at is null order by seq asc", [id, uid]),
      );
      const messages = r.rows.map((row) => {
        const m = mapBlocks((row.content_blocks as MessageContent[] | null) ?? null);
        return {
          id: row.id, role: row.role, content: m.content, tool_calls: m.tool_calls, tool_results: m.tool_results,
          parent_message_id: row.parent_message_id ?? null, provider: row.provider ?? null, model: row.model ?? null,
          metadata: (row.metadata as Record<string, unknown> | null) ?? null, created_at: iso(row.created_at),
        };
      });
      json(res, 200, { messages }, cors);
      return true;
    }

    if (sub === 'llm_calls' && method === 'GET') {
      const r = await withPrincipal(principal, (q) =>
        q(
          `select id, message_id, role, provider, model, input_tokens, output_tokens, cache_read_tokens,
                  cache_creation_tokens, cost_usd, latency_ms, error, error_type, request_id,
                  started_at, finished_at, metadata, created_at
             from eidan.llm_calls where conversation_id=$1 and user_id=$2 order by created_at asc`,
          [id, uid],
        ),
      );
      const llm_calls = r.rows.map((row) => ({
        id: row.id,
        message_id: row.message_id ?? null,
        role: (row.role as string | null) ?? '',
        provider: (row.provider as string | null) ?? '',
        model: (row.model as string | null) ?? '',
        input_tokens: Number(row.input_tokens ?? 0),
        output_tokens: Number(row.output_tokens ?? 0),
        cache_read_tokens: Number(row.cache_read_tokens ?? 0),
        cache_creation_tokens: Number(row.cache_creation_tokens ?? 0),
        cost_usd: Number(row.cost_usd ?? 0),
        latency_ms: row.latency_ms ?? null,
        error: row.error ?? null,
        error_type: row.error_type ?? null,
        request_id: row.request_id ?? null,
        started_at: iso(row.started_at),
        finished_at: row.finished_at ? iso(row.finished_at) : null,
        metadata: (row.metadata as Record<string, unknown> | null) ?? {},
        created_at: iso(row.created_at),
      }));
      json(res, 200, { llm_calls }, cors);
      return true;
    }

    if (sub === 'regenerate_title' && method === 'POST') {
      const title = await withPrincipal(principal, async (q) => {
        const r = await q("select content_blocks from eidan.messages where conversation_id=$1 and user_id=$2 and role='user' and deleted_at is null order by seq asc limit 1", [id, uid]);
        const blocks = (r.rows[0]?.content_blocks as MessageContent[] | null) ?? null;
        const text = mapBlocks(blocks).content ?? 'New conversation';
        const t = text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New conversation';
        await q('update eidan.conversations set title=$2, updated_at=now() where id=$1 and user_id=$3', [id, t, uid]);
        return t;
      });
      json(res, 200, { id, title }, cors);
      return true;
    }
  }

  return false;
}
