// SPDX-License-Identifier: AGPL-3.0-or-later
// Sage's admin panel HTTP server — serves the plugin "cursor panel" contract core's CursorsPane
// probes (GET <base>/cursors, GET <base>/summary, POST <base>/cursors/:id/:action). Pattern mirrors
// @eidandev/secrets-api / @eidandev/mcp-server: a small authenticated node:http server on its own
// port, behind the Next front-door proxy. The browser only ever talks to the Next app same-origin;
// the proxy forwards the Bearer token, which we resolve to a Principal (auth gate — 401 without one).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatbotServices, Principal } from '@matatbread/matbot-plugin-api';
import type { Db } from './db.js';
import { buildPanel, buildSummary, runCursorAction } from './panel.js';

// Same per-request identity seam secrets-api / frontend-agui declare.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    WebPrincipalResolver?: (req: IncomingMessage) => Principal | Promise<Principal>;
  }
}

export interface PanelServerOpts {
  db: Db;
  port: number;
  base: string; // route prefix, e.g. '/api/sage'
  nodeId?: string | undefined; // when set, scope the panel to this node's cursors
  webOrigin?: string | undefined;
}

function cors(res: ServerResponse, origin: string | undefined): void {
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'origin');
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
}

function send(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// <base>/cursors | <base>/summary | <base>/cursors/:id/:action
function parsePath(url: string, base: string): { kind: 'cursors' | 'summary' } | { kind: 'action'; id: string; action: string } | null {
  const path = (url.split('?')[0] ?? '').replace(/\/$/, '');
  if (path === `${base}/cursors`) return { kind: 'cursors' };
  if (path === `${base}/summary`) return { kind: 'summary' };
  if (path.startsWith(`${base}/cursors/`)) {
    const rest = path.slice(`${base}/cursors/`.length).split('/');
    if (rest.length === 2 && rest[0] && rest[1]) return { kind: 'action', id: decodeURIComponent(rest[0]), action: rest[1] };
  }
  return null;
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: PanelServerOpts, services: MatbotServices): Promise<void> {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : opts.webOrigin;
  cors(res, origin);
  const method = req.method ?? 'GET';
  if (method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const route = parsePath(req.url ?? '', opts.base);
  if (!route) { send(res, 404, { error: 'not found' }); return; }

  // Auth gate: the panel is operator data — require a resolvable principal (any valid session).
  const resolver = services.WebPrincipalResolver;
  if (resolver) {
    try {
      await resolver(req);
    } catch {
      send(res, 401, { error: 'unauthorized' });
      return;
    }
  }

  try {
    if (route.kind === 'cursors' && method === 'GET') { send(res, 200, await buildPanel(opts.db, opts.nodeId)); return; }
    if (route.kind === 'summary' && method === 'GET') { send(res, 200, await buildSummary(opts.db, opts.nodeId)); return; }
    if (route.kind === 'action' && method === 'POST') { send(res, 200, await runCursorAction(opts.db, route.id, route.action)); return; }
    send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

export function startPanelServer(services: MatbotServices, opts: PanelServerOpts): () => void {
  const server = createServer((req, res) => {
    void handle(req, res, opts, services).catch((e) => send(res, 500, { error: e instanceof Error ? e.message : String(e) }));
  });
  server.listen(opts.port);
  return () => server.close();
}
