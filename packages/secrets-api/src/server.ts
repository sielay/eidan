// SPDX-License-Identifier: AGPL-3.0-or-later
// The secure, LLM-free secrets write path. A small authenticated HTTP server (pattern mirrors
// @eidandev/mcp-server): the browser's masked Settings field POSTs the value here, server-side,
// so it reaches eidan.secrets_vault encrypted WITHOUT ever passing through a model turn. All
// operations run under the caller's Principal (per-user scoping) resolved from the Bearer token.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatbotServices, Principal } from '@matatbread/matbot-plugin-api';
import { runAs } from '@matatbread/matbot-plugin-api';
import type { EidanSecrets } from '@eidandev/vault-postgres';

// Same per-request identity seam frontend-agui/mcp-server use, plus the eidan secrets surface.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    WebPrincipalResolver?: (req: IncomingMessage) => Principal | Promise<Principal>;
    EidanSecrets?: EidanSecrets;
  }
}

export interface SecretsApiOpts {
  port: number;
  webOrigin?: string; // echoed for credentialed CORS when the UI calls cross-origin
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cors(res: ServerResponse, origin: string | undefined): void {
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'origin');
  }
  res.setHeader('access-control-allow-methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
}

function send(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// /api/me/secrets            -> GET metadata (which keys are set)
// /api/me/secrets/catalog    -> GET the plugin-declared sections/fields (no values)
// /api/me/secrets/:name      -> PUT { value }  |  DELETE
function parsePath(url: string): { kind: 'root' | 'catalog' | 'name'; name?: string } | null {
  const path = url.split('?')[0] ?? '';
  const base = '/api/me/secrets';
  if (path === base || path === base + '/') return { kind: 'root' };
  if (path === base + '/catalog') return { kind: 'catalog' };
  if (path.startsWith(base + '/')) {
    const name = decodeURIComponent(path.slice(base.length + 1));
    if (name && !name.includes('/')) return { kind: 'name', name };
  }
  return null;
}

async function handle(req: IncomingMessage, res: ServerResponse, services: MatbotServices, opts: SecretsApiOpts): Promise<void> {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : opts.webOrigin;
  cors(res, origin);
  const method = req.method ?? 'GET';
  if (method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const route = parsePath(req.url ?? '');
  if (!route) { send(res, 404, { error: 'not found' }); return; }

  const resolver = services.WebPrincipalResolver;
  if (!resolver) { send(res, 503, { error: 'no principal resolver configured' }); return; }
  let principal: Principal;
  try { principal = await resolver(req); } catch { send(res, 401, { error: 'unauthorized' }); return; }

  const secrets = services.EidanSecrets;
  if (!secrets) { send(res, 503, { error: 'secrets service unavailable' }); return; }

  await runAs(principal, async () => {
    if (route.kind === 'catalog' && method === 'GET') {
      send(res, 200, { catalog: secrets.catalog() });
      return;
    }
    if (route.kind === 'root' && method === 'GET') {
      send(res, 200, { secrets: await secrets.listMetadata() });
      return;
    }
    if (route.kind === 'name' && method === 'PUT') {
      let value = '';
      try { value = (JSON.parse(await readBody(req)) as { value?: unknown }).value as string ?? ''; }
      catch { send(res, 400, { error: 'body must be JSON { "value": "…" }' }); return; }
      if (typeof value !== 'string' || value === '') { send(res, 400, { error: 'value must be a non-empty string' }); return; }
      await secrets.setSecret(route.name as string, value);
      send(res, 200, { ok: true, name: route.name }); // never echo the value
      return;
    }
    if (route.kind === 'name' && method === 'DELETE') {
      const removed = await secrets.deleteSecret(route.name as string);
      send(res, 200, { ok: true, name: route.name, removed });
      return;
    }
    send(res, 405, { error: 'method not allowed' });
  });
}

export function startSecretsApi(services: MatbotServices, opts: SecretsApiOpts): () => void {
  const server = createServer((req, res) => {
    void handle(req, res, services, opts).catch((e: unknown) => {
      // Don't leak exception detail to the client on a secrets API — log it server-side,
      // return a generic 500 (avoids stack-trace / info exposure).
      console.error('[secrets-api] request failed:', e instanceof Error ? e.message : String(e));
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  server.listen(opts.port);
  return () => server.close();
}
