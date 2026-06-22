// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { YouTubeClient } from './client.js';

const POST_COMMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['video_id', 'text'],
  properties: {
    video_id: {
      type: 'string',
      minLength: 1,
      description: 'YouTube video ID (11 characters, found in youtube.com/watch?v=VIDEO_ID).',
    },
    text: {
      type: 'string',
      minLength: 1,
      maxLength: 10000,
      description: 'Comment text (max 10,000 characters).',
    },
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'Search query (keywords, channel names, or video titles).',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Max results (default 20).',
    },
  },
};

const GET_CHANNEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const LIST_VIDEOS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Max videos (default 20).',
    },
  },
};

export function makeYouTubeTools(): Tool[] {
  const postCommentTool: Tool = {
    name: 'youtube_post_comment',
    description:
      'Post a comment on a YouTube video. Requires YOUTUBE_ACCESS_TOKEN vault secret (OAuth2 bearer token).',
    inputSchema: POST_COMMENT_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { video_id?: string; text?: string };
        const videoId = String(args.video_id ?? '').trim();
        const text = String(args.text ?? '').trim();

        if (!videoId || !text) {
          yield { type: 'error', message: 'video_id and text are required' };
          return;
        }

        const clientOrError = await YouTubeClient.create(ctx);
        if ('error' in clientOrError) {
          yield { type: 'error', message: clientOrError.error };
          return;
        }

        const result = await clientOrError.postComment(videoId, text);
        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              commentId: result.commentId,
              videoId,
              text,
              message: 'Posted comment to YouTube',
            },
          };
        }
      },
    },
  };

  const searchTool: Tool = {
    name: 'youtube_search',
    description:
      'Search YouTube for videos by keywords, channel name, or title. Returns matching videos with metadata.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const clientOrError = await YouTubeClient.create(ctx);
        if ('error' in clientOrError) {
          yield { type: 'error', message: clientOrError.error };
          return;
        }

        const result = await clientOrError.search(query, Number(args.limit) || 20);
        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              query,
              videos: result.videos.map((v) => ({
                videoId: v.videoId,
                title: v.title,
                description: v.description,
                channel: v.channelTitle,
                publishedAt: v.publishedAt,
              })),
              count: result.videos.length,
            },
          };
        }
      },
    },
  };

  const getChannelTool: Tool = {
    name: 'youtube_get_channel',
    description:
      'Get the authenticated user\'s YouTube channel information (name, description, subscriber count, view count, video count). Requires YOUTUBE_ACCESS_TOKEN vault secret.',
    inputSchema: GET_CHANNEL_SCHEMA,
    executor: {
      async *execute(_input: unknown, ctx: ToolContext) {
        const clientOrError = await YouTubeClient.create(ctx);
        if ('error' in clientOrError) {
          yield { type: 'error', message: clientOrError.error };
          return;
        }

        const result = await clientOrError.getChannel();
        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              channelId: result.channel?.channelId,
              title: result.channel?.title,
              description: result.channel?.description,
              subscribers: result.channel?.subscribers,
              views: result.channel?.views,
              videos: result.channel?.videos,
            },
          };
        }
      },
    },
  };

  const listVideosTool: Tool = {
    name: 'youtube_list_videos',
    description:
      'List the authenticated user\'s uploaded YouTube videos. Returns video metadata (title, description, publish date, etc). Requires YOUTUBE_ACCESS_TOKEN vault secret.',
    inputSchema: LIST_VIDEOS_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { limit?: number };

        const clientOrError = await YouTubeClient.create(ctx);
        if ('error' in clientOrError) {
          yield { type: 'error', message: clientOrError.error };
          return;
        }

        const result = await clientOrError.listVideos(Number(args.limit) || 20);
        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              videos: result.videos.map((v) => ({
                videoId: v.videoId,
                title: v.title,
                description: v.description,
                publishedAt: v.publishedAt,
              })),
              count: result.videos.length,
            },
          };
        }
      },
    },
  };

  return [postCommentTool, searchTool, getChannelTool, listVideosTool];
}
