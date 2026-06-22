// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBlueskyTools } from './tools.js';
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

const collectYields = async (generator: AsyncIterable<any>): Promise<Array<any>> => {
  const results: Array<any> = [];
  for await (const item of generator) {
    results.push(item);
  }
  return results;
};

test('makeBlueskyTools returns three tools', () => {
  const tools = makeBlueskyTools();
  assert.equal(tools.length, 3);

  const names = tools.map((t) => t.name);
  assert.ok(names.includes('bluesky_post'));
  assert.ok(names.includes('bluesky_search'));
  assert.ok(names.includes('bluesky_read_feed'));
});

test('bluesky_post tool has correct schema', () => {
  const tools = makeBlueskyTools();
  const postTool = tools.find((t) => t.name === 'bluesky_post');

  assert.ok(postTool);
  const schema = postTool?.inputSchema as any;
  assert.equal(schema.type, 'object');
  assert.ok(schema.required.includes('text'));
  assert.ok(schema.properties.text);
  assert.ok(schema.properties.reply_to);
});

test('bluesky_search tool has correct schema', () => {
  const tools = makeBlueskyTools();
  const searchTool = tools.find((t) => t.name === 'bluesky_search');

  assert.ok(searchTool);
  const schema = searchTool?.inputSchema as any;
  assert.equal(schema.type, 'object');
  assert.ok(schema.required.includes('query'));
  assert.ok(schema.properties.query);
  assert.ok(schema.properties.limit);
});

test('bluesky_read_feed tool has correct schema', () => {
  const tools = makeBlueskyTools();
  const feedTool = tools.find((t) => t.name === 'bluesky_read_feed');

  assert.ok(feedTool);
  const schema = feedTool?.inputSchema as any;
  assert.equal(schema.type, 'object');
  assert.ok(schema.properties.limit);
});

test('bluesky_post executor rejects empty text', async () => {
  setupFetchMocks();
  const tools = makeBlueskyTools();
  const postTool = tools.find((t) => t.name === 'bluesky_post');
  const ctx = mockCtx();

  const results = await collectYields(postTool!.executor.execute({}, ctx));

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.ok(results[0].message.includes('text is required'));

  teardownFetchMocks();
});

test('bluesky_post executor rejects when no text provided', async () => {
  setupFetchMocks();
  const tools = makeBlueskyTools();
  const postTool = tools.find((t) => t.name === 'bluesky_post');
  const ctx = mockCtx();

  const results = await collectYields(
    postTool!.executor.execute({ text: '' }, ctx)
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.ok(results[0].message.includes('text is required'));

  teardownFetchMocks();
});

test('bluesky_post executor yields error when not authenticated', async () => {
  setupFetchMocks();
  const tools = makeBlueskyTools();
  const postTool = tools.find((t) => t.name === 'bluesky_post');
  const ctx = mockCtx({});

  const results = await collectYields(
    postTool!.executor.execute({ text: 'Hello world' }, ctx)
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.ok(results[0].message.includes("isn't connected"));

  teardownFetchMocks();
});

test('bluesky_post executor succeeds with valid credentials', async () => {
  setupFetchMocks();

  fetchResponses.set(`https://bsky.social/xrpc/com.atproto.repo.createRecord`, {
    ok: true,
    json: async () => ({
      uri: 'at://did:plc:123/app.bsky.feed.post/abc123',
      cid: 'bafy123',
    }),
  } as any);

  const tools = makeBlueskyTools();
  const postTool = tools.find((t) => t.name === 'bluesky_post');
  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  const results = await collectYields(
    postTool!.executor.execute({ text: 'Hello world' }, ctx)
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.uri, 'at://did:plc:123/app.bsky.feed.post/abc123');
  assert.equal(results[0].value.cid, 'bafy123');
  assert.equal(results[0].value.text, 'Hello world');
  assert.ok(results[0].value.message.includes('Posted'));

  teardownFetchMocks();
});

test('bluesky_post executor uses custom BLUESKY_SERVICE', async () => {
  setupFetchMocks();

  let customServiceCalled = false;
  global.fetch = ((url: string, options?: RequestInit) => {
    if (url.includes('https://custom.service')) {
      customServiceCalled = true;
      return new Response(
        JSON.stringify({
          uri: 'at://did:plc:123/app.bsky.feed.post/abc123',
          cid: 'bafy123',
        }),
        { ok: true } as any
      );
    }
    return new Response(JSON.stringify({ error: 'Wrong service' }), { status: 400 } as any);
  }) as any;

  const tools = makeBlueskyTools();
  const postTool = tools.find((t) => t.name === 'bluesky_post');
  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
    BLUESKY_SERVICE: 'https://custom.service',
  });

  await collectYields(postTool!.executor.execute({ text: 'Hello' }, ctx));

  assert.ok(customServiceCalled);

  teardownFetchMocks();
});

