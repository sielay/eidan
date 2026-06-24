// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callGlueTool, GlueError, type GlueEndpoint } from './client.js';

const EP: GlueEndpoint = { url: 'https://glue.test/api/mcp', secret: 's3cr3t' };

function stubFetch(impl: (url: string, init: RequestInit) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
    impl(String(url), init ?? {})) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('sends a tools/call envelope with the secret header and unwraps the JSON result', async () => {
  let seenBody: unknown;
  let seenSecret: string | undefined;
  const restore = stubFetch((_url, init) => {
    seenSecret = new Headers(init.headers).get('x-mcp-secret') ?? undefined;
    seenBody = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 2 }) }] },
      }),
      { status: 200 },
    );
  });
  try {
    const out = await callGlueTool(EP, 'list_funnels', { project_id: 'p1' });
    assert.deepEqual(out, { ok: true, n: 2 });
    assert.equal(seenSecret, 's3cr3t');
    assert.deepEqual(seenBody, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_funnels', arguments: { project_id: 'p1' } },
    });
  } finally {
    restore();
  }
});

test('maps a JSON-RPC error to GlueError, preserving code + data', async () => {
  const restore = stubFetch(
    () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32010, message: 'autonomy denied', data: { current_level: 'draft' } },
        }),
        { status: 200 },
      ),
  );
  try {
    await assert.rejects(
      () => callGlueTool(EP, 'send_campaign_now', { campaign_id: 'c1' }),
      (err: unknown) =>
        err instanceof GlueError &&
        err.code === -32010 &&
        /autonomy denied/.test(err.message),
    );
  } finally {
    restore();
  }
});

test('surfaces a 401 as a transport-level GlueError', async () => {
  const restore = stubFetch(() => new Response('Unauthorized', { status: 401 }));
  try {
    await assert.rejects(
      () => callGlueTool(EP, 'list_projects', {}),
      (err: unknown) => err instanceof GlueError && err.code === 401,
    );
  } finally {
    restore();
  }
});
