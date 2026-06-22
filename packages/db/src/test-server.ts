// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine-side "test connection" endpoint. The same small authenticated-HTTP pattern the core
// secrets-api uses (@eidandev/secrets-api): a private port, exposed through the public AG-UI front
// door via the PanelProxy, every request run under the Bearer-resolved Principal. This runs ON THE
// ENGINE — the same process the agent's db tools connect from — so a green test reflects the real
// network path and credentials, and it resolves the sealed password from the vault itself (the web
// can't, by design). POST /api/db/test { id } → resolve the user's connection + its vault password →
// driver ping → { ok } | { ok:false, error }.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatbotServices, Principal } from '@matatbread/matbot-plugin-api';
import { runAs } from '@matatbread/matbot-plugin-api';
import type { Registry } from './registry.js';
import { pinger } from './drivers/index.js';

// Core services this endpoint leans on, re-declared (the matbot decoupling idiom; the string key
// matches at runtime) so the bundle needs no hard dep on core's package layout.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    WebPrincipalResolver?: (req: IncomingMessage) => Principal | Promise<Principal>;
    PanelProxy?: { register(route: { prefix: string; port: number }): void };
  }
}

const PING_TIMEOUT_MS = 15_000;

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
  if (path !== '/api/db/test') { send(res, 404, { error: 'not found' }); return; }
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
    const row = await registry.getConnectionById(id);
    if (!row) { send(res, 404, { error: 'no such connection' }); return; }

    let password = '';
    if (row.pass_key) {
      try { password = await services.vault.resolve(`\${${row.pass_key}}`); }
      catch { send(res, 200, { ok: false, error: `password for "${row.name}" is not in the vault — re-save the connection` }); return; }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS).unref();
    try {
      await pinger(row.driver)(row, password, ctrl.signal);
      send(res, 200, { ok: true, driver: row.driver, connection: row.name });
    } catch (e) {
      send(res, 200, { ok: false, driver: row.driver, error: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(timer);
    }
  });
}

export function startDbTestServer(services: MatbotServices, registry: Registry, port: number): () => void {
  const server = createServer((req, res) => {
    void handle(req, res, services, registry).catch((e: unknown) => {
      console.error('[db] test request failed:', e instanceof Error ? e.message : String(e));
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  // CRITICAL: an http server emits 'error' (e.g. EADDRINUSE when the matbot loader re-runs setup() on
  // its load-retry path) — unhandled, that throws and crashes the whole engine. Handle it: log and
  // carry on. The endpoint is only registered/announced once the bind actually succeeds (in the
  // listen callback), so a failed bind leaves the rest of the plugin working, just without the panel.
  server.on('error', (e: NodeJS.ErrnoException) => {
    console.warn(`[db] test endpoint could not bind :${port} (${e.code ?? e.message}) — disabled on this instance`);
  });
  server.listen(port, () => {
    services.PanelProxy?.register({ prefix: '/api/db/test', port });
    console.log(`[db] test endpoint on :${port} (/api/db/test)`);
  });
  return () => server.close();
}
