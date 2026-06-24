// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `social-threads` plugin — post/search/read on Meta Threads.
//
// Per-account OAuth: the operator connects one or more Threads accounts in the Connections screen.
// Each account's OAuth client + access token live in the vault; the registry rows live in
// plugin_social_threads.accounts. At call time the tools pick the requested account (or the first),
// resolve an access token via the connections kit, then call the Threads API. Falls back to the
// legacy single THREADS_ACCESS_TOKEN secret when no account is connected, so older setups keep
// working.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import {
  type AccountStore,
  type SealFn,
  AccountResolveError,
  NotConnectedError,
  resolveAccessToken,
} from '@eidandev/connections-kit';
import { ThreadsClient } from './client.js';
import { threadsAdapter } from './adapter.js';
import { secretOpt } from './vault.js';

const ACCOUNT_PROP = {
  account: {
    type: 'string',
    description: 'Which connected Threads account (name or slug). Omit to use the first connected account.',
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
      maxLength: 500,
      description: 'Post text (max 500 characters).',
    },
    reply_to: {
      type: 'string',
      description: 'Optional thread ID to reply to.',
    },
    ...ACCOUNT_PROP,
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search text (keywords, hashtags).' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 20).' },
    ...ACCOUNT_PROP,
  },
};

const TIMELINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max posts (default 20).' },
    ...ACCOUNT_PROP,
  },
};

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ...ACCOUNT_PROP },
};

// Resolve a Threads client for the selected account: registry first, then the legacy single
// THREADS_ACCESS_TOKEN secret. Returns an error string when nothing usable resolves.
async function resolveClient(
  ctx: ToolContext,
  store: AccountStore | null,
  seal: SealFn | undefined,
  account: string | undefined,
): Promise<{ client?: ThreadsClient; error?: string }> {
  if (store) {
    try {
      const { accessToken } = await resolveAccessToken(store, threadsAdapter, ctx, {
        ...(account ? { accountSelector: account } : {}),
        ...(seal ? { seal } : {}),
      });
      return { client: new ThreadsClient(accessToken) };
    } catch (exc) {
      if (exc instanceof AccountResolveError) return { error: exc.message };
      if (!(exc instanceof NotConnectedError)) {
        return { error: exc instanceof Error ? exc.message : 'failed to resolve Threads account' };
      }
      // NotConnectedError → fall through to the legacy single-secret path.
    }
  }
  const token = await secretOpt(ctx, 'THREADS_ACCESS_TOKEN');
  if (token) return { client: new ThreadsClient(token) };
  return {
    error:
      "Threads isn't connected — add an account under Connections, or set the legacy THREADS_ACCESS_TOKEN vault secret.",
  };
}

export function makeThreadsTools(store: AccountStore | null, seal?: SealFn): Tool[] {
  const threadsPostTool: Tool = {
    name: 'threads_post_thread',
    description:
      'Post a message to a connected Threads account. Supports text up to 500 characters. Optionally reply to an existing thread. Use `account` to pick which connected Threads account.',
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
          yield { type: 'error', message: error ?? 'Failed to create Threads client' };
          return;
        }

        const result = await client.post(text, args.reply_to);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              id: result.id,
              text,
              message: `Posted to Threads`,
            },
          };
        }
      },
    },
  };

  const threadsSearchTool: Tool = {
    name: 'threads_search',
    description:
      'Search for hashtags on Threads by keyword. Returns matching hashtags found on the platform. Use `account` to pick which connected Threads account.',
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
          yield { type: 'error', message: error ?? 'Failed to create Threads client' };
          return;
        }

        const result = await client.search(query, Number(args.limit) || 20);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              query,
              posts: result.posts.map((post) => ({
                id: post.id,
                text: post.text || '',
                author: post.author.username,
                timestamp: post.timestamp,
                likes: post.like_count ?? 0,
                replies: post.reply_count ?? 0,
                reposts: post.repost_count ?? 0,
                permalink: post.permalink,
              })),
              count: result.posts.length,
            },
          };
        }
      },
    },
  };

  const threadsGetProfileTool: Tool = {
    name: 'threads_get_profile',
    description:
      "Get a connected Threads account's profile, including follower count, bio, and verification status. Use `account` to pick which connected Threads account.",
    inputSchema: PROFILE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { account?: string };
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Threads client' };
          return;
        }

        const result = await client.getProfile();

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else if (!result.user) {
          yield { type: 'error', message: 'Failed to retrieve profile' };
        } else {
          yield {
            type: 'result',
            value: {
              id: result.user.id,
              username: result.user.username,
              name: result.user.name || 'No name',
              biography: result.user.biography || 'No bio',
              followers: result.user.follower_count ?? 0,
              following: result.user.following_count ?? 0,
              verified: result.user.is_verified ?? false,
              website: result.user.website || '',
              profile_picture_url: result.user.profile_picture_url || '',
            },
          };
        }
      },
    },
  };

  const threadsListTimelineTool: Tool = {
    name: 'threads_list_timeline',
    description:
      "Read a connected Threads account's timeline (their recent posts). Returns posts with engagement metrics. Use `account` to pick which connected Threads account.",
    inputSchema: TIMELINE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { limit?: number; account?: string };
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Threads client' };
          return;
        }

        const result = await client.listTimeline(Number(args.limit) || 20);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              posts: result.posts.map((post) => ({
                id: post.id,
                text: post.text || '',
                timestamp: post.timestamp,
                permalink: post.permalink,
                likes: post.like_count ?? 0,
                replies: post.reply_count ?? 0,
                reposts: post.repost_count ?? 0,
              })),
              count: result.posts.length,
            },
          };
        }
      },
    },
  };

  return [threadsPostTool, threadsSearchTool, threadsGetProfileTool, threadsListTimelineTool];
}
