// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
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
    media_url: {
      type: 'string',
      description: 'Optional media URL to attach.',
    },
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search query or hashtag.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 10).' },
  },
};

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export function makeThreadsTools(): Tool[] {
  const threadsPostTool: Tool = {
    name: 'threads_post',
    description:
      'Post a message to Threads. Requires THREADS_ACCESS_TOKEN and THREADS_USER_ID vault secrets.',
    inputSchema: POST_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { text?: string; media_url?: string };
        const text = String(args.text ?? '').trim();

        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }

        const client = new ThreadsClient(ctx);
        const result = await client.post(text, args.media_url);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              id: result.id,
              message: 'Posted to Threads',
            },
          };
        }
      },
    },
  };

  const threadsSearchTool: Tool = {
    name: 'threads_search',
    description: 'Search Threads for posts by keyword or hashtag.',
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
        const result = await client.search(query, Number(args.limit) || 10);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              query,
              posts: result.posts,
              count: result.posts.length,
            },
          };
        }
      },
    },
  };

  const threadsProfileTool: Tool = {
    name: 'threads_profile',
    description: 'Get your Threads profile information.',
    inputSchema: PROFILE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const client = new ThreadsClient(ctx);
        const result = await client.getProfile();

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: result.user,
          };
        }
      },
    },
  };

  return [threadsPostTool, threadsSearchTool, threadsProfileTool];
}
