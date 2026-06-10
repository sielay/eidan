// SPDX-License-Identifier: AGPL-3.0-or-later
// Inbound MCP server — hand-rolled JSON-RPC 2.0 over HTTP POST (pattern from potem apps/glue-web:
// no MCP SDK, just a route that handles initialize / tools/list / tools/call). It exposes a
// curated subset of the matbot tool registry so external MCP clients can drive eidan tools.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatbotServices, Principal, Session, ToolContext, PromptFn, ToolEvent } from '@matatbread/matbot-plugin-api';
import { runAs } from '@matatbread/matbot-plugin-api';

// Same per-request identity seam frontend-agui/auth use.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    WebPrincipalResolver?: (req: IncomingMessage) => Principal | Promise<Principal>;
  }
}

export interface McpOpts {
  port: number;
  secret?: string;
  secretPrincipal?: Principal;
  allow(name: string): boolean;
}

interface JsonRpc { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }

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

// Drive one matbot tool to completion outside a turn (synthetic session + ToolContext), under the
// caller's principal, and reduce its event stream to a single text result.
async function callTool(services: MatbotServices, name: string, input: unknown, principal: Principal): Promise<{ text: string; isError: boolean }> {
  const tool = services.tools.resolve(name);
  if (!tool) return { text: `unknown tool: ${name}`, isError: true };
  const now = new Date().toISOString();
  const session: Session = { id: crypto.randomUUID(), version: '0', ownerPrincipalId: principal.id, status: 'active', contexts: [], messages: [], createdAt: now, updatedAt: now };
  const ac = new AbortController();
  const prompt = ((): Promise<string> => Promise.reject(new Error('no interactive prompt over MCP'))) as PromptFn;
  const ctx: ToolContext = {
    callId: crypto.randomUUID(),
    session,
    signal: ac.signal,
    vault: services.vault,
    prompt,
    loadPlugin: services.loadPlugin.bind(services),
    unloadPlugin: services.unloadPlugin.bind(services),
    ...(services.files !== undefined ? { files: services.files } : {}),
    ...(services.workdir !== undefined ? { workdir: services.workdir } : {}),
    ...(services.configPath !== undefined ? { configPath: services.configPath } : {}),
  };
  return runAs(principal, async () => {
    let result: unknown;
    let isError = false;
    const out: string[] = [];
    for await (const ev of tool.executor.execute(input, ctx) as AsyncIterable<ToolEvent>) {
      if (ev.type === 'result') result = ev.value;
      else if (ev.type === 'error') { isError = true; result = ev.message; }
      else if (ev.type === 'stdout') out.push(ev.chunk);
    }
    const text = result !== undefined ? (typeof result === 'string' ? result : JSON.stringify(result)) : out.join('');
    return { text, isError };
  });
}

async function resolvePrincipal(req: IncomingMessage, services: MatbotServices, opts: McpOpts): Promise<Principal | null> {
  const secretHdr = req.headers['x-mcp-secret'];
  if (opts.secret && typeof secretHdr === 'string' && secretHdr === opts.secret && opts.secretPrincipal) return opts.secretPrincipal;
  const resolver = services.WebPrincipalResolver;
  if (resolver) { try { return await resolver(req); } catch { return null; } }
  return null;
}

async function handle(req: IncomingMessage, res: ServerResponse, services: MatbotServices, opts: McpOpts): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') { send(res, 405, { error: 'POST only' }); return; }
  const principal = await resolvePrincipal(req, services, opts);
  if (!principal) { send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }); return; }

  let rpc: JsonRpc;
  try { rpc = JSON.parse(await readBody(req)) as JsonRpc; }
  catch { send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
  const id = rpc.id ?? null;

  switch (rpc.method) {
    case 'initialize':
      send(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'eidan', version: '0.1' } } });
      return;
    case 'notifications/initialized':
      res.writeHead(202).end();
      return;
    case 'tools/list': {
      const tools = services.tools.list().filter((t) => opts.allow(t.name)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      send(res, 200, { jsonrpc: '2.0', id, result: { tools } });
      return;
    }
    case 'tools/call': {
      const name = String(rpc.params?.['name'] ?? '');
      const args = (rpc.params?.['arguments'] ?? {}) as Record<string, unknown>;
      if (!opts.allow(name)) { send(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `tool not exposed: ${name}` } }); return; }
      const { text, isError } = await callTool(services, name, args, principal);
      send(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } });
      return;
    }
    default:
      send(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${rpc.method ?? ''}` } });
  }
}

export function startMcpServer(services: MatbotServices, opts: McpOpts): () => void {
  const server = createServer((req, res) => {
    void handle(req, res, services, opts).catch((e: unknown) => {
      if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
      else res.end();
    });
  });
  server.listen(opts.port);
  return () => server.close();
}
