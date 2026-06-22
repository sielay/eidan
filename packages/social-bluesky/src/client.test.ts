// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlueskyClient } from './client.js';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

let fetchCalls: Array<{ url: string; options: RequestInit | undefined }> = [];
let fetchResponses: Map<string, Response> = new Map();

const mockFetch = (url: string | URL, options?: RequestInit): Response | Promise<Response> => {
  const urlStr = String(url);
  fetchCalls.push({ url: urlStr, options });

  if (fetchResponses.has(urlStr)) {
    return fetchResponses.get(urlStr)!;
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

const toBase64Url = (str: string): string => {
  const buf = Buffer.from(str, 'utf8' as BufferEncoding);
  const b64 = buf.toString('base64' as BufferEncoding);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
};

const validJwt = (() => {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256' }));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = toBase64Url(JSON.stringify({ exp }));
  return `${header}.${payload}.sig`;
})();

const expiredJwt = (() => {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256' }));
  const exp = Math.floor(Date.now() / 1000) - 3600;
  const payload = toBase64Url(JSON.stringify({ exp }));
  return `${header}.${payload}.sig`;
})();

test('BlueskyClient constructor with default service', () => {
  setupFetchMocks();
  const ctx = mockCtx();
  const client = new BlueskyClient(ctx);
  assert.ok(client);
  teardownFetchMocks();
});

test('BlueskyClient constructor with custom service', () => {
  setupFetchMocks();
  const ctx = mockCtx();
  const client = new BlueskyClient(ctx, 'https://custom.service');
  assert.ok(client);
  teardownFetchMocks();
});

test('decodeJwtExpiry parses valid JWT', async () => {
  setupFetchMocks();
  const ctx = mockCtx();
  const client = new BlueskyClient(ctx);

  const expiry = (client as any).decodeJwtExpiry(validJwt);
  assert.ok(expiry instanceof Date);
  assert.ok(expiry.getTime() > Date.now());
  teardownFetchMocks();
});

test('decodeJwtExpiry returns null for invalid JWT format', async () => {
  setupFetchMocks();
  const ctx = mockCtx();
  const client = new BlueskyClient(ctx);

  const expiry = (client as any).decodeJwtExpiry('not.a.jwt');
  assert.equal(expiry, null);

  const expiry2 = (client as any).decodeJwtExpiry('only.two');
  assert.equal(expiry2, null);

  teardownFetchMocks();
});

test('decodeJwtExpiry returns null when exp is missing', async () => {
  setupFetchMocks();
  const ctx = mockCtx();
  const client = new BlueskyClient(ctx);

  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: 1000 })).toString('base64url');
  const noExpJwt = `${header}.${payload}.sig`;

  const expiry = (client as any).decodeJwtExpiry(noExpJwt);
  assert.equal(expiry, null);

  teardownFetchMocks();
});

test('getValidAccessJwt returns null when secrets are missing', async () => {
  setupFetchMocks();
  const ctx = mockCtx({});
  const client = new BlueskyClient(ctx);

  const session = await client.getValidAccessJwt();
  assert.equal(session, null);
  teardownFetchMocks();
});

test('getValidAccessJwt uses cached JWT when not near expiry', async () => {
  setupFetchMocks();
  const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: expiry,
    BLUESKY_DID: 'did:plc:123',
  });
  const client = new BlueskyClient(ctx);

  const session = await client.getValidAccessJwt();
  assert.equal(session?.accessJwt, validJwt);
  assert.equal(session?.did, 'did:plc:123');
  assert.equal(session?.service, 'https://bsky.social');
  teardownFetchMocks();
});

test('getValidAccessJwt refreshes when JWT near expiry', async () => {
  setupFetchMocks();
  const newAccessJwt = validJwt;
  const newRefreshJwt = 'new-refresh-jwt';
  const newExpiry = new Date(Date.now() + 3600 * 1000).toISOString();

  fetchResponses.set(`https://bsky.social/xrpc/com.atproto.server.refreshSession`, {
    ok: true,
    json: async () => ({
      did: 'did:plc:123',
      handle: 'user.bsky.social',
      accessJwt: newAccessJwt,
      refreshJwt: newRefreshJwt,
    }),
  } as any);

  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: expiredJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() - 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
    BLUESKY_REFRESH_JWT: 'old-refresh-jwt',
  });
  const client = new BlueskyClient(ctx);

  const session = await client.getValidAccessJwt();
  assert.equal(session?.accessJwt, newAccessJwt);
  assert.equal(session?.did, 'did:plc:123');
  teardownFetchMocks();
});

