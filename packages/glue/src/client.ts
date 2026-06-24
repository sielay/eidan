// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal JSON-RPC 2.0 client for Glue's MCP server (potem apps/glue-web,
// POST /api/mcp). We talk the wire directly with `fetch` rather than pulling
// in an MCP SDK — Glue's endpoint is a single-POST hand-rolled JSON-RPC, and
// matbot's whole doctrine is "plain fetch, no SDKs". Auth is the operator's
// X-MCP-Secret (Glue's MCP_GLUE_SECRET), which resolves server-side to the
// owner with full, unrestricted access — the eidan operator IS the Glue owner.

export interface GlueEndpoint {
  /** Full MCP URL, e.g. https://glue.example.com/api/mcp */
  url: string;
  /** X-MCP-Secret value (Glue's MCP_GLUE_SECRET). */
  secret: string;
}

export class GlueError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = 'GlueError';
    this.code = code;
    this.data = data;
  }
}

interface JsonRpcResponse {
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: { code: number; message: string; data?: unknown };
}

// Call one Glue MCP tool and return its decoded result. Glue wraps every
// result as { content: [{ type: 'text', text: <JSON string> }] }; we unwrap
// and JSON.parse it back to a value. JSON-RPC errors (autonomy denials,
// validation, not-found) surface as GlueError so the executor can relay a
// useful message to the model — an autonomy denial keeps its code (-32010)
// and data ({ project_id, action, current_level }).
export async function callGlueTool(
  ep: GlueEndpoint,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-secret': ep.secret },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      ...(signal ? { signal } : {}),
    });
  } catch (exc) {
    const why = exc instanceof Error ? exc.message : String(exc);
    throw new GlueError(`Could not reach Glue MCP at ${ep.url}: ${why}`);
  }

  if (!res.ok) {
    // 401 here means the secret is wrong/missing (transport-level), not a
    // JSON-RPC error — those travel inside a 200 body.
    const body = await res.text().catch(() => '');
    const hint = res.status === 401 ? ' (check GLUE_MCP_SECRET matches Glue)' : '';
    throw new GlueError(
      `Glue MCP HTTP ${res.status}${hint}${body ? `: ${body.slice(0, 200)}` : ''}`,
      res.status,
    );
  }

  const body = (await res.json()) as JsonRpcResponse;
  if (body.error) {
    throw new GlueError(body.error.message, body.error.code, body.error.data);
  }
  const text = body.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new GlueError('Glue MCP returned an empty result');
  }
  try {
    return JSON.parse(text);
  } catch {
    // A tool that legitimately returns a bare string (rare) — pass it through.
    return text;
  }
}
