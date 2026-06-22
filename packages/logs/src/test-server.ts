// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine-side "test source" endpoint — same authenticated-HTTP pattern as the core secrets-api and
// the db bundle's test server: a private port exposed through the public AG-UI front door via the
// PanelProxy, every request run under the Bearer-resolved Principal. Runs ON THE ENGINE (where the
// agent's logs tools fetch from) and resolves the sealed API token from the vault itself. A test is
// simply a 1-line fetch through the provider, so it exercises the real auth + endpoint config.
// POST /api/logs/test { id } → resolve the user's source + its vault token → provider fetch(limit 1)
// → { ok, count } | { ok:false, error }.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatbotServices, Principal } from '@matatbread/matbot-plugin-api';
import { runAs } from '@matatbread/matbot-plugin-api';
import type { Registry } from './registry.js';
import { providerFetch } from './providers/index.js';

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    WebPrincipalResolver?: (req: IncomingMessage) => Principal | Promise<Principal>;
    PanelProxy?: { register(route: { prefix: string; port: number }): void };
  }
}

const FETCH_TIMEOUT_MS = 15_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handle(req: IncomingMessage, res: ServerResponse, services: MatbotServices, registry: Registry): Promise<void> {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== '/api/logs/test') { send(res, 404, { error: 'not found' }); return; }
  if ((req.method ?? 'GET') !== 'POST') { send(res, 405, { error: 'method not allowed' }); return; }

  const resolver = services.WebPrincipalResolver;
  if (!resolver) { send(res, 503, { error: 'no principal resolver configured' }); return; }
  let principal: Principal;
  try { principal = await resolver(req); } catch { send(res, 401, { error: 'unauthorized' }); return; }

  let id = '';
  try { id = String((JSON.parse(await readBody(req)) as { id?: unknown }).id ?? ''); }
  catch { send(res, 400, { error: 'body must be JSON { "id": "…" }' }); return; }
  if (!id) { send(res, 400, { error: 'id is required' }); return; }

  await runAs(principal, async () => {
    const row = await registry.getSourceById(id);
    if (!row) { send(res, 404, { error: 'no such source' }); return; }

    let token = '';
    if (row.token_key) {
      try { token = await services.vault.resolve(`\${${row.token_key}}`); }
      catch { send(res, 200, { ok: false, error: `API token for "${row.name}" is not in the vault — re-save the source` }); return; }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS).unref();
    try {
      const lines = await providerFetch(row.provider)(row.config ?? {}, token, { limit: 1 }, ctrl.signal);
      send(res, 200, { ok: true, provider: row.provider, source: row.name, count: lines.length });
    } catch (e) {
      send(res, 200, { ok: false, provider: row.provider, error: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(timer);
    }
  });
}

export function startLogsTestServer(services: MatbotServices, registry: Registry, port: number): () => void {
  const server = createServer((req, res) => {
    void handle(req, res, services, registry).catch((e: unknown) => {
      console.error('[logs] test request failed:', e instanceof Error ? e.message : String(e));
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  // CRITICAL: handle the server 'error' event (e.g. EADDRINUSE on a setup() re-run) — unhandled it
  // throws and crashes the engine. Register/announce only once the bind succeeds (listen callback).
  server.on('error', (e: NodeJS.ErrnoException) => {
    console.warn(`[logs] test endpoint could not bind :${port} (${e.code ?? e.message}) — disabled on this instance`);
  });
  server.listen(port, () => {
    services.PanelProxy?.register({ prefix: '/api/logs/test', port });
    console.log(`[logs] test endpoint on :${port} (/api/logs/test)`);
  });
  return () => server.close();
}