test('getValidAccessJwt creates new session from app password', async () => {
  setupFetchMocks();
  const newAccessJwt = validJwt;

  fetchResponses.set(`https://bsky.social/xrpc/com.atproto.server.createSession`, {
    ok: true,
    json: async () => ({
      did: 'did:plc:456',
      handle: 'user.bsky.social',
      accessJwt: newAccessJwt,
      refreshJwt: 'new-refresh-jwt',
    }),
  } as any);

  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
  });
  const client = new BlueskyClient(ctx);

  const session = await client.getValidAccessJwt();
  assert.equal(session?.did, 'did:plc:456');
  assert.equal(session?.accessJwt, newAccessJwt);
  teardownFetchMocks();
});

test('detectFacets finds URLs', async () => {
  setupFetchMocks();
  const ctx = mockCtx();
  const client = new BlueskyClient(ctx);

  const text = 'Check this out https://example.com and also https://test.org/path';
  const facets = (client as any).detectFacets(text);

  assert.ok(facets.length >= 2);
  const linkFacets = facets.filter((f: any) => f.features[0].$type === 'app.bsky.richtext.facet#link');
  assert.ok(linkFacets.length >= 2);

  teardownFetchMocks();
});

test('detectFacets finds hashtags', async () => {
  setupFetchMocks();
  const ctx = mockCtx();
  const client = new BlueskyClient(ctx);

  const text = 'Hello #world and #testing are cool';
  const facets = (client as any).detectFacets(text);

  assert.ok(facets.length >= 2);
  const tagFacets = facets.filter((f: any) => f.features[0].$type === 'app.bsky.richtext.facet#tag');
  assert.ok(tagFacets.length >= 2);

  teardownFetchMocks();
});

test('detectFacets handles text without facets', async () => {
  setupFetchMocks();
  const ctx = mockCtx();
  const client = new BlueskyClient(ctx);

  const text = 'Just plain text with no special content';
  const facets = (client as any).detectFacets(text);

  assert.equal(facets.length, 0);

  teardownFetchMocks();
});

test('graphemeCount works with ASCII text', async () => {
  setupFetchMocks();
  const ctx = mockCtx();
  const client = new BlueskyClient(ctx);

  const count = (client as any).graphemeCount('hello');
  assert.equal(count, 5);

  teardownFetchMocks();
});

test('post returns error when not authenticated', async () => {
  setupFetchMocks();
  const ctx = mockCtx({});
  const client = new BlueskyClient(ctx);

  const result = await client.post('Hello world');

  assert.equal(result.uri, '');
  assert.equal(result.cid, '');
  assert.ok(result.error);
  assert.ok(result.error.includes("isn't connected"));

  teardownFetchMocks();
});

test('post returns error when text exceeds 300 characters', async () => {
  setupFetchMocks();
  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });
  const client = new BlueskyClient(ctx);

  const longText = 'x'.repeat(301);
  const result = await client.post(longText);

  assert.equal(result.uri, '');
  assert.equal(result.cid, '');
  assert.ok(result.error);
  assert.ok(result.error.includes('300 character limit'));

  teardownFetchMocks();
});

test('post succeeds with valid text', async () => {
  setupFetchMocks();

  fetchResponses.set(`https://bsky.social/xrpc/com.atproto.repo.createRecord`, {
    ok: true,
    json: async () => ({
      uri: 'at://did:plc:123/app.bsky.feed.post/abc123',
      cid: 'bafy123',
    }),
  } as any);

  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });
  const client = new BlueskyClient(ctx);

  const result = await client.post('Hello world');

  assert.equal(result.uri, 'at://did:plc:123/app.bsky.feed.post/abc123');
  assert.equal(result.cid, 'bafy123');
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('post includes facets in request', async () => {
  setupFetchMocks();

  let capturedBody: any;
  fetchResponses.set(`https://bsky.social/xrpc/com.atproto.repo.createRecord`, {
    ok: true,
    json: async () => ({
      uri: 'at://did:plc:123/app.bsky.feed.post/abc123',
      cid: 'bafy123',
    }),
  } as any);

  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  global.fetch = ((url: string, options: RequestInit) => {
    if (url.includes('createRecord')) {
      capturedBody = JSON.parse(options.body as string);
    }
    return new Response(
      JSON.stringify({
        uri: 'at://did:plc:123/app.bsky.feed.post/abc123',
        cid: 'bafy123',
      }),
      { ok: true } as any
    );
  }) as any;

  const client = new BlueskyClient(ctx);
  const result = await client.post('Check #hashtag and https://example.com');

  assert.equal(result.uri, 'at://did:plc:123/app.bsky.feed.post/abc123');
  assert.ok(capturedBody?.record?.facets);

  teardownFetchMocks();
});

