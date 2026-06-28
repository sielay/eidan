// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatbotServices, Session, Principal, MessageContent, ProviderConfig } from '@matatbread/matbot-plugin-api';
import { runAs, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { AguiEmitter, lastIdByRole, type AguiEvent } from './agui-emitter.js';
import { handleDevAuth } from './auth-dev.js';
import { proxyToPanel } from './panel-proxy.js';
import { handleRest } from './rest.js';
import { withPrincipal } from './db.js';

// An attachment sent with a turn (base64 payload + mime + filename).
interface TurnAttachment { data?: string; mime?: string; name?: string }

// True for mimes/filenames whose content is human-readable text we can inline into the prompt.
function isTextAttachment(mime: string, name: string): boolean {
  if (mime.startsWith('text/')) return true;
  if (/^application\/(json|xml|x-ndjson|csv|x-yaml|yaml|x-sh|javascript|sql)$/.test(mime)) return true;
  return /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|log|js|ts|tsx|jsx|py|sql|sh|html?|css|toml|ini|env|rs|go|java|rb|c|cpp|h)$/i.test(name);
}

// Build the inbound user-message content from the prompt text + any attachments. Images become image
// blocks (the model sees them via the Anthropic adapter); text-like files are decoded and fenced into
// the prompt so their content is actually read; anything else falls back to a document block (which
// the adapter currently surfaces as a name-only placeholder). The prompt text always comes last so it
// frames the attachments above it.
function buildTurnContent(text: string, attachments?: TurnAttachment[]): MessageContent[] {
  const blocks: MessageContent[] = [];
  for (const a of attachments ?? []) {
    const data = typeof a?.data === 'string' ? a.data : '';
    const mime = typeof a?.mime === 'string' ? a.mime : '';
    if (!data || !mime) continue;
    const name = typeof a?.name === 'string' && a.name ? a.name : 'file';
    if (mime.startsWith('image/')) {
      blocks.push({ type: 'image', data, mimeType: mime } as MessageContent);
    } else if (isTextAttachment(mime, name)) {
      let body = '';
      try { body = Buffer.from(data, 'base64').toString('utf8'); } catch { body = ''; }
      blocks.push({ type: 'text', text: `Attached file "${name}":\n\n\`\`\`\n${body}\n\`\`\`` });
    } else {
      blocks.push({ type: 'document', data, mimeType: mime, name } as MessageContent);
    }
  }
  blocks.push({ type: 'text', text });
  return blocks;
}

// Run ANY model from chat/⑂ Compare, not just configured providers. A client "model token" is either
// the NAME of a configured provider (used as-is) OR an OpenRouter model slug like "openai/gpt-4-turbo",
// synthesized on the fly from an OpenRouter base profile — the same trick agents use to run any model
// without a hand-authored provider. The base is `EIDAN_OPENROUTER_PROVIDER` if set, else the first
// configured provider whose endpoint is openrouter.ai.
function openRouterBase(services: MatbotServices): string | undefined {
  const explicit = process.env['EIDAN_OPENROUTER_PROVIDER'];
  if (explicit && services.providers.get(explicit)) return explicit;
  for (const [name, cfg] of services.providers) {
    if (typeof cfg.endpoint === 'string' && cfg.endpoint.includes('openrouter.ai')) return name;
  }
  return undefined;
}

function synthProvider(services: MatbotServices, baseProvider: string, model: string): string {
  const synthName = `${baseProvider}::${model}`;
  if (!services.providers.has(synthName)) {
    const base = services.providers.get(baseProvider);
    if (!base) return baseProvider;
    // services.providers is a ReadonlyMap at the type level, but the live registry is mutable — agents
    // register per-turn synthesized profiles exactly this way (packages/agents effectiveProvider).
    (services.providers as unknown as Map<string, ProviderConfig>).set(synthName, { ...base, name: synthName, model });
  }
  return synthName;
}

// Resolve a model token → a runnable provider name. `null` = empty token (caller uses the host default).
// `undefined` = a slug we can't run (no OpenRouter base configured) — the caller should 400 rather than
// silently bill the default (the original guardrail, now slug-aware).
function resolveModelToken(services: MatbotServices, token: string | undefined): string | null | undefined {
  if (!token) return null;
  if (services.providers.get(token)) return token;
  const base = openRouterBase(services);
  if (!base) return undefined;
  return synthProvider(services, base, token);
}

