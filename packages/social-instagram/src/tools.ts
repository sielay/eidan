// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import { InstagramClient } from './client.js';

const POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['caption'],
  properties: {
    caption: {
      type: 'string',
      minLength: 1,
      maxLength: 2200,
      description: 'Post caption (max 2200 characters).',
    },
    image_url: {
      type: 'string',
      description: 'Optional image URL to post.',
    },
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hashtag'],
  properties: {
    hashtag: { type: 'string', minLength: 1, description: 'Hashtag to search.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 10).' },
  },
};

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export function makeInstagramTools(): Tool[] {
  const instagramPostTool: Tool = {
    name: 'instagram_post',
    description:
      'Post to the operator\'s Instagram account. Requires INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_BUSINESS_ACCOUNT_ID vault secrets.',
    inputSchema: POST_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { caption?: string; image_url?: string };
        const caption = String(args.caption ?? '').trim();

        if (!caption) {
          yield { type: 'error', message: 'caption is required' };
          return;
        }

        const client = new InstagramClient(ctx);
        const result = await client.post(caption, args.image_url);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              id: result.id,
              message: 'Posted to Instagram',
            },
          };
        }
      },
    },
  };

  const instagramSearchTool: Tool = {
    name: 'instagram_search',
    description: 'Search Instagram for posts by hashtag.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { hashtag?: string; limit?: number };
        const hashtag = String(args.hashtag ?? '').trim();

        if (!hashtag) {
          yield { type: 'error', message: 'hashtag is required' };
          return;
        }

        const client = new InstagramClient(ctx);
        const result = await client.searchMedia(hashtag, Number(args.limit) || 10);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              hashtag,
              media: result.media,
              count: result.media.length,
            },
          };
        }
      },
    },
  };

  const instagramProfileTool: Tool = {
    name: 'instagram_profile',
    description: 'Get the operator\'s Instagram profile information.',
    inputSchema: PROFILE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const client = new InstagramClient(ctx);
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

  return [instagramPostTool, instagramSearchTool, instagramProfileTool];
}