test('bluesky_search executor rejects empty query', async () => {
  setupFetchMocks();
  const tools = makeBlueskyTools();
  const searchTool = tools.find((t) => t.name === 'bluesky_search');
  const ctx = mockCtx();

  const results = await collectYields(searchTool!.executor.execute({}, ctx));

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.ok(results[0].message.includes('query is required'));

  teardownFetchMocks();
});

test('bluesky_search executor rejects when no query provided', async () => {
  setupFetchMocks();
  const tools = makeBlueskyTools();
  const searchTool = tools.find((t) => t.name === 'bluesky_search');
  const ctx = mockCtx();

  const results = await collectYields(
    searchTool!.executor.execute({ query: '' }, ctx)
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.ok(results[0].message.includes('query is required'));

  teardownFetchMocks();
});

test('bluesky_search executor yields error when not authenticated', async () => {
  setupFetchMocks();
  const tools = makeBlueskyTools();
  const searchTool = tools.find((t) => t.name === 'bluesky_search');
  const ctx = mockCtx({});

  const results = await collectYields(
    searchTool!.executor.execute({ query: 'bluesky' }, ctx)
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.ok(results[0].message.includes("isn't connected"));

  teardownFetchMocks();
});

test('bluesky_search executor succeeds with valid credentials', async () => {
  setupFetchMocks();

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

  const tools = makeBlueskyTools();
  const searchTool = tools.find((t) => t.name === 'bluesky_search');
  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  const results = await collectYields(
    searchTool!.executor.execute({ query: 'bluesky', limit: 20 }, ctx)
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.query, 'bluesky');
  assert.equal(results[0].value.count, 1);
  assert.equal(results[0].value.posts.length, 1);
  assert.equal(results[0].value.posts[0].uri, 'at://did:plc:456/app.bsky.feed.post/search1');

  teardownFetchMocks();
});

test('bluesky_search executor uses default limit', async () => {
  setupFetchMocks();

  global.fetch = ((url: string, options?: RequestInit) => {
    if (url.includes('searchPosts') && url.includes('limit=20')) {
      return new Response(
        JSON.stringify({
          posts: [],
        }),
        { ok: true } as any
      );
    }
    return new Response(JSON.stringify({ error: 'Wrong limit' }), { status: 400 } as any);
  }) as any;

  const tools = makeBlueskyTools();
  const searchTool = tools.find((t) => t.name === 'bluesky_search');
  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  const results = await collectYields(
    searchTool!.executor.execute({ query: 'test' }, ctx)
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');

  teardownFetchMocks();
});

test('bluesky_read_feed executor yields error when not authenticated', async () => {
  setupFetchMocks();
  const tools = makeBlueskyTools();
  const feedTool = tools.find((t) => t.name === 'bluesky_read_feed');
  const ctx = mockCtx({});

  const results = await collectYields(feedTool!.executor.execute({}, ctx));

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.ok(results[0].message.includes("isn't connected"));

  teardownFetchMocks();
});

test('bluesky_read_feed executor succeeds with valid credentials', async () => {
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
                author: { did: 'did:plc:123', handle: 'user.bsky.social', displayName: 'User' },
                record: { text: 'Post 1', createdAt: '2025-01-01T00:00:00Z' },
                likeCount: 5,
                replyCount: 1,
                repostCount: 0,
              },
            },
          ],
        }),
        { ok: true } as any
      );
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 } as any);
  }) as any;

  const tools = makeBlueskyTools();
  const feedTool = tools.find((t) => t.name === 'bluesky_read_feed');
  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  const results = await collectYields(feedTool!.executor.execute({}, ctx));

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.count, 1);
  assert.equal(results[0].value.posts.length, 1);
  assert.equal(results[0].value.posts[0].uri, 'at://did:plc:123/app.bsky.feed.post/post1');

  teardownFetchMocks();
});

test('bluesky_read_feed executor respects limit parameter', async () => {
  setupFetchMocks();

  global.fetch = ((url: string, options?: RequestInit) => {
    if (url.includes('getAuthorFeed') && url.includes('limit=50')) {
      return new Response(
        JSON.stringify({
          feed: [],
        }),
        { ok: true } as any
      );
    }
    return new Response(JSON.stringify({ error: 'Wrong limit' }), { status: 400 } as any);
  }) as any;

  const tools = makeBlueskyTools();
  const feedTool = tools.find((t) => t.name === 'bluesky_read_feed');
  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  const results = await collectYields(feedTool!.executor.execute({ limit: 50 }, ctx));

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');

  teardownFetchMocks();
});

