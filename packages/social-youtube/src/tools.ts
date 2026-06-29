// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import { YouTubeClient } from './client.js';

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search query.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 10).' },
  },
};

const UPLOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'Video title.',
    },
    description: {
      type: 'string',
      maxLength: 5000,
      description: 'Video description.',
    },
    privacyStatus: {
      type: 'string',
      enum: ['public', 'unlisted', 'private'],
      description: 'Video privacy status (default: private).',
    },
  },
};

const CHANNEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export function makeYouTubeTools(): Tool[] {
  const youtubeSearchTool: Tool = {
    name: 'youtube_search',
    description: 'Search YouTube for videos by keyword.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const client = new YouTubeClient(ctx);
        const result = await client.search(query, Number(args.limit) || 10);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              query,
              videos: result.videos,
              count: result.videos.length,
            },
          };
        }
      },
    },
  };

  const youtubeUploadTool: Tool = {
    name: 'youtube_upload',
    description:
      'Create a YouTube video metadata entry (for upload). Requires YOUTUBE_ACCESS_TOKEN vault secret.',
    inputSchema: UPLOAD_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { title?: string; description?: string; privacyStatus?: string };
        const title = String(args.title ?? '').trim();

        if (!title) {
          yield { type: 'error', message: 'title is required' };
          return;
        }

        const client = new YouTubeClient(ctx);
        const result = await client.uploadMetadata(title, args.description || '', args.privacyStatus);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              id: result.id,
              message: 'Video metadata created on YouTube',
            },
          };
        }
      },
    },
  };

  const youtubeChannelTool: Tool = {
    name: 'youtube_channel',
    description: 'Get the operator\'s YouTube channel information.',
    inputSchema: CHANNEL_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const client = new YouTubeClient(ctx);
        const result = await client.getChannel();

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: result.channel,
          };
        }
      },
    },
  };

  return [youtubeSearchTool, youtubeUploadTool, youtubeChannelTool];
}
