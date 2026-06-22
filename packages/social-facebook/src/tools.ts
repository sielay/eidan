// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { FacebookClient } from './client.js';

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
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search query (keywords, hashtags, user names).' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 20).' },
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
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max posts (default 20).' },
  },
};

export function makeFacebookTools(): Tool[] {
  const facebookPostFeedTool: Tool = {
    name: 'facebook_post_feed',
    description:
      'Post a message to the operator\'s Facebook feed or page. Optionally attach an image URL. Requires FACEBOOK_ACCESS_TOKEN vault secret; optionally use FACEBOOK_PAGE_ID to post as a page instead of personal feed.',
    inputSchema: POST_FEED_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { text?: string; image_url?: string };
        const text = String(args.text ?? '').trim();

        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }

        const client = await FacebookClient.create(ctx);
        if (!client) {
          yield {
            type: 'error',
            message:
              'Facebook isn\'t connected — set FACEBOOK_ACCESS_TOKEN in vault/env (Settings → Connections)',
          };
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
      'Search Facebook for posts by keyword, hashtag, or user name. Returns matching posts with author info and engagement metrics.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const client = await FacebookClient.create(ctx);
        if (!client) {
          yield {
            type: 'error',
            message:
              'Facebook isn\'t connected — set FACEBOOK_ACCESS_TOKEN in vault/env (Settings → Connections)',
          };
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
      'Get the authenticated user\'s Facebook profile info (name, friend count, bio). Requires FACEBOOK_ACCESS_TOKEN vault secret.',
    inputSchema: PROFILE_SCHEMA,
    executor: {
      async *execute(_input: unknown, ctx: ToolContext) {
        const client = await FacebookClient.create(ctx);
        if (!client) {
          yield {
            type: 'error',
            message:
              'Facebook isn\'t connected — set FACEBOOK_ACCESS_TOKEN in vault/env (Settings → Connections)',
          };
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
      'Read the operator\'s Facebook feed or page timeline. Returns recent posts with engagement metrics (likes, comments, shares). Requires FACEBOOK_ACCESS_TOKEN vault secret; optionally uses FACEBOOK_PAGE_ID to read a page feed instead of personal feed.',
    inputSchema: FEED_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { limit?: number };

        const client = await FacebookClient.create(ctx);
        if (!client) {
          yield {
            type: 'error',
            message:
              'Facebook isn\'t connected — set FACEBOOK_ACCESS_TOKEN in vault/env (Settings → Connections)',
          };
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
