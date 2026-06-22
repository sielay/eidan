// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import { LinkedInClient } from './client.js';

const POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      maxLength: 3000,
      description: 'Post text (max 3000 characters).',
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

export function makeLinkedInTools(): Tool[] {
  const linkedinPostTool: Tool = {
    name: 'linkedin_post',
    description:
      'Post to the operator\'s LinkedIn profile. Requires LINKEDIN_ACCESS_TOKEN and LINKEDIN_USER_ID vault secrets.',
    inputSchema: POST_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { text?: string };
        const text = String(args.text ?? '').trim();

        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }

        const client = new LinkedInClient(ctx);
        const result = await client.post(text);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              id: result.id,
              message: 'Posted to LinkedIn',
            },
          };
        }
      },
    },
  };

  const linkedinSearchTool: Tool = {
    name: 'linkedin_search',
    description: 'Search LinkedIn for posts by keyword or topic.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const client = new LinkedInClient(ctx);
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

  const linkedinProfileTool: Tool = {
    name: 'linkedin_profile',
    description: 'Get the operator\'s LinkedIn profile information.',
    inputSchema: PROFILE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const client = new LinkedInClient(ctx);
        const result = await client.getProfile();

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: result.profile,
          };
        }
      },
    },
  };

  return [linkedinPostTool, linkedinSearchTool, linkedinProfileTool];
}
