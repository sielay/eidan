// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatbotServices, Session, Principal } from '@matatbread/matbot-plugin-api';
import { runAs, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { AguiEmitter, type AguiEvent } from './agui-emitter.js';
import { handleDevAuth } from './auth-dev.js';
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
  userId: string; conversationId?: string; provider: string; model: string;
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

    let body: { conversation_id?: string; text?: string };
    try { body = JSON.parse(await readBody(req)) as typeof body; }
    catch { json(res, 400, { error: 'invalid JSON' }, cors); return; }
    const conversationId = body.conversation_id;
    const text = body.text;
    if (!conversationId || typeof text !== 'string') { json(res, 400, { error: 'conversation_id and text required' }, cors); return; }

    let session = await sessions.get(conversationId);
    if (!session) { session = newSession(conversationId, principal.id); await sessions.set(conversationId, session); }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...cors });
    const emitter = new AguiEmitter(conversationId);
    for (const e of emitter.start()) sse(res, e);

    const ac = new AbortController();
    req.on('close', () => ac.abort());
    try {
      const view = await run.open({ sessionId: conversationId, signal: ac.signal, content: [{ type: 'text', text }], provider, principal });
      const ledger = services.LlmCalls;
      const model = services.providers.get(provider)?.model ?? '';
      for await (const ev of view.events) {
        if (ev.type === 'idle') continue;
        if ('traceId' in ev && ev.traceId !== view.traceId) continue;
        if (ev.type === 'usage' && ledger) {
          void ledger.record({
            userId: principal.id, conversationId, provider, model,
            inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, requestId: ev.traceId,
            ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
            ...(ev.cacheCreationTokens !== undefined ? { cacheCreationTokens: ev.cacheCreationTokens } : {}),
            ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}),
          });
        }
        for (const a of emitter.map(ev)) sse(res, a);
        if (ev.type === 'done' || ev.type === 'error' || ev.type === 'aborted' || ev.type === 'cancelled') break;
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
