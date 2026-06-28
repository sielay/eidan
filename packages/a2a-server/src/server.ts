// SPDX-License-Identifier: AGPL-3.0-or-later
// Inbound A2A server — exposes eidan as an A2A agent. Public agent card at
// GET /.well-known/agent-card.json; JSON-RPC 2.0 message/send at POST /a2a runs a turn and returns
// a Task. Mirrors the MCP server (a2a is also JSON-RPC/HTTP) and reuses the WebPrincipalResolver.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatbotServices, Principal, Session, MessageContent } from '@matatbread/matbot-plugin-api';
import { runAs, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { agentCard } from './a2a-card.js';

interface LlmCall {
  userId: string; conversationId?: string; messageId?: string; provider: string; model: string;
  inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number;
  costUsd?: number; requestId?: string; role?: string;
}
interface LlmCalls { record(call: LlmCall): Promise<void> }
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    WebPrincipalResolver?: (req: IncomingMessage) => Principal | Promise<Principal>;
    LlmCalls?: LlmCalls;
  }
}

export interface A2AOpts { port: number; provider: string; name: string; description: string; url: string }

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function newSession(id: string, ownerId: string): Session {
  const now = new Date().toISOString();
  return { id, version: '0', ownerPrincipalId: ownerId, status: 'active', contexts: [], messages: [], createdAt: now, updatedAt: now };
}
function lastAssistantText(s: Session): string {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m && m.role === 'assistant') {
      return m.content.filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text').map((c) => c.text).join('\n');
    }
  }
  return '';
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


export function startA2AServer(services: MatbotServices, opts: A2AOpts, boot: Principal): () => void {
  const server = createServer((req, res) => {
    void handle(req, res, services, opts, boot).catch((e: unknown) => {
      if (!res.headersSent) json(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
      else res.end();
    });
  });
  server.listen(opts.port);
  return () => server.close();
}

async function handle(req: IncomingMessage, res: ServerResponse, services: MatbotServices, opts: A2AOpts, boot: Principal): Promise<void> {
  const url = (req.url ?? '/').split('?')[0] ?? '/';
  const method = req.method ?? 'GET';
  if (method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  // The agent card is public (discovery) — no auth.
  if (method === 'GET' && (url === '/.well-known/agent-card.json' || url === '/.well-known/agent.json')) { json(res, 200, agentCard(opts)); return; }
  if (method !== 'POST') { json(res, 405, { error: 'POST only' }); return; }

  let principal: Principal;
  try {
    const resolver = services.WebPrincipalResolver;
    principal = resolver ? await resolver(req) : (tryCurrentPrincipal() ?? boot);
  } catch { json(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }); return; }

  let rpc: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try { rpc = JSON.parse(await readBody(req)) as typeof rpc; }
  catch { json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
  const id = rpc.id ?? null;

  if (rpc.method === 'message/send') { await messageSend(res, services, opts, principal, id, rpc.params ?? {}); return; }
  json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${rpc.method ?? ''}` } });
}

async function messageSend(res: ServerResponse, services: MatbotServices, opts: A2AOpts, principal: Principal, id: unknown, params: Record<string, unknown>): Promise<void> {
  const run = services.run;
  const sessions = services.sessions;
  if (!run || !sessions) { json(res, 200, { jsonrpc: '2.0', id, error: { code: -32603, message: 'runner/sessions unavailable' } }); return; }

  const taskId = typeof params['taskId'] === 'string' ? (params['taskId'] as string) : crypto.randomUUID();
  const message = (params['message'] ?? {}) as { parts?: Array<{ type?: string; text?: string }> };
  let text = '';
  for (const p of message.parts ?? []) { if (p.type === 'text' && typeof p.text === 'string') { text = p.text; break; } }
  if (!text) { json(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'message must contain a text part' } }); return; }

  // A2A task ↔ eidan conversation: use the taskId as the session id (continuation reuses the task).
  await runAs(principal, async () => {
    let session = await sessions.get(taskId);
    if (!session) { session = newSession(taskId, principal.id); await sessions.set(taskId, session); }
    const ac = new AbortController();
    const view = await run.open({ sessionId: taskId, signal: ac.signal, content: [{ type: 'text', text }], provider: opts.provider, principal });
    let final: Session | undefined;
    let errored: string | undefined;
    const ledger = services.LlmCalls;
    const pendingUsage: Array<Omit<LlmCall, 'userId' | 'conversationId' | 'provider' | 'model'>> = [];
    const flushUsage = (): void => {
      if (!ledger) return;
      const looked = services.providers.get(opts.provider)?.model;
      let logProvider = opts.provider;
      let logModel = looked ?? opts.provider;
      // Handle OpenRouter providers (e.g., 'openrouter/deepseek/deepseek-chat')
      if (!looked && opts.provider.startsWith('openrouter/')) {
        logProvider = 'openrouter';
        logModel = opts.provider.substring('openrouter/'.length);
      }
      for (const u of pendingUsage) {
        void ledger.record({
          userId: principal.id, conversationId: taskId, provider: logProvider, model: logModel, ...u,
        });
      }
      pendingUsage.length = 0;
    };
    for await (const ev of view.events) {
      if (ev.type === 'done') { final = ev.session; break; }
      if (ev.type === 'error') { errored = ev.error; break; }
      if (ev.type === 'aborted') { errored = ev.reason; break; }
      if (ev.type === 'usage') {
        pendingUsage.push({
          inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, requestId: ev.traceId,
          ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
          ...(ev.cacheCreationTokens !== undefined ? { cacheCreationTokens: ev.cacheCreationTokens } : {}),
          ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}),
        });
      }
    }
    flushUsage();
    if (errored !== undefined) { json(res, 200, { jsonrpc: '2.0', id, error: { code: -32603, message: errored } }); return; }
    const answer = final ? lastAssistantText(final) : '';
    const task = {
      id: taskId,
      contextId: taskId,
      status: { state: 'completed' },
      artifacts: [{ artifactId: crypto.randomUUID(), name: 'response', parts: [{ type: 'text', text: answer }] }],
    };
    json(res, 200, { jsonrpc: '2.0', id, result: task });
  });
}