test('post with reply_to includes parent reference', async () => {
  setupFetchMocks();

  let capturedBody: any;
  fetchResponses.set(
    'https://bsky.social/xrpc/app.bsky.feed.getPosts?uris=at://did:plc:999/app.bsky.feed.post/parent123',
    {
      ok: true,
      json: async () => ({
        posts: [
          {
            uri: 'at://did:plc:999/app.bsky.feed.post/parent123',
            cid: 'bafy-parent',
          },
        ],
      }),
    } as any
  );

  fetchResponses.set(`https://bsky.social/xrpc/com.atproto.repo.createRecord`, {
    ok: true,
    json: async () => ({
      uri: 'at://did:plc:123/app.bsky.feed.post/reply123',
      cid: 'bafy-reply',
    }),
  } as any);

  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  global.fetch = ((url: string, options: RequestInit) => {
    if (url.includes('createRecord')) {
      capturedBody = JSON.parse(options.body as string);
    }
    if (url.includes('getPosts')) {
      return new Response(
        JSON.stringify({
          posts: [
            {
              uri: 'at://did:plc:999/app.bsky.feed.post/parent123',
              cid: 'bafy-parent',
            },
          ],
        }),
        { ok: true } as any
      );
    }
    return new Response(
      JSON.stringify({
        uri: 'at://did:plc:123/app.bsky.feed.post/reply123',
        cid: 'bafy-reply',
      }),
      { ok: true } as any
    );
  }) as any;

  const client = new BlueskyClient(ctx);
  const result = await client.post('Reply text', 'at://did:plc:999/app.bsky.feed.post/parent123');

  assert.equal(result.uri, 'at://did:plc:123/app.bsky.feed.post/reply123');
  assert.ok(capturedBody?.record?.reply?.parent);

  teardownFetchMocks();
});

test('post returns error when reply parent not found', async () => {
  setupFetchMocks();

  fetchResponses.set('https://bsky.social/xrpc/app.bsky.feed.getPosts?uris=invalid-uri', {
    ok: true,
    json: async () => ({
      posts: [],
    }),
  } as any);

  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  global.fetch = ((url: string, options?: RequestInit) => {
    if (url.includes('getPosts')) {
      return new Response(JSON.stringify({ posts: [] }), { ok: true } as any);
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 } as any);
  }) as any;

  const client = new BlueskyClient(ctx);
  const result = await client.post('Reply text', 'invalid-uri');

  assert.ok(result.error);
  assert.ok(result.error.includes('Reply parent not found'));

  teardownFetchMocks();
});

test('readFeed returns error when not authenticated', async () => {
  setupFetchMocks();
  const ctx = mockCtx({});
  const client = new BlueskyClient(ctx);

  const result = await client.readFeed();

  assert.deepEqual(result.posts, []);
  assert.ok(result.error);
  assert.ok(result.error.includes("isn't connected"));

  teardownFetchMocks();
});

