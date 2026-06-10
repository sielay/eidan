// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatbotServices, Session, Principal } from '@matatbread/matbot-plugin-api';
import { runAs, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { AguiEmitter, type AguiEvent } from './agui-emitter.js';

// The Next.js app on Vercel calls this cross-origin; allow it (tighten to the app origin later).
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

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
function json(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(obj));
}
function sse(res: ServerResponse, ev: AguiEvent): void {
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

// Starts the AG-UI HTTP server. Each request runs under its principal (boot for now; a
// WebPrincipalResolver/JWT plugin can derive a real per-request identity later).
export function startAguiServer(services: MatbotServices, port: number, provider: string, boot: Principal): () => void {
  const server = createServer((req, res) => {
    const principal = tryCurrentPrincipal() ?? boot;
    void runAs(principal, () => handle(req, res, services, provider, principal)).catch((e: unknown) => {
      if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  });
  server.listen(port);
  return () => server.close();
}

async function handle(req: IncomingMessage, res: ServerResponse, services: MatbotServices, provider: string, principal: Principal): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  if (method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (method === 'GET' && url === '/health') { json(res, 200, { ok: true }); return; }

  const sessions = services.sessions;
  const run = services.run;
  if (!sessions || !run) { json(res, 500, { error: 'runner/sessions unavailable' }); return; }

  // POST /api/conversations — create a session, return { id }. (Non-LLM; the Next app may also
  // do this read/write directly against Postgres — this is here so the engine is testable standalone.)
  if (method === 'POST' && url === '/api/conversations') {
    const session = newSession(crypto.randomUUID(), principal.id);
    await sessions.set(session.id, session);
    json(res, 201, { id: session.id });
    return;
  }

  // POST /api/turn — run a turn on conversation_id and stream AG-UI events (the chat surface).
  if (method === 'POST' && url === '/api/turn') {
    let body: { conversation_id?: string; text?: string };
    try { body = JSON.parse(await readBody(req)) as typeof body; }
    catch { json(res, 400, { error: 'invalid JSON' }); return; }
    const conversationId = body.conversation_id;
    const text = body.text;
    if (!conversationId || typeof text !== 'string') { json(res, 400, { error: 'conversation_id and text required' }); return; }

    let session = await sessions.get(conversationId);
    if (!session) { session = newSession(conversationId, principal.id); await sessions.set(conversationId, session); }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS });
    const emitter = new AguiEmitter(conversationId);
    for (const e of emitter.start()) sse(res, e);

    const ac = new AbortController();
    req.on('close', () => ac.abort());
    try {
      const view = await run.open({ sessionId: conversationId, signal: ac.signal, content: [{ type: 'text', text }], provider, principal });
      for await (const ev of view.events) {
        if (ev.type === 'idle') continue;
        if ('traceId' in ev && ev.traceId !== view.traceId) continue;
        for (const a of emitter.map(ev)) sse(res, a);
        if (ev.type === 'done' || ev.type === 'error' || ev.type === 'aborted' || ev.type === 'cancelled') break;
      }
    } catch (e) {
      for (const a of emitter.error(e instanceof Error ? e.message : String(e))) sse(res, a);
    }
    res.end();
    return;
  }

  json(res, 404, { error: 'not found' });
}
