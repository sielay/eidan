// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { ThreadsClient } from './client.js';

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
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search text (keywords, hashtags).' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 20).' },
  },
};

const TIMELINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max posts (default 20).' },
  },
};

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export function makeThreadsTools(): Tool[] {
  const threadsPostTool: Tool = {
    name: 'threads_post_thread',
    description:
      'Post a message to the operator\'s Threads account. Supports text up to 500 characters. Optionally reply to an existing thread. Requires THREADS_ACCESS_TOKEN vault secret.',
    inputSchema: POST_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { text?: string; reply_to?: string };
        const text = String(args.text ?? '').trim();

        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }

        const client = new ThreadsClient(ctx);
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
      'Search for hashtags on Threads by keyword. Returns matching hashtags found on the platform. Note: Returns hashtag metadata, not user posts — the Threads API does not expose a post search endpoint to non-business accounts.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const client = new ThreadsClient(ctx);
        const result = await client.search(query, Number(args.limit) || 20);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              query,
              hashtags: result.hashtags.map((tag) => ({
                id: tag.id,
                name: tag.name,
                search_url: tag.search_url,
              })),
              count: result.hashtags.length,
            },
          };
        }
      },
    },
  };

  const threadsGetProfileTool: Tool = {
    name: 'threads_get_profile',
    description:
      'Get the authenticated user\'s Threads profile, including username, bio, and profile picture.',
    inputSchema: PROFILE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const client = new ThreadsClient(ctx);
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
              biography: result.user.biography || '',
              profile_picture_url: result.user.threads_profile_picture_url || '',
              followers: result.user.follower_count ?? 0,
              following: result.user.following_count ?? 0,
              is_verified: result.user.is_verified ?? false,
              website: result.user.website || '',
            },
          };
        }
      },
    },
  };

  const threadsListTimelineTool: Tool = {
    name: 'threads_list_timeline',
    description:
      'Read the authenticated operator\'s Threads timeline (their recent posts). Returns posts with engagement metrics (likes, replies, reposts). All returned posts are authored by the authenticated user.',
    inputSchema: TIMELINE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { limit?: number };
        const client = new ThreadsClient(ctx);
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
                likes: post.like_count,
                replies: post.reply_count,
                reposts: post.repost_count,
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