test('readFeed succeeds with valid session', async () => {
  setupFetchMocks();

  global.fetch = ((url: string, options?: RequestInit) => {
    if (url.includes('getAuthorFeed')) {
      return new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:123/app.bsky.feed.post/post1',
                cid: 'bafy1',
                author: { did: 'did:plc:123', handle: 'user.bsky.social' },
                record: { text: 'Post 1', createdAt: '2025-01-01T00:00:00Z' },
                likeCount: 5,
              },
            },
          ],
        }),
        { ok: true } as any
      );
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 } as any);
  }) as any;

  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });
  const client = new BlueskyClient(ctx);

  const result = await client.readFeed();

  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].uri, 'at://did:plc:123/app.bsky.feed.post/post1');
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('readFeed respects limit parameter', async () => {
  setupFetchMocks();

  fetchResponses.set(
    'https://bsky.social/xrpc/app.bsky.feed.getAuthorFeed?actor=did:plc:123&limit=50',
    {
      ok: true,
      json: async () => ({
        feed: [],
      }),
    } as any
  );

  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  global.fetch = ((url: string, options?: RequestInit) => {
    if (url.includes('getAuthorFeed') && url.includes('limit=50')) {
      return new Response(JSON.stringify({ feed: [] }), { ok: true } as any);
    }
    return new Response(JSON.stringify({ error: 'Wrong limit' }), { status: 400 } as any);
  }) as any;

  const client = new BlueskyClient(ctx);
  const result = await client.readFeed(50);

  assert.deepEqual(result.posts, []);
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('search returns error when not authenticated', async () => {
  setupFetchMocks();
  const ctx = mockCtx({});
  const client = new BlueskyClient(ctx);

  const result = await client.search('test');

  assert.deepEqual(result.posts, []);
  assert.ok(result.error);
  assert.ok(result.error.includes("isn't connected"));

  teardownFetchMocks();
});

test('search succeeds with valid query', async () => {
  setupFetchMocks();

  fetchResponses.set('https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=bluesky&limit=20', {
    ok: true,
    json: async () => ({
      posts: [
        {
          uri: 'at://did:plc:456/app.bsky.feed.post/search1',
          cid: 'bafy-search1',
          author: { did: 'did:plc:456', handle: 'other.bsky.social', displayName: 'Other User' },
          record: { text: 'About bluesky', createdAt: '2025-01-01T00:00:00Z' },
          likeCount: 10,
          replyCount: 2,
          repostCount: 1,
        },
      ],
    }),
  } as any);

  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  global.fetch = ((url: string, options?: RequestInit) => {
    if (url.includes('searchPosts')) {
      return new Response(
        JSON.stringify({
          posts: [
            {
              uri: 'at://did:plc:456/app.bsky.feed.post/search1',
              cid: 'bafy-search1',
              author: { did: 'did:plc:456', handle: 'other.bsky.social', displayName: 'Other User' },
              record: { text: 'About bluesky', createdAt: '2025-01-01T00:00:00Z' },
              likeCount: 10,
              replyCount: 2,
              repostCount: 1,
            },
          ],
        }),
        { ok: true } as any
      );
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 } as any);
  }) as any;

  const client = new BlueskyClient(ctx);
  const result = await client.search('bluesky');

  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].uri, 'at://did:plc:456/app.bsky.feed.post/search1');
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('search respects limit parameter', async () => {
  setupFetchMocks();

  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  global.fetch = ((url: string, options?: RequestInit) => {
    if (url.includes('searchPosts') && url.includes('limit=50')) {
      return new Response(JSON.stringify({ posts: [] }), { ok: true } as any);
    }
    return new Response(JSON.stringify({ error: 'Wrong limit' }), { status: 400 } as any);
  }) as any;

  const client = new BlueskyClient(ctx);
  const result = await client.search('test', 50);

  assert.deepEqual(result.posts, []);
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('post handles network error gracefully', async () => {
  setupFetchMocks();

  global.fetch = async () => {
    throw new Error('Network error');
  };

  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });
  const client = new BlueskyClient(ctx);

  const result = await client.post('Hello world');

  assert.equal(result.uri, '');
  assert.equal(result.cid, '');
  assert.ok(result.error);
  assert.ok(result.error.includes('Failed to post'));

  teardownFetchMocks();
});

test('readFeed handles network error gracefully', async () => {
  setupFetchMocks();

  global.fetch = async () => {
    throw new Error('Network error');
  };

  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });
  const client = new BlueskyClient(ctx);

  const result = await client.readFeed();

  assert.deepEqual(result.posts, []);
  assert.ok(result.error);
  assert.ok(result.error.includes('Failed to read feed'));

  teardownFetchMocks();
});

test('search handles network error gracefully', async () => {
  setupFetchMocks();

  global.fetch = async () => {
    throw new Error('Network error');
  };

  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });
  const client = new BlueskyClient(ctx);

  const result = await client.search('test');

  assert.deepEqual(result.posts, []);
  assert.ok(result.error);
  assert.ok(result.error.includes('Failed to search'));

  teardownFetchMocks();
});
