// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { InstagramClient, InstagramAuthError, InstagramAPIError, InstagramPostError } from './client.js';

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
      description: 'Hashtag to search for (without # prefix). Only hashtag search is supported.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max results (default 20).',
    },
  },
};

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
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
  },
};

export function makeInstagramTools(): Tool[] {
  const instagramPostFeedTool: Tool = {
    name: 'instagram_post_feed',
    description:
      'Post an image with caption to your Instagram feed. Requires a public image URL. The image must be JPEG or PNG format, minimum 1080x1350 pixels. Requires INSTAGRAM_ACCESS_TOKEN vault secret (long-lived OAuth2 token from Instagram Graph API).',
    inputSchema: POST_FEED_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { text?: string; image_url?: string };
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

        const client = new InstagramClient(ctx);

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
          if (err instanceof InstagramAuthError) {
            yield { type: 'error', message: "Instagram isn't connected — set INSTAGRAM_ACCESS_TOKEN in vault/env (Settings → Connections)" };
          } else if (err instanceof InstagramPostError) {
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
      'Search Instagram hashtags and view recent posts under those hashtags. Returns hashtag metadata and recent media. Note: This tool searches hashtags only; user and keyword search are not supported by Instagram Graph API. Requires INSTAGRAM_ACCESS_TOKEN vault secret.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const client = new InstagramClient(ctx);

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
          if (err instanceof InstagramAuthError) {
            yield { type: 'error', message: "Instagram isn't connected — set INSTAGRAM_ACCESS_TOKEN in vault/env (Settings → Connections)" };
          } else if (err instanceof InstagramAPIError) {
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
      'Get authenticated user Instagram profile information including followers, bio, follower/following counts, and verification status. Requires INSTAGRAM_ACCESS_TOKEN vault secret.',
    inputSchema: PROFILE_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const client = new InstagramClient(ctx);

        try {
          const profile = await client.getAuthenticatedUser();

          if (!profile) {
            yield { type: 'error', message: "Instagram isn't connected — set INSTAGRAM_ACCESS_TOKEN in vault/env (Settings → Connections)" };
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
        } catch (err) {
          if (err instanceof InstagramAuthError) {
            yield { type: 'error', message: "Instagram isn't connected — set INSTAGRAM_ACCESS_TOKEN in vault/env (Settings → Connections)" };
          } else {
            throw err;
          }
        }
      },
    },
  };

  const instagramListFeedTool: Tool = {
    name: 'instagram_list_feed',
    description:
      'Get authenticated user recent Instagram posts from your feed/account. Returns post captions, engagement metrics, and media URLs. Requires INSTAGRAM_ACCESS_TOKEN vault secret.',
    inputSchema: FEED_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { limit?: number };
        const client = new InstagramClient(ctx);

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
          if (err instanceof InstagramAuthError) {
            yield { type: 'error', message: "Instagram isn't connected — set INSTAGRAM_ACCESS_TOKEN in vault/env (Settings → Connections)" };
          } else if (err instanceof InstagramAPIError) {
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
