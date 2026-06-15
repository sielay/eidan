// SPDX-License-Identifier: AGPL-3.0-or-later
// The account-link redemption endpoint (pattern mirrors @eidandev/secrets-api). The signed-in web
// user POSTs the one-time token from their /start link here; we resolve their Principal from the
// Bearer token, bind the captured chat to that user, and confirm in the chat. Reached through the
// AG-UI front door via PanelProxy (prefix /api/me/telegram/link), so its port stays internal.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatbotServices, Principal } from '@matatbread/matbot-plugin-api';
import { runAs } from '@matatbread/matbot-plugin-api';
import { TelegramStore } from './store.js';
import { sendMessage } from './bot.js';

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    WebPrincipalResolver?: (req: IncomingMessage) => Principal | Promise<Principal>;
    PanelProxy?: { register(route: { prefix: string; port: number }): void };
  }
}

export interface LinkServerOpts {
  port: number;
  botToken: string;
  store: TelegramStore;
  webOrigin?: string;
}

const PATH = '/api/me/telegram/link';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cors(res: ServerResponse, origin: string | undefined, allowed: string | undefined): void {
  if (origin && allowed && origin === allowed) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'origin');
  }
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
}

function send(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handle(req: IncomingMessage, res: ServerResponse, services: MatbotServices, opts: LinkServerOpts): Promise<void> {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  cors(res, origin, opts.webOrigin);
  const method = req.method ?? 'GET';
  if (method === 'OPTIONS') { res.writeHead(204).end(); return; }
  const path = (req.url ?? '').split('?')[0];
  if (path !== PATH) { send(res, 404, { error: 'not found' }); return; }
  if (method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return; }

  const resolver = services.WebPrincipalResolver;
  if (!resolver) { send(res, 503, { error: 'no principal resolver configured' }); return; }
  let principal: Principal;
  try { principal = await resolver(req); } catch { send(res, 401, { error: 'unauthorized' }); return; }

  let token = '';
  try { token = (JSON.parse(await readBody(req)) as { token?: unknown }).token as string ?? ''; }
  catch { send(res, 400, { error: 'body must be JSON { "token": "…" }' }); return; }
  if (typeof token !== 'string' || token === '') { send(res, 400, { error: 'token required' }); return; }

  await runAs(principal, async () => {
    const info = await opts.store.consumeToken(token);
    if (!info) { send(res, 400, { error: 'token invalid or expired' }); return; }
    await opts.store.bind(principal.id, info.chat_id, info.first_name, info.username);
    void sendMessage(opts.botToken, info.chat_id,
      "✅ Linked! I'll send your routines and replies here. Just message me.").catch(() => {});
    send(res, 200, { ok: true });
  });
}

export function startLinkServer(services: MatbotServices, opts: LinkServerOpts): () => void {
  const server = createServer((req, res) => {
    void handle(req, res, services, opts).catch((e: unknown) => {
      console.error('[frontend-telegram] link request failed:', e instanceof Error ? e.message : String(e));
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  server.listen(opts.port);
  return () => server.close();
}
