// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLinkedInTools } from './tools.js';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

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
  global.fetch = mockFetch as any;
};

const teardownFetchMocks = () => {
  global.fetch = undefined as any;
};

const mockCtx = (secrets: Record<string, string | undefined> = {}): ToolContext => ({
  vault: {
    resolve: async (name: string) => {
      const key = name.replace(/^\$\{/, '').replace(/\}$/, '');
      const value = secrets[key];
      if (!value) throw new MissingSecretError(['KEY_NOT_FOUND']);
      return value;
    },
    writeSecret: async (key: string, value: string) => {
      secrets[key] = value;
    },
  },
} as any);

test('linkedin_post tool with valid input yields result', async () => {
  setupFetchMocks();
  try {
    fetchResponses.set('https://api.linkedin.com/v2/me',
      new Response(JSON.stringify({ id: 'user123' }), { status: 200 })
    );
    fetchResponses.set('https://api.linkedin.com/v2/ugcPosts',
      new Response(JSON.stringify({ id: 'post456' }), { status: 201 })
    );

    const tools = makeLinkedInTools();
    const postTool = tools.find((t) => t.name === 'linkedin_post');
    assert.ok(postTool);

    const results: any[] = [];
    for await (const result of postTool!.executor.execute(
      { text: 'Hello LinkedIn!' },
      mockCtx({ LINKEDIN_ACCESS_TOKEN: 'test-token' })
    )) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'result');
    assert.equal(results[0].value.message, 'Posted to LinkedIn');
  } finally {
    teardownFetchMocks();
  }
});

test('linkedin_post tool without text yields error', async () => {
  const tools = makeLinkedInTools();
  const postTool = tools.find((t) => t.name === 'linkedin_post');
  assert.ok(postTool);

  const results: any[] = [];
  for await (const result of postTool!.executor.execute(
    { text: '' },
    mockCtx({ LINKEDIN_ACCESS_TOKEN: 'test-token' })
  )) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
});

test('linkedin_search tool returns posts', async () => {
  setupFetchMocks();
  try {
    const searchData = {
      elements: [
        {
          id: 'post1',
          actor: 'urn:li:person:user1',
          content: { description: 'AI post' },
          likesSummary: { totalLikes: 50 },
          commentsSummary: { totalFirstLevelComments: 10 },
        },
      ],
    };

    const url = new URL('https://api.linkedin.com/v2/search/posts');
    url.searchParams.set('keywords', 'AI');
    url.searchParams.set('count', '20');
    fetchResponses.set(url.toString(),
      new Response(JSON.stringify(searchData), { status: 200 })
    );

    const tools = makeLinkedInTools();
    const searchTool = tools.find((t) => t.name === 'linkedin_search');
    assert.ok(searchTool);

    const results: any[] = [];
    for await (const result of searchTool!.executor.execute(
      { query: 'AI', limit: 20 },
      mockCtx({ LINKEDIN_ACCESS_TOKEN: 'test-token' })
    )) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'result');
    assert.equal(results[0].value.posts.length, 1);
    assert.equal(results[0].value.query, 'AI');
  } finally {
    teardownFetchMocks();
  }
});

test('linkedin_get_profile tool returns profile', async () => {
  setupFetchMocks();
  try {
    const profileData = {
      id: 'user123',
      localizedFirstName: 'John',
      localizedLastName: 'Doe',
      localizedHeadline: 'Software Engineer',
    };

    fetchResponses.set('https://api.linkedin.com/v2/me',
      new Response(JSON.stringify(profileData), { status: 200 })
    );

    const tools = makeLinkedInTools();
    const profileTool = tools.find((t) => t.name === 'linkedin_get_profile');
    assert.ok(profileTool);

    const results: any[] = [];
    for await (const result of profileTool!.executor.execute(
      {},
      mockCtx({ LINKEDIN_ACCESS_TOKEN: 'test-token' })
    )) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'result');
    assert.equal(results[0].value.firstName, 'John');
    assert.equal(results[0].value.headline, 'Software Engineer');
  } finally {
    teardownFetchMocks();
  }
});

test('linkedin_list_feed tool returns posts', async () => {
  setupFetchMocks();
  try {
    const feedData = {
      elements: [
        {
          id: 'post1',
          actor: 'urn:li:person:user1',
          content: { description: 'Feed post' },
          likesSummary: { totalLikes: 25 },
          commentsSummary: { totalFirstLevelComments: 3 },
        },
      ],
    };

    const url = new URL('https://api.linkedin.com/v2/feed');
    url.searchParams.set('count', '20');
    url.searchParams.set('sortBy', 'RECENT');
    fetchResponses.set(url.toString(),
      new Response(JSON.stringify(feedData), { status: 200 })
    );

    const tools = makeLinkedInTools();
    const feedTool = tools.find((t) => t.name === 'linkedin_list_feed');
    assert.ok(feedTool);

    const results: any[] = [];
    for await (const result of feedTool!.executor.execute(
      { limit: 20 },
      mockCtx({ LINKEDIN_ACCESS_TOKEN: 'test-token' })
    )) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'result');
    assert.equal(results[0].value.posts.length, 1);
  } finally {
    teardownFetchMocks();
  }
});

test('tools yield error when token is missing', async () => {
  const tools = makeLinkedInTools();
  const postTool = tools.find((t) => t.name === 'linkedin_post');
  assert.ok(postTool);

  const results: any[] = [];
  for await (const result of postTool!.executor.execute(
    { text: 'Hello' },
    mockCtx({})
  )) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.match(results[0].message, /isn't connected/);
});