// ── @-mention resolution ──────────────────────────────────────────────────────────────────────────
// The composer/markdown editors insert resolvable tokens `[label](eidan:type:id)` for files, folders,
// agents, ventures and assets. At turn time we expand each into real context (a file's contents, an
// agent's persona, a venture/asset descriptor) and inject it as EPHEMERAL context for the model — the
// persisted user message keeps the readable link, the model gets the substance. Owner-scoped via the
// ambient principal; missing optional tables (ventures bundle) just yield nothing for that mention.
const MENTION_RE = /\[([^\]]+)\]\(eidan:(file|folder|agent|venture|asset):([^)\s]+)\)/g;
const MENTION_TEXT_BUDGET = 24_000; // cap total injected chars so a big file can't blow the context

function parseMentions(text: string): Array<{ kind: string; id: string; label: string }> {
  const out: Array<{ kind: string; id: string; label: string }> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const key = `${m[2]}:${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: m[1] ?? '', kind: m[2] ?? '', id: m[3] ?? '' });
  }
  return out;
}

const TEXTISH = /^(text\/|application\/(json|xml|x-yaml|yaml|toml|x-sh|javascript|typescript))/;

async function resolveMentions(principal: Principal, mentions: Array<{ kind: string; id: string; label: string }>): Promise<string | null> {
  if (!mentions.length) return null;
  const uid = principal.id;
  const sections: string[] = [];
  let budget = MENTION_TEXT_BUDGET;
  for (const m of mentions) {
    try {
      const section = await withPrincipal(principal, async (q): Promise<string | null> => {
        if (m.kind === 'file') {
          const r = await q(`select n.name, n.mime, n.storage_kind, b.data from plugin_fs.fs_nodes n left join plugin_fs.fs_blobs b on b.node_id = n.id where n.id = $1 and n.user_id = $2 and n.status = 'active'`, [m.id, uid]);
          const row = r.rows[0] as { name?: string; mime?: string; storage_kind?: string; data?: Buffer } | undefined;
          if (!row) return null;
          if (row.storage_kind === 'local' && row.data && TEXTISH.test(String(row.mime ?? ''))) {
            const body = Buffer.from(row.data).toString('utf8').slice(0, budget);
            return `### File: ${row.name ?? m.label}\n\`\`\`\n${body}\n\`\`\``;
          }
          return `### File: ${row.name ?? m.label}\n(binary or offloaded file — use fs tools to read it if needed)`;
        }
        if (m.kind === 'folder') {
          const r = await q(`select name, kind from plugin_fs.fs_nodes where parent_id = $1 and user_id = $2 and status = 'active' order by (kind='folder') desc, name limit 100`, [m.id, uid]);
          const listing = r.rows.map((x) => `- ${(x as { kind?: string }).kind === 'folder' ? '📁' : '📄'} ${(x as { name?: string }).name ?? ''}`).join('\n');
          return `### Folder: ${m.label}\n${listing || '(empty)'}`;
        }
        if (m.kind === 'agent') {
          const r = await q(`select coalesce(nullif(display_name,''), name) as label, description, persona from eidan.agents where id = $1 and user_id = $2 and deleted_at is null`, [m.id, uid]);
          const row = r.rows[0] as { label?: string; description?: string; persona?: string } | undefined;
          if (!row) return null;
          return `### Agent: ${row.label ?? m.label}\n${row.description ?? ''}\n${row.persona ? `Persona: ${String(row.persona).slice(0, 2000)}` : ''}`.trim();
        }
        if (m.kind === 'venture') {
          const r = await q(`select name, slug, status from plugin_ventures.ventures where id = $1 and user_id = $2`, [m.id, uid]);
          const row = r.rows[0] as { name?: string; slug?: string; status?: string } | undefined;
          return row ? `### Venture: ${row.name ?? m.label}\nstatus: ${row.status ?? 'active'}${row.slug ? `, slug: ${row.slug}` : ''}` : null;
        }
        if (m.kind === 'asset') {
          const r = await q(`select coalesce(nullif(label,''), kind) as label, kind from plugin_ventures.venture_resources where id = $1 and user_id = $2`, [m.id, uid]);
          const row = r.rows[0] as { label?: string; kind?: string } | undefined;
          return row ? `### Asset: ${row.label ?? m.label}\nkind: ${row.kind ?? ''}` : null;
        }
        return null;
      });
      if (section) { sections.push(section); budget -= section.length; if (budget <= 0) break; }
    } catch {
      /* optional table absent or row gone — skip this mention */
    }
  }
  if (!sections.length) return null;
  return `The user's message references these items (resolved for you — they appear as @links in the message):\n\n${sections.join('\n\n')}`;
}

