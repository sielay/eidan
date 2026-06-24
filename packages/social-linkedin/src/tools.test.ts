// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import { makeLinkedinTools } from './tools.js';

let fetchCalls: Array<{ url: string; options: RequestInit | undefined }> = [];
let fetchResponses: Map<string, Response | Error> = new Map();

const mockFetch = (url: string | URL, options?: RequestInit): Response | Promise<Response> => {
  const urlStr = String(url);
  fetchCalls.push({ url: urlStr, options });

  if (fetchResponses.has(urlStr)) {
    const response = fetchResponses.get(urlStr)!;
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }

  for (const [key, response] of fetchResponses.entries()) {
    const keyStr = String(key);
    const basePart = keyStr.split('?')[0] || '';
    if (urlStr.includes(basePart) && keyStr.includes('?')) {
      const keyUrl = new URL(keyStr);
      const givenUrl = new URL(urlStr);
      let matches = true;
      for (const [param, value] of keyUrl.searchParams.entries()) {
        if (givenUrl.searchParams.get(param) !== value) {
          matches = false;
          break;
        }
      }
      if (matches) {
        if (response instanceof Error) {
          throw response;
        }
        return response;
      }
    }
  }

  return new Response(JSON.stringify({ error: 'Not mocked' }), {
    status: 404,
  });
};

const setupFetchMocks = () => {
  fetchCalls = [];
  fetchResponses.clear();
  global.fetch = mockFetch as unknown as typeof fetch;
};

const teardownFetchMocks = () => {
  global.fetch = undefined as unknown as typeof fetch;
};

const mockCtx = (secrets: Record<string, string | undefined> = {}): ToolContext => ({
  vault: {
    resolve: async (name: string) => {
      const key = name.replace(/^\$\{/, '').replace(/\}$/, '');
      const value = secrets[key];
      if (!value) throw new MissingSecretError(['KEY_NOT_FOUND']);
      return value;
    },
  },
} as unknown as ToolContext);

test('makeLinkedinTools returns the post/profile/feed tools (no search — LinkedIn has no search API)', () => {
  const names = makeLinkedinTools(null).map((t) => t.name);
  assert.deepEqual(names.sort(), ['linkedin_get_profile', 'linkedin_list_feed', 'linkedin_post']);
});

test('every tool accepts an optional `account` selector', () => {
  for (const t of makeLinkedinTools(null)) {
    const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok('account' in props, `${t.name} should expose account`);
  }
});

test('linkedin_post schema requires text (max 3000)', () => {
  const t = makeLinkedinTools(null).find((x) => x.name === 'linkedin_post')!;
  const schema = t.inputSchema as { required: string[]; properties: Record<string, Record<string, unknown>> };
  assert.ok(schema.required.includes('text'));
  assert.equal(schema.properties['text']?.['maxLength'], 3000);
});

test('linkedin_post tool with valid input yields result (legacy secret)', async () => {
  setupFetchMocks();
  try {
    fetchResponses.set('https://api.linkedin.com/v2/me',
      new Response(JSON.stringify({ id: 'user123' }), { status: 200 })
    );
    fetchResponses.set('https://api.linkedin.com/v2/ugcPosts',
      new Response(JSON.stringify({ id: 'post456' }), { status: 201 })
    );

    const postTool = makeLinkedinTools(null).find((t) => t.name === 'linkedin_post')!;
    const results: Array<Record<string, unknown>> = [];
    for await (const result of postTool.executor.execute(
      { text: 'Hello LinkedIn!' },
      mockCtx({ LINKEDIN_ACCESS_TOKEN: 'test-token' })
    )) {
      results.push(result as Record<string, unknown>);
    }

    assert.equal(results.length, 1);
    assert.equal(results[0]?.['type'], 'result');
    assert.equal((results[0]?.['value'] as Record<string, unknown>)['message'], 'Posted to LinkedIn');
  } finally {
    teardownFetchMocks();
  }
});

test('linkedin_post tool without text yields error', async () => {
  const postTool = makeLinkedinTools(null).find((t) => t.name === 'linkedin_post')!;
  const results: Array<Record<string, unknown>> = [];
  for await (const result of postTool.executor.execute(
    { text: '' },
    mockCtx({ LINKEDIN_ACCESS_TOKEN: 'test-token' })
  )) {
    results.push(result as Record<string, unknown>);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0]?.['type'], 'error');
});

test('linkedin_get_profile tool returns profile via userinfo (legacy secret = member)', async () => {
  setupFetchMocks();
  try {
    fetchResponses.set('https://api.linkedin.com/v2/userinfo',
      new Response(JSON.stringify({ sub: 'user123', name: 'John Doe', email: 'john@example.com' }), { status: 200 })
    );
    const profileTool = makeLinkedinTools(null).find((t) => t.name === 'linkedin_get_profile')!;
    const results: Array<Record<string, unknown>> = [];
    for await (const result of profileTool.executor.execute({}, mockCtx({ LINKEDIN_ACCESS_TOKEN: 'test-token' }))) {
      results.push(result as Record<string, unknown>);
    }
    assert.equal(results.length, 1);
    assert.equal(results[0]?.['type'], 'result');
    const value = results[0]?.['value'] as { name: string; kind: string };
    assert.equal(value.name, 'John Doe');
    assert.equal(value.kind, 'member');
  } finally {
    teardownFetchMocks();
  }
});

test('linkedin_list_feed errors on the legacy path (no author URN to query posts by)', async () => {
  const feedTool = makeLinkedinTools(null).find((t) => t.name === 'linkedin_list_feed')!;
  const results: Array<Record<string, unknown>> = [];
  for await (const result of feedTool.executor.execute({ limit: 20 }, mockCtx({ LINKEDIN_ACCESS_TOKEN: 'test-token' }))) {
    results.push(result as Record<string, unknown>);
  }
  assert.equal(results.length, 1);
  assert.equal(results[0]?.['type'], 'error');
});

test('legacy fallback: errors clearly when nothing is connected', async () => {
  const postTool = makeLinkedinTools(null).find((t) => t.name === 'linkedin_post')!;
  const results: Array<Record<string, unknown>> = [];
  for await (const result of postTool.executor.execute({ text: 'Hello' }, mockCtx({}))) {
    results.push(result as Record<string, unknown>);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0]?.['type'], 'error');
  assert.match(String(results[0]?.['message']), /isn't connected/);
});
