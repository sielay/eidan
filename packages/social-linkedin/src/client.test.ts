// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInClient } from './client.js';

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

test('LinkedInClient.getProfile (member) reads OpenID userinfo', async () => {
  setupFetchMocks();
  try {
    fetchResponses.set('https://api.linkedin.com/v2/userinfo',
      new Response(JSON.stringify({ sub: '123456', name: 'John Doe', email: 'john@example.com' }), { status: 200 })
    );
    const client = new LinkedInClient('test-token', { type: 'member' });
    const result = await client.getProfile();
    assert.equal(result.profile?.id, '123456');
    assert.equal(result.profile?.name, 'John Doe');
    assert.equal(result.profile?.kind, 'member');
    assert.equal(result.error, undefined);
  } finally {
    teardownFetchMocks();
  }
});

test('LinkedInClient.getProfile (organization) falls back to held identity', async () => {
  setupFetchMocks();
  try {
    // org lookup likely 404s without admin scope → client returns the identity it already holds
    const client = new LinkedInClient('test-token', { type: 'organization', author: 'urn:li:organization:42', handle: 'Eidan' });
    const result = await client.getProfile();
    assert.equal(result.profile?.kind, 'organization');
    assert.equal(result.profile?.id, 'urn:li:organization:42');
    assert.equal(result.profile?.name, 'Eidan');
  } finally {
    teardownFetchMocks();
  }
});

test('LinkedInClient.post creates a post (member, falls back to /me for author)', async () => {
  setupFetchMocks();
  try {
    fetchResponses.set('https://api.linkedin.com/v2/me',
      new Response(JSON.stringify({ id: 'user123' }), { status: 200 })
    );
    fetchResponses.set('https://api.linkedin.com/v2/ugcPosts',
      new Response(JSON.stringify({ id: 'post456' }), { status: 201 })
    );
    const client = new LinkedInClient('test-token');
    const result = await client.post('Hello LinkedIn!');
    assert.equal(result.id, 'post456');
    assert.equal(result.error, undefined);
  } finally {
    teardownFetchMocks();
  }
});

test('LinkedInClient.listFeed lists the author\x27s own posts (versioned /rest/posts)', async () => {
  setupFetchMocks();
  try {
    const url = new URL('https://api.linkedin.com/rest/posts');
    url.searchParams.set('q', 'author');
    fetchResponses.set(url.toString(),
      new Response(JSON.stringify({ elements: [{ id: 'urn:li:share:1', commentary: 'First post' }] }), { status: 200 })
    );
    const client = new LinkedInClient('test-token', { author: 'urn:li:organization:42' });
    const result = await client.listFeed(20);
    assert.ok(result.posts);
    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0]?.text, 'First post');
    assert.equal(result.error, undefined);
  } finally {
    teardownFetchMocks();
  }
});

test('LinkedInClient.listFeed errors without an author URN', async () => {
  setupFetchMocks();
  try {
    const client = new LinkedInClient('test-token');
    const result = await client.listFeed(20);
    assert.ok(result.error);
  } finally {
    teardownFetchMocks();
  }
});

test('LinkedInClient.getProfile surfaces API errors', async () => {
  setupFetchMocks();
  try {
    fetchResponses.set('https://api.linkedin.com/v2/userinfo',
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    );
    const client = new LinkedInClient('invalid-token', { type: 'member' });
    const result = await client.getProfile();
    assert.match(result.error!, /LinkedIn API error/);
  } finally {
    teardownFetchMocks();
  }
});
