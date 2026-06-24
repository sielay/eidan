// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `social-bluesky` plugin — post/search/read on Bluesky (AT Protocol).
//
// Per-account app passwords: the operator connects one or more Bluesky accounts in the Connections
// screen (handle + app password + optional service URL). Each account's app password is sealed under
// token_vault_key; the registry rows live in plugin_social_bluesky.accounts. At call time the tools
// pick the requested account (or the first), resolve the app password via the connections kit (for
// the app_password flavor the resolver returns the stored credential as-is), and build a client that
// mints a session JWT per call. Falls back to the legacy single BLUESKY_HANDLE / BLUESKY_APP_PASSWORD
// secrets when no account is connected, so older setups keep working.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import {
  type AccountStore,
  type SealFn,
  AccountResolveError,
  NotConnectedError,
  resolveAccessToken,
} from '@eidandev/connections-kit';
import { BlueskyClient } from './client.js';
import { blueskyAdapter } from './adapter.js';
import { secretOpt } from './vault.js';

const ACCOUNT_PROP = {
  account: {
    type: 'string',
    description: 'Which connected Bluesky account (name or slug). Omit to use the first connected account.',
  },
} as const;

const POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      maxLength: 300,
      description: 'Post text (max 300 characters / graphemes including emojis).',
    },
    reply_to: { type: 'string', description: 'Optional post URI to reply to (at://... format).' },
    ...ACCOUNT_PROP,
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search text (keywords, hashtags, @handles).' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 20).' },
    ...ACCOUNT_PROP,
  },
};

const FEED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max posts (default 20).' },
    ...ACCOUNT_PROP,
  },
};

interface BskyPost {
  uri?: string;
  author?: { handle?: string; displayName?: string };
  record?: { text?: string; createdAt?: string };
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
}

function shapePost(post: Record<string, unknown>): Record<string, unknown> {
  const p = post as BskyPost;
  return {
    uri: p.uri ?? '',
    author: `${p.author?.handle ?? ''} (${p.author?.displayName || 'No name'})`,
    text: p.record?.text || '',
    likes: p.likeCount ?? 0,
    replies: p.replyCount ?? 0,
    reposts: p.repostCount ?? 0,
    created: p.record?.createdAt || '',
  };
}

// Resolve a Bluesky client for the selected account: registry first (the app password is the resolved
// "token"), then the legacy single BLUESKY_HANDLE / BLUESKY_APP_PASSWORD secrets. Returns an error
// string when nothing usable resolves.
async function resolveClient(
  ctx: ToolContext,
  store: AccountStore | null,
  seal: SealFn | undefined,
  account: string | undefined,
): Promise<{ client?: BlueskyClient; error?: string }> {
  if (store) {
    try {
      const { accessToken, account: acct } = await resolveAccessToken(store, blueskyAdapter, ctx, {
        ...(account ? { accountSelector: account } : {}),
        ...(seal ? { seal } : {}),
      });
      // For app_password, accessToken IS the app password; external_handle is the Bluesky handle.
      return { client: new BlueskyClient(acct.external_handle, accessToken, acct.host || undefined) };
    } catch (exc) {
      if (exc instanceof AccountResolveError) return { error: exc.message };
      if (!(exc instanceof NotConnectedError)) {
        return { error: exc instanceof Error ? exc.message : 'failed to resolve Bluesky account' };
      }
      // NotConnectedError → fall through to the legacy single-secret path.
    }
  }
  const handle = await secretOpt(ctx, 'BLUESKY_HANDLE');
  const appPassword = await secretOpt(ctx, 'BLUESKY_APP_PASSWORD');
  const service = await secretOpt(ctx, 'BLUESKY_SERVICE');
  if (handle && appPassword) {
    return { client: new BlueskyClient(handle, appPassword, service || undefined) };
  }
  return {
    error:
      "Bluesky isn't connected — add an account under Connections, or set the legacy BLUESKY_HANDLE and BLUESKY_APP_PASSWORD vault secrets.",
  };
}

export function makeBlueskyTools(store: AccountStore | null, seal?: SealFn): Tool[] {
  const blueskyPostTool: Tool = {
    name: 'bluesky_post',
    description:
      "Post a message to a connected Bluesky account. Supports text, auto-detects URLs and #hashtags as facets, and an optional reply_to. Use `account` to pick which connected Bluesky account.",
    inputSchema: POST_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { text?: string; reply_to?: string; account?: string };
        const text = String(args.text ?? '').trim();
        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Bluesky client' };
          return;
        }
        const result = await client.post(text, args.reply_to);
        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: { uri: result.uri, cid: result.cid, text, message: 'Posted to Bluesky' },
          };
        }
      },
    },
  };

  const blueskySearchTool: Tool = {
    name: 'bluesky_search',
    description:
      'Search Bluesky for posts by keyword, hashtag, or @handle. Use `account` to pick which connected Bluesky account.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { query?: string; limit?: number; account?: string };
        const query = String(args.query ?? '').trim();
        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Bluesky client' };
          return;
        }
        const result = await client.search(query, Number(args.limit) || 20);
        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: { query, count: result.posts.length, posts: result.posts.map(shapePost) },
          };
        }
      },
    },
  };

  const blueskyReadFeedTool: Tool = {
    name: 'bluesky_read_feed',
    description:
      "Read a connected Bluesky account's feed (home timeline). Use `account` to pick which connected Bluesky account.",
    inputSchema: FEED_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { limit?: number; account?: string };
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Bluesky client' };
          return;
        }
        const result = await client.readFeed(Number(args.limit) || 20);
        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: { count: result.posts.length, posts: result.posts.map(shapePost) },
          };
        }
      },
    },
  };

  return [blueskyPostTool, blueskySearchTool, blueskyReadFeedTool];
}
