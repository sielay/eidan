// SPDX-License-Identifier: AGPL-3.0-or-later
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';

// Single public ingress for plugin-run HTTP servers.
//
// Several plugins bind their own internal loopback port (the secrets-api on :8092, a bundle's panel
// server, …) but only the AG-UI port (:8090) is exposed publicly. Rather than open each port on the
// host, those plugins register a PanelRoute here and the AG-UI dispatcher reverse-proxies matching
// requests to the right loopback port by path prefix. Internal ports stay private; the front door is
// one port. The target does its OWN auth (the shared WebPrincipalResolver resolves the same Bearer),
// so the proxy streams the request through verbatim — headers + body — and streams the reply back.
export interface PanelRoute {
  /** Path prefix to match, e.g. '/api/me/secrets'. Matches the prefix exactly or prefix + '/…'. */
  prefix: string;
  /** Loopback port the plugin's internal HTTP server listens on. */
  port: number;
}

export interface PanelProxy {
  register(route: PanelRoute): void;
  match(pathname: string): PanelRoute | undefined;
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    PanelProxy?: PanelProxy;
  }
}

export function createPanelProxy(): PanelProxy {
  const routes: PanelRoute[] = [];
  return {
    register(route: PanelRoute): void {
      routes.push(route);
    },
    match(pathname: string): PanelRoute | undefined {
      return routes.find((r) => pathname === r.prefix || pathname.startsWith(r.prefix + '/'));
    },
  };
}

// Reverse-proxy the live request to an internal panel server on 127.0.0.1:<port>, streaming both
// directions. Host header is dropped (the upstream sets its own); everything else passes through so
// the target authenticates the Bearer itself. A connect failure surfaces a 502 instead of hanging.
export function proxyToPanel(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  cors: Record<string, string>,
): void {
  const headers = { ...req.headers };
  delete headers.host;
  const upstream = httpRequest(
    { host: '127.0.0.1', port, method: req.method ?? 'GET', path: req.url ?? '/', headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, { ...up.headers, ...cors });
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: 'panel server unreachable' }));
    } else {
      res.end();
    }
  });
  req.pipe(upstream);
}