// Truncation marker appended to responses that reached token limit.
const TRUNCATION_MARKER = '_[Response was truncated at token limit]_';

// Fork-and-merge: the ephemeral briefing the judge turn sees (prepended, never persisted). It carries
// the user's prompt plus each candidate model's answer, and asks the judge to emit the single best
// merged answer followed by a "## Model comparison" section. Kept out of the persisted user/assistant
// messages so the conversation reads cleanly: clean prompt in, merged answer out.
// Includes truncation markers if any responses were cut off.
function buildJudgeBriefing(prompt: string, legs: Array<{ model: string; text: string; truncated?: boolean }>): string {
  const candidates = legs.map((l, i) => {
    const truncMarker = l.truncated ? `\n\n${TRUNCATION_MARKER}` : '';
    return `### Candidate ${i + 1} — ${l.model}\n${l.text}${truncMarker}`;
  }).join('\n\n');
  return [
    `${legs.length} different models each answered the user's request below. Your job is to judge them and merge the best result.`,
    ``,
    `<request>\n${prompt}\n</request>`,
    ``,
    `Candidate answers:`,
    ``,
    candidates,
    ``,
    `Now write the single best answer to the request: synthesise the strongest parts of each candidate and correct any mistakes. Prefer complete answers over truncated ones. This merged answer is what the user sees, so write it directly — do NOT say "candidate" or "model" in it.`,
    `After the answer, add a section titled exactly "## Model comparison": one bullet per model (use the model names shown above) summarising its take in a few words, then a final line in bold "**Strongest:** <model> — <one-line why>".`,
  ].join('\n');
}

// The per-request identity seam (same key matbot's frontend-web uses): an auth plugin registers a
// resolver that derives the Principal from the request (e.g. a Bearer JWT). Absent ⇒ boot principal.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    WebPrincipalResolver?: (req: IncomingMessage) => Principal | Promise<Principal>;
  }
}

// The LLM cost ledger (declared by @eidandev/llm-calls; re-declared here, the matbot pattern, to
// stay decoupled). Recorded per usage event; absent ⇒ no telemetry.
interface LlmCall {
  userId: string; conversationId?: string; messageId?: string; provider: string; model: string;
  inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number;
  costUsd?: number; requestId?: string; role?: string;
}
interface LlmCalls { record(call: LlmCall): Promise<void> }
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    LlmCalls?: LlmCalls;
  }
}

// Credentialed CORS for the cross-origin Next app: echo the request Origin (a literal `*` is
// rejected by browsers once credentials:'include' is set) and allow credentials so the refresh
// cookie + Authorization header flow.
function corsFor(req: IncomingMessage): Record<string, string> {
  const origin = req.headers['origin'];
  return {
    'access-control-allow-origin': typeof origin === 'string' && origin ? origin : '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
    vary: 'Origin',
  };
}

function newSession(id: string, ownerId: string): Session {
  const now = new Date().toISOString();
  return { id, version: '0', ownerPrincipalId: ownerId, status: 'active', contexts: [], messages: [], createdAt: now, updatedAt: now };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function json(res: ServerResponse, code: number, obj: unknown, cors: Record<string, string>): void {
  res.writeHead(code, { 'content-type': 'application/json', ...cors });
  res.end(JSON.stringify(obj));
}
function sse(res: ServerResponse, ev: AguiEvent): void {
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

// Starts the AG-UI + REST HTTP server. Public routes (health, /api/auth/*) bypass auth; everything
// else resolves a Principal (boot if no resolver) and runs under it.
export function startAguiServer(services: MatbotServices, port: number, provider: string, boot: Principal): () => void {
  const server = createServer((req, res) => {
    void route(req, res, services, provider, boot).catch((e: unknown) => {
      if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) }, corsFor(req));
      else res.end();
    });
  });
  server.listen(port);
  return () => server.close();
}

