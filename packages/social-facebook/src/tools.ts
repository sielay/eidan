// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import { FacebookClient } from './client.js';

const POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: {
    message: {
      type: 'string',
      minLength: 1,
      maxLength: 63206,
      description: 'Post message (max 63206 characters).',
    },
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search query.' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 10).' },
  },
};

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export function makeFacebookTools(): Tool[] {
  const facebookPostTool: Tool = {
    name: 'facebook_post',
    description:
      'Post a message to the operator\'s Facebook feed. Requires FACEBOOK_ACCESS_TOKEN and FACEBOOK_USER_ID vault secrets.',
    inputSchema: POST_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { message?: string };
        const message = String(args.message ?? '').trim();

        if (!message) {
          yield { type: 'error', message: 'message is required' };
          return;
        }

        const client = new FacebookClient(ctx);
        const result = await client.post(message);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              id: result.id,
              message: 'Posted to Facebook',
            },
          };
        }
      },
    },
  };

  const facebookSearchTool: Tool = {
    name: 'facebook_search',
    description: 'Search Facebook for posts by keyword.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const client = new FacebookClient(ctx);
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

  const facebookProfileTool: Tool = {
    name: 'facebook_profile',
    description: 'Get the operator\'s Facebook profile information.',
    inputSchema: PROFILE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const client = new FacebookClient(ctx);
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

  return [facebookPostTool, facebookSearchTool, facebookProfileTool];
}
