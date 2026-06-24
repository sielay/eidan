// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `social-x` plugin — post/search/read on X (Twitter).
//
// Per-account OAuth: the operator connects one or more X accounts in the Connections screen. Each
// account's OAuth client (sealed under client_vault_key) + access/refresh tokens (token/refresh keys)
// live in the vault; the registry rows live in plugin_social_x.accounts. At call time the tools pick
// the requested account (or the first), mint/refresh an access token via the connections kit, then
// call the X API. Falls back to the legacy single X_ACCESS_TOKEN secret when no account is connected,
// so older setups keep working.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import {
  type AccountStore,
  type SealFn,
  AccountResolveError,
  NotConnectedError,
  resolveAccessToken,
} from '@eidandev/connections-kit';
import { XClient } from './client.js';
import { xAdapter } from './adapter.js';
import { secretOpt } from './vault.js';

const ACCOUNT_PROP = {
  account: {
    type: 'string',
    description: 'Which connected X account (name or slug). Omit to use the first connected account.',
  },
} as const;

const POST_TWEET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 280, description: 'Tweet text (max 280 characters).' },
    reply_to: { type: 'string', description: 'Optional tweet ID to reply to.' },
    ...ACCOUNT_PROP,
  },
};
const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search query (keywords, #hashtags, from:@handle).' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 20).' },
    ...ACCOUNT_PROP,
  },
};
const GET_PROFILE_SCHEMA = { type: 'object', additionalProperties: false, properties: { ...ACCOUNT_PROP } };
const LIST_TIMELINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max tweets (default 20).' },
    ...ACCOUNT_PROP,
  },
};

// Resolve an X client for the selected account: registry first (with transparent refresh), then the
// legacy single X_ACCESS_TOKEN secret. Returns an error string when nothing usable resolves.
async function resolveClient(
  ctx: ToolContext,
  store: AccountStore | null,
  seal: SealFn | undefined,
  account: string | undefined,
): Promise<{ client?: XClient; error?: string }> {
  if (store) {
    try {
      const { accessToken } = await resolveAccessToken(store, xAdapter, ctx, {
        ...(account ? { accountSelector: account } : {}),
        ...(seal ? { seal } : {}),
      });
      return { client: new XClient(accessToken) };
    } catch (exc) {
      if (exc instanceof AccountResolveError) return { error: exc.message };
      if (!(exc instanceof NotConnectedError)) {
        return { error: exc instanceof Error ? exc.message : 'failed to resolve X account' };
      }
      // NotConnectedError → fall through to the legacy single-secret path.
    }
  }
  const token = await secretOpt(ctx, 'X_ACCESS_TOKEN');
  if (token) return { client: new XClient(token) };
  return {
    error:
      "X isn't connected — add an account under Connections, or set the legacy X_ACCESS_TOKEN vault secret.",
  };
}

export function makeXTools(store: AccountStore | null, seal?: SealFn): Tool[] {
  const postTweetTool: Tool = {
    name: 'x_post_tweet',
    description:
      "Post a tweet to a connected X account (up to 280 chars; optional reply_to). Use `account` to pick which connected X account.",
    inputSchema: POST_TWEET_SCHEMA,
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
          yield { type: 'error', message: error ?? 'Failed to create X client' };
          return;
        }
        const postResult = await client.postTweet(text, args.reply_to);
        if (postResult.error) {
          yield { type: 'error', message: postResult.error };
        } else {
          yield {
            type: 'result',
            value: {
              tweet_id: postResult.tweetId,
              text: postResult.text,
              url: `https://twitter.com/i/web/status/${postResult.tweetId}`,
              message: 'Posted to X',
            },
          };
        }
      },
    },
  };

  const searchTool: Tool = {
    name: 'x_search',
    description:
      'Search X (Twitter) for tweets by keyword, hashtag, or @handle. Use `account` to pick which connected X account.',
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
          yield { type: 'error', message: error ?? 'Failed to create X client' };
          return;
        }
        const searchResult = await client.searchTweets(query, Number(args.limit) || 20);
        if (searchResult.error) {
          yield { type: 'error', message: searchResult.error };
        } else {
          yield {
            type: 'result',
            value: {
              query,
              count: searchResult.tweets.length,
              tweets: searchResult.tweets.map((tweet) => ({
                id: tweet.id,
                text: tweet.text,
                author_id: tweet.author_id,
                created_at: tweet.created_at,
                likes: tweet.public_metrics?.like_count ?? 0,
                replies: tweet.public_metrics?.reply_count ?? 0,
                retweets: tweet.public_metrics?.retweet_count ?? 0,
                url: `https://twitter.com/i/web/status/${tweet.id}`,
              })),
            },
          };
        }
      },
    },
  };

  const getProfileTool: Tool = {
    name: 'x_get_profile',
    description:
      "Get a connected X account's profile (followers, bio, verification). Use `account` to pick which connected X account.",
    inputSchema: GET_PROFILE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { account?: string };
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create X client' };
          return;
        }
        const profileResult = await client.getMe();
        if (profileResult.error) {
          yield { type: 'error', message: profileResult.error };
        } else if (!profileResult.profile) {
          yield { type: 'error', message: 'Profile not found' };
        } else {
          yield {
            type: 'result',
            value: {
              id: profileResult.profile.id,
              name: profileResult.profile.name,
              username: profileResult.profile.username,
              description: profileResult.profile.description,
              followers: profileResult.profile.followers_count ?? 0,
              following: profileResult.profile.following_count ?? 0,
              tweets: profileResult.profile.tweet_count ?? 0,
              verified: profileResult.profile.verified ?? false,
              created_at: profileResult.profile.created_at,
              url: `https://twitter.com/${profileResult.profile.username}`,
            },
          };
        }
      },
    },
  };

  const listTimelineTool: Tool = {
    name: 'x_list_timeline',
    description:
      "Get a connected X account's recent tweets (timeline). Use `account` to pick which connected X account.",
    inputSchema: LIST_TIMELINE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { limit?: number; account?: string };
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create X client' };
          return;
        }
        const timelineResult = await client.getTimeline(Number(args.limit) || 20);
        if (timelineResult.error) {
          yield { type: 'error', message: timelineResult.error };
        } else {
          yield {
            type: 'result',
            value: {
              count: timelineResult.tweets.length,
              tweets: timelineResult.tweets.map((tweet) => ({
                id: tweet.id,
                text: tweet.text,
                created_at: tweet.created_at,
                likes: tweet.public_metrics?.like_count ?? 0,
                replies: tweet.public_metrics?.reply_count ?? 0,
                retweets: tweet.public_metrics?.retweet_count ?? 0,
                url: `https://twitter.com/i/web/status/${tweet.id}`,
              })),
            },
          };
        }
      },
    },
  };

  return [postTweetTool, searchTool, getProfileTool, listTimelineTool];
}
