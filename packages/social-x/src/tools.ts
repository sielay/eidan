// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import { XClient } from './client.js';

const POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      maxLength: 280,
      description: 'Tweet text (max 280 characters).',
    },
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search query.' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 20).' },
  },
};

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export function makeXTools(): Tool[] {
  const xPostTool: Tool = {
    name: 'x_post',
    description:
      'Post a tweet to the operator\'s X (Twitter) account. Requires X_ACCESS_TOKEN vault secret.',
    inputSchema: POST_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { text?: string };
        const text = String(args.text ?? '').trim();

        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }

        const client = new XClient(ctx);
        const result = await client.post(text);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              id: result.id,
              message: 'Posted to X',
            },
          };
        }
      },
    },
  };

  const xSearchTool: Tool = {
    name: 'x_search',
    description: 'Search X for recent tweets by keyword or topic.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const client = new XClient(ctx);
        const result = await client.search(query, Number(args.limit) || 20);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              query,
              tweets: result.tweets,
              count: result.tweets.length,
            },
          };
        }
      },
    },
  };

  const xProfileTool: Tool = {
    name: 'x_profile',
    description: 'Get the operator\'s X profile information.',
    inputSchema: PROFILE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const client = new XClient(ctx);
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

  return [xPostTool, xSearchTool, xProfileTool];
}
