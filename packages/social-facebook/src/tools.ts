// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `social-facebook` plugin — post/search/read on Facebook.
//
// Per-account OAuth: the operator connects one or more Facebook accounts in the Connections screen.
// Each account's OAuth client + access token live in the vault; the registry rows live in
// plugin_social_facebook.accounts. At call time the tools pick the requested account (or the first),
// resolve an access token via the connections kit, then call the Graph API. Falls back to the legacy
// single FACEBOOK_ACCESS_TOKEN secret (and optional FACEBOOK_PAGE_ID) when no account is connected,
// so older setups keep working.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import {
  type AccountStore,
  type SealFn,
  AccountResolveError,
  NotConnectedError,
  resolveAccessToken,
} from '@eidandev/connections-kit';
import { FacebookClient } from './client.js';
import { facebookAdapter } from './adapter.js';
import { secretOpt } from './vault.js';

const ACCOUNT_PROP = {
  account: {
    type: 'string',
    description: 'Which connected Facebook account (name or slug). Omit to use the first connected account.',
  },
} as const;

const POST_FEED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      description: 'Post text content.',
    },
    image_url: {
      type: 'string',
      description: 'Optional image URL to attach to the post.',
    },
    ...ACCOUNT_PROP,
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search query (keywords, hashtags, user names).' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 20).' },
    ...ACCOUNT_PROP,
  },
};

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ...ACCOUNT_PROP },
};

const FEED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max posts (default 20).' },
    ...ACCOUNT_PROP,
  },
};

// Resolve a Facebook client for the selected account: registry first, then the legacy single
// FACEBOOK_ACCESS_TOKEN secret (with optional FACEBOOK_PAGE_ID). Returns an error string when nothing
// usable resolves.
async function resolveClient(
  ctx: ToolContext,
  store: AccountStore | null,
  seal: SealFn | undefined,
  account: string | undefined,
): Promise<{ client?: FacebookClient; error?: string }> {
  if (store) {
    try {
      const { accessToken } = await resolveAccessToken(store, facebookAdapter, ctx, {
        ...(account ? { accountSelector: account } : {}),
        ...(seal ? { seal } : {}),
      });
      return { client: new FacebookClient(accessToken) };
    } catch (exc) {
      if (exc instanceof AccountResolveError) return { error: exc.message };
      if (!(exc instanceof NotConnectedError)) {
        return { error: exc instanceof Error ? exc.message : 'failed to resolve Facebook account' };
      }
      // NotConnectedError → fall through to the legacy single-secret path.
    }
  }
  const token = await secretOpt(ctx, 'FACEBOOK_ACCESS_TOKEN');
  if (token) {
    const pageId = (await secretOpt(ctx, 'FACEBOOK_PAGE_ID')) ?? '';
    return { client: new FacebookClient(token, pageId) };
  }
  return {
    error:
      "Facebook isn't connected — add an account under Connections, or set the legacy FACEBOOK_ACCESS_TOKEN vault secret.",
  };
}

export function makeFacebookTools(store: AccountStore | null, seal?: SealFn): Tool[] {
  const facebookPostFeedTool: Tool = {
    name: 'facebook_post_feed',
    description:
      "Post a message to a connected Facebook feed or page. Optionally attach an image URL. Use `account` to pick which connected Facebook account.",
    inputSchema: POST_FEED_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { text?: string; image_url?: string; account?: string };
        const text = String(args.text ?? '').trim();

        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }

        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Facebook client' };
          return;
        }

        const result = await client.postFeed(text, args.image_url);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              id: result.id,
              text,
              message: 'Posted to Facebook',
            },
          };
        }
      },
    },
  };

  const facebookSearchTool: Tool = {
    name: 'facebook_search',
    description:
      'Search Facebook for posts by keyword, hashtag, or user name. Use `account` to pick which connected Facebook account.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { query?: string; limit?: number; account?: string };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Facebook client' };
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
                message: post.message || post.story || '(no text)',
                type: post.type,
                created: post.created_time,
                likes: post.likes?.summary?.total_count ?? 0,
                comments: post.comments?.summary?.total_count ?? 0,
                shares: post.shares?.data?.length ?? 0,
              })),
              count: result.posts.length,
            },
          };
        }
      },
    },
  };

  const facebookGetProfileTool: Tool = {
    name: 'facebook_get_profile',
    description:
      "Get a connected Facebook account's profile info (name, friend count, bio). Use `account` to pick which connected Facebook account.",
    inputSchema: PROFILE_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { account?: string };
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Facebook client' };
          return;
        }

        const result = await client.getProfile();

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else if (result.profile) {
          yield {
            type: 'result',
            value: {
              id: result.profile.id,
              name: result.profile.name,
              bio: result.profile.bio || '(no bio)',
              friends_count: result.profile.friends?.summary?.total_count ?? 0,
              picture_url: result.profile.picture?.data?.url || undefined,
            },
          };
        }
      },
    },
  };

  const facebookListFeedTool: Tool = {
    name: 'facebook_list_feed',
    description:
      "Read a connected Facebook feed or page timeline. Returns recent posts with engagement metrics (likes, comments, shares). Use `account` to pick which connected Facebook account.",
    inputSchema: FEED_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { limit?: number; account?: string };

        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Facebook client' };
          return;
        }

        const result = await client.listFeed(Number(args.limit) || 20);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              posts: result.posts.map((post) => ({
                id: post.id,
                message: post.message || post.story || '(no text)',
                type: post.type,
                created: post.created_time,
                likes: post.likes?.summary?.total_count ?? 0,
                comments: post.comments?.summary?.total_count ?? 0,
                shares: post.shares?.data?.length ?? 0,
                link: post.link,
              })),
              count: result.posts.length,
            },
          };
        }
      },
    },
  };

  return [facebookPostFeedTool, facebookSearchTool, facebookGetProfileTool, facebookListFeedTool];
}