test('bluesky_read_feed executor uses default limit', async () => {
  setupFetchMocks();

  global.fetch = ((url: string, options?: RequestInit) => {
    if (url.includes('getAuthorFeed') && url.includes('limit=20')) {
      return new Response(
        JSON.stringify({
          feed: [],
        }),
        { ok: true } as any
      );
    }
    return new Response(JSON.stringify({ error: 'Wrong limit' }), { status: 400 } as any);
  }) as any;

  const tools = makeBlueskyTools();
  const feedTool = tools.find((t) => t.name === 'bluesky_read_feed');
  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  const results = await collectYields(feedTool!.executor.execute({}, ctx));

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');

  teardownFetchMocks();
});

test('search tool formats post data correctly', async () => {
  setupFetchMocks();

  global.fetch = ((url: string, options?: RequestInit) => {
    if (url.includes('searchPosts')) {
      return new Response(
        JSON.stringify({
          posts: [
            {
              uri: 'at://did:plc:456/app.bsky.feed.post/search1',
              cid: 'bafy-search1',
              author: { did: 'did:plc:456', handle: 'author.bsky.social', displayName: 'Author Name' },
              record: { text: 'Post content', createdAt: '2025-01-01T00:00:00Z' },
              likeCount: 100,
              replyCount: 10,
              repostCount: 5,
            },
          ],
        }),
        { ok: true } as any
      );
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 } as any);
  }) as any;

  const tools = makeBlueskyTools();
  const searchTool = tools.find((t) => t.name === 'bluesky_search');
  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  const results = await collectYields(
    searchTool!.executor.execute({ query: 'test' }, ctx)
  );

  const post = results[0].value.posts[0];
  assert.equal(post.author, 'author.bsky.social (Author Name)');
  assert.equal(post.text, 'Post content');
  assert.equal(post.likes, 100);
  assert.equal(post.replies, 10);
  assert.equal(post.reposts, 5);

  teardownFetchMocks();
});

test('read_feed tool formats post data correctly', async () => {
  setupFetchMocks();

  global.fetch = ((url: string, options?: RequestInit) => {
    if (url.includes('getAuthorFeed')) {
      return new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:456/app.bsky.feed.post/post1',
                cid: 'bafy1',
                author: { did: 'did:plc:456', handle: 'author.bsky.social', displayName: 'Author Name' },
                record: { text: 'Feed post', createdAt: '2025-01-01T00:00:00Z' },
                likeCount: 50,
                replyCount: 5,
                repostCount: 2,
              },
            },
          ],
        }),
        { ok: true } as any
      );
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 } as any);
  }) as any;

  const tools = makeBlueskyTools();
  const feedTool = tools.find((t) => t.name === 'bluesky_read_feed');
  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  const results = await collectYields(feedTool!.executor.execute({}, ctx));

  const post = results[0].value.posts[0];
  assert.equal(post.author, 'author.bsky.social (Author Name)');
  assert.equal(post.text, 'Feed post');
  assert.equal(post.likes, 50);
  assert.equal(post.replies, 5);
  assert.equal(post.reposts, 2);
  assert.equal(post.created, '2025-01-01T00:00:00Z');

  teardownFetchMocks();
});

test('tools handle missing author display name', async () => {
  setupFetchMocks();

  global.fetch = ((url: string, options?: RequestInit) => {
    if (url.includes('searchPosts')) {
      return new Response(
        JSON.stringify({
          posts: [
            {
              uri: 'at://did:plc:456/app.bsky.feed.post/search1',
              cid: 'bafy-search1',
              author: { did: 'did:plc:456', handle: 'author.bsky.social' },
              record: { text: 'Post', createdAt: '2025-01-01T00:00:00Z' },
              likeCount: 0,
              replyCount: 0,
              repostCount: 0,
            },
          ],
        }),
        { ok: true } as any
      );
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 } as any);
  }) as any;

  const tools = makeBlueskyTools();
  const searchTool = tools.find((t) => t.name === 'bluesky_search');
  const ctx = mockCtx({
    BLUESKY_HANDLE: 'user.bsky.social',
    BLUESKY_APP_PASSWORD: 'password123',
    BLUESKY_ACCESS_JWT: validJwt,
    BLUESKY_ACCESS_JWT_EXPIRY: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    BLUESKY_DID: 'did:plc:123',
  });

  const results = await collectYields(
    searchTool!.executor.execute({ query: 'test' }, ctx)
  );

  const post = results[0].value.posts[0];
  assert.ok(post.author.includes('No name'));

  teardownFetchMocks();
});
