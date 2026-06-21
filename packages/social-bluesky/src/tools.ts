// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { BlueskyClient } from './client.js';
import { secretOpt } from './vault.js';

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
    reply_to: {
      type: 'string',
      description: 'Optional post URI to reply to (at://... format).',
    },
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search text (keywords, hashtags, @handles).' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 20).' },
  },
};

const FEED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max posts (default 20).' },
  },
};

export function makeBlueskyTools(): Tool[] {
  const blueskyPostTool: Tool = {
    name: 'bluesky_post',
    description:
      'Post a message to the operator\'s Bluesky account. Supports text, auto-detects URLs and #hashtags as facets. Optionally reply to an existing post. Requires BLUESKY_HANDLE and BLUESKY_APP_PASSWORD vault secrets.',
    inputSchema: POST_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { text?: string; reply_to?: string };
        const text = String(args.text ?? '').trim();

        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }

        const service = (await secretOpt(ctx, 'BLUESKY_SERVICE')) || undefined;
        const client = new BlueskyClient(ctx, service);
        const result = await client.post(text, args.reply_to);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              uri: result.uri,
              cid: result.cid,
              text,
              message: `Posted to Bluesky`,
            },
          };
        }
      },
    },
  };

  const blueskySearchTool: Tool = {
    name: 'bluesky_search',
    description:
      'Search Bluesky for posts by keyword, hashtag, or @handle. Returns matching posts with author info and engagement metrics.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const service = (await secretOpt(ctx, 'BLUESKY_SERVICE')) || undefined;
        const client = new BlueskyClient(ctx, service);
        const result = await client.search(query, Number(args.limit) || 20);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              query,
              posts: result.posts.map((post) => ({
                uri: post.uri,
                author: `${post.author.handle} (${post.author.displayName || 'No name'})`,
                text: post.record?.text || '',
                likes: post.likeCount ?? 0,
                replies: post.replyCount ?? 0,
                reposts: post.repostCount ?? 0,
              })),
              count: result.posts.length,
            },
          };
        }
      },
    },
  };

  const blueskyReadFeedTool: Tool = {
    name: 'bluesky_read_feed',
    description:
      'Read the operator\'s Bluesky feed (home timeline). Returns recent posts from followed accounts with engagement metrics.',
    inputSchema: FEED_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { limit?: number };
        const service = (await secretOpt(ctx, 'BLUESKY_SERVICE')) || undefined;
        const client = new BlueskyClient(ctx, service);
        const result = await client.readFeed(Number(args.limit) || 20);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              posts: result.posts.map((post) => ({
                uri: post.uri,
                author: `${post.author.handle} (${post.author.displayName || 'No name'})`,
                text: post.record?.text || '',
                likes: post.likeCount ?? 0,
                replies: post.replyCount ?? 0,
                reposts: post.repostCount ?? 0,
                created: post.record?.createdAt || '',
              })),
              count: result.posts.length,
            },
          };
        }
      },
    },
  };

  return [blueskyPostTool, blueskySearchTool, blueskyReadFeedTool];
}
