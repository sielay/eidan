// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import { MastodonClient } from './client.js';
import { secretRequired } from './vault.js';

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
    spoiler_text: {
      type: 'string',
      description: 'Optional content warning text.',
    },
    visibility: {
      type: 'string',
      enum: ['public', 'unlisted', 'private', 'direct'],
      description: 'Visibility level (default: public).',
    },
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search query.' },
    limit: { type: 'integer', minimum: 1, maximum: 40, description: 'Max results (default 20).' },
  },
};

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export function makeMastodonTools(): Tool[] {
  const mastodonPostTool: Tool = {
    name: 'mastodon_post',
    description:
      'Post to the operator\'s Mastodon account. Supports text with optional content warning. Requires MASTODON_ACCESS_TOKEN and MASTODON_INSTANCE_URL vault secrets.',
    inputSchema: POST_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { text?: string; spoiler_text?: string; visibility?: string };
        const text = String(args.text ?? '').trim();

        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }

        const instanceUrl = await secretRequired(ctx, 'MASTODON_INSTANCE_URL');
        const client = new MastodonClient(ctx, instanceUrl);
        const result = await client.post(text, args.spoiler_text, args.visibility);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              id: result.id,
              uri: result.uri,
              message: 'Posted to Mastodon',
            },
          };
        }
      },
    },
  };

  const mastodonSearchTool: Tool = {
    name: 'mastodon_search',
    description: 'Search Mastodon for posts by keyword or hashtag.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const instanceUrl = await secretRequired(ctx, 'MASTODON_INSTANCE_URL');
        const client = new MastodonClient(ctx, instanceUrl);
        const result = await client.search(query, Number(args.limit) || 20);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              query,
              statuses: result.statuses,
              count: result.statuses.length,
            },
          };
        }
      },
    },
  };

  const mastodonProfileTool: Tool = {
    name: 'mastodon_profile',
    description: 'Get the operator\'s Mastodon profile information.',
    inputSchema: PROFILE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const instanceUrl = await secretRequired(ctx, 'MASTODON_INSTANCE_URL');
        const client = new MastodonClient(ctx, instanceUrl);
        const result = await client.getProfile();

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: result.account,
          };
        }
      },
    },
  };

  return [mastodonPostTool, mastodonSearchTool, mastodonProfileTool];
}
