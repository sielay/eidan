// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `social-instagram` plugin — post/search/read on Instagram.
//
// Per-account OAuth: the operator connects one or more Instagram accounts in the Connections screen.
// Each account's OAuth client (sealed under client_vault_key) + access token (token key) live in the
// vault; the registry rows live in plugin_social_instagram.accounts. At call time the tools pick the
// requested account (or the first), resolve an access token via the connections kit, then call the
// Instagram Graph API. Falls back to the legacy single INSTAGRAM_ACCESS_TOKEN secret when no account
// is connected, so older setups keep working.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import {
  type AccountStore,
  type SealFn,
  AccountResolveError,
  NotConnectedError,
  resolveAccessToken,
} from '@eidandev/connections-kit';
import { InstagramClient, InstagramAPIError, InstagramPostError } from './client.js';
import { instagramAdapter } from './adapter.js';
import { secretOpt } from './vault.js';

const ACCOUNT_PROP = {
  account: {
    type: 'string',
    description: 'Which connected Instagram account (name or slug). Omit to use the first connected account.',
  },
} as const;

const POST_FEED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'image_url'],
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      maxLength: 2200,
      description: 'Post caption (max 2200 characters).',
    },
    image_url: {
      type: 'string',
      format: 'uri',
      description: 'Public image URL to post (JPEG or PNG, min 1080x1350 px).',
    },
    ...ACCOUNT_PROP,
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'Hashtag to search for (# prefix optional and will be stripped if present). Only hashtag search is supported.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max results (default 20).',
    },
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
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max posts (default 20).',
    },
    ...ACCOUNT_PROP,
  },
};

// Resolve an Instagram client for the selected account: registry first, then the legacy single
// INSTAGRAM_ACCESS_TOKEN secret. Returns an error string when nothing usable resolves.
async function resolveClient(
  ctx: ToolContext,
  store: AccountStore | null,
  seal: SealFn | undefined,
  account: string | undefined,
): Promise<{ client?: InstagramClient; error?: string }> {
  if (store) {
    try {
      const { accessToken } = await resolveAccessToken(store, instagramAdapter, ctx, {
        ...(account ? { accountSelector: account } : {}),
        ...(seal ? { seal } : {}),
      });
      return { client: new InstagramClient(accessToken) };
    } catch (exc) {
      if (exc instanceof AccountResolveError) return { error: exc.message };
      if (!(exc instanceof NotConnectedError)) {
        return { error: exc instanceof Error ? exc.message : 'failed to resolve Instagram account' };
      }
      // NotConnectedError → fall through to the legacy single-secret path.
    }
  }
  const token = await secretOpt(ctx, 'INSTAGRAM_ACCESS_TOKEN');
  if (token) return { client: new InstagramClient(token) };
  return {
    error:
      "Instagram isn't connected — add an account under Connections, or set the legacy INSTAGRAM_ACCESS_TOKEN vault secret.",
  };
}

export function makeInstagramTools(store: AccountStore | null, seal?: SealFn): Tool[] {
  const instagramPostFeedTool: Tool = {
    name: 'instagram_post_feed',
    description:
      'Post an image with caption to a connected Instagram feed. Requires a public image URL (JPEG or PNG, min 1080x1350 px). Use `account` to pick which connected Instagram account.',
    inputSchema: POST_FEED_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { text?: string; image_url?: string; account?: string };
        const text = String(args.text ?? '').trim();
        const imageUrl = String(args.image_url ?? '').trim();

        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }

        if (!imageUrl) {
          yield { type: 'error', message: 'image_url is required' };
          return;
        }

        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Instagram client' };
          return;
        }

        try {
          const result = await client.postMedia(imageUrl, text);
          yield {
            type: 'result',
            value: {
              id: result.id,
              caption: text,
              image_url: imageUrl,
              message: 'Posted to Instagram',
            },
          };
        } catch (err) {
          if (err instanceof InstagramPostError) {
            yield { type: 'error', message: err.message };
          } else {
            throw err;
          }
        }
      },
    },
  };

  const instagramSearchTool: Tool = {
    name: 'instagram_search',
    description:
      'Search Instagram hashtags and view recent posts under those hashtags. Returns hashtag metadata and recent media. Note: This tool searches hashtags only; user and keyword search are not supported by Instagram Graph API. Use `account` to pick which connected Instagram account.',
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
          yield { type: 'error', message: error ?? 'Failed to create Instagram client' };
          return;
        }

        try {
          const hashtag = await client.searchHashtag(query);
          if (!hashtag) {
            yield {
              type: 'result',
              value: {
                query,
                posts: [],
                count: 0,
                message: 'Hashtag not found',
              },
            };
            return;
          }

          const media = await client.getHashtagMedia(hashtag.id, Number(args.limit) || 20);

          yield {
            type: 'result',
            value: {
              query,
              hashtag: hashtag.name,
              posts: media.map((post) => ({
                id: post.id,
                caption: post.caption || '',
                media_type: post.media_type,
                permalink: post.permalink,
                likes: post.like_count ?? 0,
                comments: post.comments_count ?? 0,
                timestamp: post.timestamp,
              })),
              count: media.length,
            },
          };
        } catch (err) {
          if (err instanceof InstagramAPIError) {
            yield { type: 'error', message: err.message };
          } else {
            throw err;
          }
        }
      },
    },
  };

  const instagramGetProfileTool: Tool = {
    name: 'instagram_get_profile',
    description:
      "Get a connected Instagram account's profile information including followers, bio, follower/following counts, and verification status. Use `account` to pick which connected Instagram account.",
    inputSchema: PROFILE_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { account?: string };
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Instagram client' };
          return;
        }

        const profile = await client.getAuthenticatedUser();

        if (!profile) {
          yield { type: 'error', message: 'Profile not found' };
        } else {
          yield {
            type: 'result',
            value: {
              username: profile.username,
              name: profile.name || profile.username,
              bio: profile.biography || '',
              followers: profile.followers_count ?? 0,
              following: profile.follows_count ?? 0,
              posts: profile.media_count ?? 0,
              profile_picture: profile.profile_picture_url || '',
              is_professional: profile.is_professional_account ?? false,
              website: profile.website || '',
              id: profile.id,
            },
          };
        }
      },
    },
  };

  const instagramListFeedTool: Tool = {
    name: 'instagram_list_feed',
    description:
      "Get a connected Instagram account's recent posts from your feed/account. Returns post captions, engagement metrics, and media URLs. Use `account` to pick which connected Instagram account.",
    inputSchema: FEED_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { limit?: number; account?: string };
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Instagram client' };
          return;
        }

        try {
          const feed = await client.getUserFeed(Number(args.limit) || 20);

          if (feed.length === 0) {
            yield {
              type: 'result',
              value: {
                posts: [],
                count: 0,
                message: 'No posts found in your feed',
              },
            };
          } else {
            yield {
              type: 'result',
              value: {
                posts: feed.map((post) => ({
                  id: post.id,
                  caption: post.caption || '',
                  media_type: post.media_type,
                  media_url: post.media_url || '',
                  permalink: post.permalink,
                  likes: post.like_count ?? 0,
                  comments: post.comments_count ?? 0,
                  timestamp: post.timestamp,
                })),
                count: feed.length,
              },
            };
          }
        } catch (err) {
          if (err instanceof InstagramAPIError) {
            yield { type: 'error', message: err.message };
          } else {
            throw err;
          }
        }
      },
    },
  };

  return [instagramPostFeedTool, instagramSearchTool, instagramGetProfileTool, instagramListFeedTool];
}