async function route(req: IncomingMessage, res: ServerResponse, services: MatbotServices, provider: string, boot: Principal): Promise<void> {
  const cors = corsFor(req);
  const method = req.method ?? 'GET';
  const pathname = (req.url ?? '/').split('?')[0] ?? '/';

  if (method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (method === 'GET' && pathname === '/health') { json(res, 200, { ok: true }, cors); return; }

  // Public, unauthenticated identity endpoints (dev-only; no-op when EIDAN_DEV_AUTH≠1).
  if (await handleDevAuth(req, res, pathname, cors)) return;

  // Reverse-proxy registered plugin panels (the secrets-api, bundle panel servers) to their internal
  // loopback ports. Runs BEFORE principal resolution: the target self-authenticates the Bearer via
  // the same shared WebPrincipalResolver, so we stream the request through untouched.
  const panel = services.PanelProxy?.match(pathname);
  if (panel) { proxyToPanel(req, res, panel.port, cors); return; }

  // Authenticated: resolve the per-request principal. If an auth plugin registered a resolver, it
  // is authoritative (throws → 401). With NO resolver we fail CLOSED in production — falling back to
  // the boot principal is opt-in (headless/dev), so a failed/absent auth plugin can't silently serve
  // every request as the boot user.
  let principal: Principal;
  try {
    const resolver = services.WebPrincipalResolver;
    if (resolver) {
      principal = await resolver(req);
    } else if (process.env['EIDAN_DEV_AUTH'] === '1' || process.env['EIDAN_ALLOW_BOOT_PRINCIPAL'] === '1') {
      principal = tryCurrentPrincipal() ?? boot;
    } else {
      json(res, 401, { error: 'authentication not configured' }, cors);
      return;
    }
  } catch (e) {
    json(res, 401, { error: e instanceof Error ? e.message : 'unauthorized' }, cors);
    return;
  }
  await runAs(principal, () => handle(req, res, services, provider, principal, cors, pathname));
}

async function handle(req: IncomingMessage, res: ServerResponse, services: MatbotServices, provider: string, principal: Principal, cors: Record<string, string>, pathname: string): Promise<void> {
  const method = req.method ?? 'GET';

  // POST /api/turn — run a turn on conversation_id and stream AG-UI events (the chat surface).
  if (method === 'POST' && pathname === '/api/turn') {
    const sessions = services.sessions;
    const run = services.run;
    if (!sessions || !run) { json(res, 500, { error: 'runner/sessions unavailable' }, cors); return; }

    let body: { conversation_id?: string; text?: string; provider?: string; attachments?: TurnAttachment[]; compare?: string[] };
    try { body = JSON.parse(await readBody(req)) as typeof body; }
    catch { json(res, 400, { error: 'invalid JSON' }, cors); return; }
    const conversationId = body.conversation_id;
    const text = body.text;
    if (!conversationId || typeof text !== 'string') { json(res, 400, { error: 'conversation_id and text required' }, cors); return; }
    // Per-turn model: an absent/empty `provider` means "use the host default" (EIDAN_AGUI_PROVIDER).
    // But if the client EXPLICITLY names a provider that isn't configured, FAIL the turn — do NOT
    // silently substitute the host default. Silent substitution is how a stale client pick (a renamed
    // or removed provider) kept billing the default model (sonnet) without consent. Each provider in
    // matbot.yaml is one model, so selecting a provider = selecting a model.
    // Resolve the per-turn model: a configured provider name OR an OpenRouter slug (synthesized on the
    // fly). Empty ⇒ host default. A slug with no OpenRouter base configured fails loudly rather than
    // silently billing the default (the original guardrail, now catalogue-aware).
    let turnProvider = provider;
    if (body.provider) {
      const resolved = resolveModelToken(services, body.provider);
      if (resolved === undefined) { json(res, 400, { error: `Can't run "${body.provider}" — not a configured provider, and no OpenRouter base is set up to run it as a model.` }, cors); return; }
      turnProvider = resolved ?? provider;
    }

    // Fork-and-merge (the "⑂ Compare" composer mode): `compare` names ≥2 configured providers to race
    // the prompt against in parallel; THIS turn then runs the judge (turnProvider) to synthesise the
    // single best merged answer + a comparison. Validate candidates up-front (same rule as the per-turn
    // provider — each provider is one model) so a stale pick fails before the stream opens.
    const compareTokens = Array.isArray(body.compare)
      ? Array.from(new Set(body.compare.filter((m): m is string => typeof m === 'string' && m.length > 0)))
      : [];
    const compareModels: string[] = [];
    for (const m of compareTokens) {
      const resolved = resolveModelToken(services, m);
      if (resolved === undefined) { json(res, 400, { error: `Can't compare "${m}" — no OpenRouter base configured to run it.` }, cors); return; }
      if (resolved && !compareModels.includes(resolved)) compareModels.push(resolved);
    }
    const doFork = compareModels.length >= 2 && typeof services.singleTurn === 'function';

    let session = await sessions.get(conversationId);
    if (!session) { session = newSession(conversationId, principal.id); await sessions.set(conversationId, session); }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...cors });
    const emitter = new AguiEmitter(conversationId);
    for (const e of emitter.start()) sse(res, e);

    // The resolved Compare legs, persisted onto the merged assistant message once the judge turn commits
    // (so the chat can show a disclosure of each model's raw answer alongside the merge).
    // Each leg includes token usage and truncation status.
    let forkLegs: Array<{ model: string; text: string; truncated?: boolean; inputTokens?: number; outputTokens?: number }> = [];

    // Run the fork candidates (one-shot completions — no session, no junk conversations) and arm a
    // one-shot `screen` hook that injects them as EPHEMERAL context for the judge turn below. Ephemeral
    // = prepended to this turn's model calls, never persisted and elided from history — so the user
    // message stays the clean prompt and the assistant message is the merge. The hook self-removes on
    // fire (filtered to this conversation) and expires after 60s if the turn never reaches `screen`.
    // If <2 candidates resolve, we silently fall back to a plain judge turn (a normal answer).
    if (doFork && services.singleTurn) {
      const singleTurn = services.singleTurn.bind(services);
      const legLedger = services.LlmCalls;
      // Request responses with a generous token budget to avoid mid-sentence truncation; the judge
      // can handle longer context and will synthesize it down to the best answer.
      const maxTokens = 4000;
      const settled = await Promise.allSettled(compareModels.map(async (m) => {
        const resp = await singleTurn({ provider: m, prompt: text, maxTokens });
        const legModel = services.providers.get(m)?.model ?? m;
        // Detect truncation via stop_reason from the provider (most reliable signal).
        // Avoid string heuristics ('[truncated]', '...') which can produce false positives.
        const respText = typeof resp?.text === 'string' ? resp.text : '';
        const stopReason = typeof resp?.stopReason === 'string' ? resp.stopReason : undefined;
        const truncated = stopReason === 'length';
        // Pass the raw response text; buildJudgeBriefing appends the truncation marker based on the flag
        const text_ = respText;
        // Record each compare leg in the cost ledger (role='compare_leg') so the trace/cost rollup
        // counts them — they run outside the streamed turn, so they weren't being recorded before.
        if (legLedger && resp?.usage) {
          void legLedger.record({
            userId: principal.id, conversationId, provider: m, model: legModel, role: 'compare_leg',
            inputTokens: resp.usage.inputTokens, outputTokens: resp.usage.outputTokens,
          });
        }
        return { model: legModel, text: text_, truncated, inputTokens: resp?.usage?.inputTokens, outputTokens: resp?.usage?.outputTokens };
      }));
      const legs = settled.flatMap((r) => (r.status === 'fulfilled' && r.value.text !== undefined && r.value.text !== null ? [r.value] : []));
      if (legs.length >= 2) {
        forkLegs = legs;
        const briefing = buildJudgeBriefing(text, legs);
        const armedAt = Date.now();
        let fired = false;
        services.hooks.register({
          on: 'screen',
          priority: 1,
          handler(ctx) {
            if (fired || ctx.session.id !== conversationId) {
              if (Date.now() - armedAt > 60_000) ctx.removeHook();
              return;
            }
            fired = true;
            ctx.removeHook();
            return { ephemeral: [{ type: 'text', text: briefing }] };
          },
        });
      }
    }

    // @-mention resolution: expand any `[label](eidan:type:id)` tokens in the message into ephemeral
    // context for the model (the persisted user message keeps the readable links). One-shot screen hook,
    // same mechanism as the fork briefing; self-removes on fire and expires after 60s.
    const mentionBriefing = await resolveMentions(principal, parseMentions(text));
    if (mentionBriefing) {
      const armedAt = Date.now();
      let fired = false;
      services.hooks.register({
        on: 'screen',
        priority: 1,
        handler(ctx) {
          if (fired || ctx.session.id !== conversationId) {
            if (Date.now() - armedAt > 60_000) ctx.removeHook();
            return;
          }
          fired = true;
          ctx.removeHook();
          return { ephemeral: [{ type: 'text', text: mentionBriefing }] };
        },
      });
    }

    const ac = new AbortController();
    req.on('close', () => ac.abort());
    try {
      const view = await run.open({ sessionId: conversationId, signal: ac.signal, content: buildTurnContent(text, body.attachments), provider: turnProvider, principal });
      const ledger = services.LlmCalls;
      const model = services.providers.get(turnProvider)?.model ?? '';
      // The turn's user-message id isn't known until the turn commits (its `done`/`aborted` event
      // carries the session), but usage events arrive mid-turn — so buffer them and stamp the id on
      // flush. message_id keys the per-turn cost rollup (`/api/cost/summary?scope=turn`); without it
      // the turn counter can never resolve a row. lastIdByRole reads the SAME id the emitter reports
      // to the client as `user_message_id`, so the recorded key matches the one the client queries.
      const pendingUsage: Array<Omit<LlmCall, 'userId' | 'conversationId' | 'messageId' | 'provider' | 'model'>> = [];
      const flushUsage = (messageId?: string): void => {
        if (!ledger) { pendingUsage.length = 0; return; }
        for (const u of pendingUsage) {
          void ledger.record({
            userId: principal.id, conversationId, provider: turnProvider, model, ...u,
            ...(messageId ? { messageId } : {}),
          });
        }
        pendingUsage.length = 0;
      };
      try {
        for await (const ev of view.events) {
          if (ev.type === 'idle') continue;
          if ('traceId' in ev && ev.traceId !== view.traceId) continue;
          if (ev.type === 'usage') {
            pendingUsage.push({
              inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, requestId: ev.traceId,
              ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
              ...(ev.cacheCreationTokens !== undefined ? { cacheCreationTokens: ev.cacheCreationTokens } : {}),
              ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}),
            });
          }
          if (ev.type === 'done' || ev.type === 'aborted') flushUsage(lastIdByRole(ev.session, 'user'));
          // Fork-and-merge: stamp the candidate legs onto the just-committed assistant message so the chat
          // can render a "compared N models" disclosure. metadata is a denormalised column (the session is
          // reconstructed from content_blocks), so patching it post-commit doesn't disturb the store.
          if (ev.type === 'done' && forkLegs.length >= 2) {
            const asstId = lastIdByRole(ev.session, 'assistant');
            if (asstId) {
              void withPrincipal(principal, (q) => q(
                `update eidan.messages set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{fork}', $2::jsonb, true) where id=$1 and user_id=$3`,
                [asstId, JSON.stringify({ legs: forkLegs }), principal.id],
              )).catch(() => { /* disclosure is best-effort; the merged answer still stands */ });
            }
          }
          for (const a of emitter.map(ev)) sse(res, a);
          if (ev.type === 'done' || ev.type === 'error' || ev.type === 'aborted' || ev.type === 'cancelled') break;
        }
      } finally {
        // error/cancelled (and any stream break) carry no committed session — still record the
        // usage so session/day rollups stay accurate; only the per-turn attribution is dropped.
        flushUsage();
      }
    } catch (e) {
      for (const a of emitter.error(e instanceof Error ? e.message : String(e))) sse(res, a);
    }
    res.end();
    return;
  }

  // Conversation CRUD + message history (plain REST reads, RLS-scoped).
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (await handleRest(req, res, parts, services, principal, cors)) return;

  json(res, 404, { error: 'not found' }, cors);
}
