// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatbotServices, Session, Principal } from '@matatbread/matbot-plugin-api';
import { runAs, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { AguiEmitter, lastIdByRole, type AguiEvent } from './agui-emitter.js';
import { handleDevAuth } from './auth-dev.js';
import { proxyToPanel } from './panel-proxy.js';
import { handleRest } from './rest.js';

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

    let body: { conversation_id?: string; text?: string; provider?: string };
    try { body = JSON.parse(await readBody(req)) as typeof body; }
    catch { json(res, 400, { error: 'invalid JSON' }, cors); return; }
    const conversationId = body.conversation_id;
    const text = body.text;
    if (!conversationId || typeof text !== 'string') { json(res, 400, { error: 'conversation_id and text required' }, cors); return; }
    // Per-turn model: the client may name a provider; honour it only if it's actually configured,
    // else fall back to the server default (EIDAN_AGUI_PROVIDER). Each provider in matbot.yaml is
    // one model, so selecting a provider = selecting a model.
    const turnProvider = body.provider && services.providers.get(body.provider) ? body.provider : provider;

    let session = await sessions.get(conversationId);
    if (!session) { session = newSession(conversationId, principal.id); await sessions.set(conversationId, session); }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...cors });
    const emitter = new AguiEmitter(conversationId);
    for (const e of emitter.start()) sse(res, e);

    const ac = new AbortController();
    req.on('close', () => ac.abort());
    try {
      const view = await run.open({ sessionId: conversationId, signal: ac.signal, content: [{ type: 'text', text }], provider: turnProvider, principal });
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
            userId: principal.id, conversationId, provider, model, ...u,
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
