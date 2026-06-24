// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInClient } from './client.js';
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

test('LinkedInClient.getProfile returns profile info', async () => {
  setupFetchMocks();
  try {
    const profileData = {
      id: '123456',
      localizedFirstName: 'John',
      localizedLastName: 'Doe',
      localizedHeadline: 'Software Engineer',
    };

    fetchResponses.set('https://api.linkedin.com/v2/me',
      new Response(JSON.stringify(profileData), { status: 200 })
    );

    const client = new LinkedInClient(mockCtx(), 'test-token');
    const result = await client.getProfile();

    assert.equal(result.profile?.id, '123456');
    assert.equal(result.profile?.localizedFirstName, 'John');
    assert.equal(result.error, undefined);
  } finally {
    teardownFetchMocks();
  }
});

test('LinkedInClient.post creates a post', async () => {
  setupFetchMocks();
  try {
    fetchResponses.set('https://api.linkedin.com/v2/me',
      new Response(JSON.stringify({ id: 'user123' }), { status: 200 })
    );

    fetchResponses.set('https://api.linkedin.com/v2/ugcPosts',
      new Response(JSON.stringify({ id: 'post456' }), { status: 201 })
    );

    const client = new LinkedInClient(mockCtx(), 'test-token');
    const result = await client.post('Hello LinkedIn!');

    assert.equal(result.id, 'post456');
    assert.equal(result.error, undefined);
  } finally {
    teardownFetchMocks();
  }
});

test('LinkedInClient.listFeed returns feed posts', async () => {
  setupFetchMocks();
  try {
    const feedData = {
      elements: [
        {
          id: 'post1',
          actor: 'urn:li:person:user1',
          content: { description: 'First post' },
          likesSummary: { totalLikes: 10 },
          commentsSummary: { totalFirstLevelComments: 2 },
        },
        {
          id: 'post2',
          actor: 'urn:li:person:user2',
          content: { description: 'Second post' },
          likesSummary: { totalLikes: 20 },
          commentsSummary: { totalFirstLevelComments: 5 },
        },
      ],
      paging: { start: 0, count: 2, total: 100 },
    };

    const url = new URL('https://api.linkedin.com/v2/feed');
    url.searchParams.set('count', '20');
    url.searchParams.set('sortBy', 'RECENT');
    fetchResponses.set(url.toString(),
      new Response(JSON.stringify(feedData), { status: 200 })
    );

    const client = new LinkedInClient(mockCtx(), 'test-token');
    const result = await client.listFeed(20);

    assert.ok(result.posts);
    assert.equal(result.posts.length, 2);
    assert.equal(result.posts[0]?.id, 'post1');
    assert.equal(result.error, undefined);
  } finally {
    teardownFetchMocks();
  }
});

test('LinkedInClient.search returns search results', async () => {
  setupFetchMocks();
  try {
    const searchData = {
      elements: [
        {
          id: 'post1',
          actor: 'urn:li:person:user1',
          content: { description: 'Relevant post' },
          likesSummary: { totalLikes: 50 },
          commentsSummary: { totalFirstLevelComments: 10 },
        },
      ],
      paging: { start: 0, count: 1, total: 50 },
    };

    const url = new URL('https://api.linkedin.com/v2/search/posts');
    url.searchParams.set('keywords', 'AI');
    url.searchParams.set('count', '20');
    fetchResponses.set(url.toString(),
      new Response(JSON.stringify(searchData), { status: 200 })
    );

    const client = new LinkedInClient(mockCtx(), 'test-token');
    const result = await client.search('AI', 20);

    assert.ok(result.posts);
    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0]?.text, 'Relevant post');
    assert.equal(result.error, undefined);
  } finally {
    teardownFetchMocks();
  }
});

test('LinkedInClient handles API errors gracefully', async () => {
  setupFetchMocks();
  try {
    fetchResponses.set('https://api.linkedin.com/v2/me',
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    );

    const client = new LinkedInClient(mockCtx(), 'invalid-token');
    const result = await client.getProfile();

    assert.match(result.error!, /LinkedIn API error/);
  } finally {
    teardownFetchMocks();
  }
});

test('IPv6 patterns correctly identify private ranges', async () => {
  setupFetchMocks();
  try {
    const client = new LinkedInClient(mockCtx(), 'test-token');
    // Access private method via reflection for testing
    const isPrivateIp = (client as any).isPrivateIp.bind(client);

    // IPv6 ULA ranges (fc00::/7)
    assert.ok(isPrivateIp('fc00::1'), 'Should reject fc00::1');
    assert.ok(isPrivateIp('fd00::1'), 'Should reject fd00::1');
    assert.ok(isPrivateIp('fdff::1'), 'Should reject fdff::1');

    // IPv6 Link-Local ranges (fe80::/10)
    assert.ok(isPrivateIp('fe80::1'), 'Should reject fe80::1');
    assert.ok(isPrivateIp('feb0::1'), 'Should reject feb0::1');
    assert.ok(isPrivateIp('febf::1'), 'Should reject febf::1');

    // IPv6 Loopback
    assert.ok(isPrivateIp('::1'), 'Should reject ::1');

    // Public addresses should not be rejected
    assert.ok(!isPrivateIp('2001:4860:4860::8888'), 'Should accept public IPv6');

    // IPv4 ranges
    assert.ok(isPrivateIp('127.0.0.1'), 'Should reject loopback IPv4');
    assert.ok(isPrivateIp('192.168.1.1'), 'Should reject private IPv4');
    assert.ok(isPrivateIp('10.0.0.1'), 'Should reject private IPv4');
  } finally {
    teardownFetchMocks();
  }
});

test('Domain whitelist prevents subdomain spoofing', async () => {
  setupFetchMocks();
  try {
    const client = new LinkedInClient(mockCtx(), 'test-token');
    // Access private method via reflection for testing
    const isAllowedImageDomain = (client as any).isAllowedImageDomain.bind(client);

    // Exact match should work
    assert.ok(isAllowedImageDomain('imgur.com'), 'Should allow exact domain match');

    // True subdomain should work
    assert.ok(isAllowedImageDomain('i.imgur.com'), 'Should allow true subdomain');

    // Spoofing attempt should fail
    assert.ok(!isAllowedImageDomain('evil.com.imgur.com'), 'Should reject spoofed subdomain');
    assert.ok(!isAllowedImageDomain('imgurclon.com'), 'Should reject similar domain');
  } finally {
    teardownFetchMocks();
  }
});
