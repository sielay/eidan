// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `social-youtube` plugin — post comments, search, read channel/videos on YouTube.
//
// Per-account OAuth: the operator connects one or more YouTube accounts in the Connections screen.
// Each account's OAuth client (sealed under client_vault_key) + access/refresh tokens (token/refresh
// keys) live in the vault; the registry rows live in plugin_social_youtube.accounts. At call time the
// tools pick the requested account (or the first), mint/refresh an access token via the connections
// kit (Google offline access), then call the YouTube Data API v3. Falls back to the legacy single
// YOUTUBE_ACCESS_TOKEN secret when no account is connected, so older setups keep working.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import {
  type AccountStore,
  type SealFn,
  AccountResolveError,
  NotConnectedError,
  resolveAccessToken,
} from '@eidandev/connections-kit';
import { YouTubeClient } from './client.js';
import { youtubeAdapter } from './adapter.js';
import { secretOpt } from './vault.js';

const ACCOUNT_PROP = {
  account: {
    type: 'string',
    description: 'Which connected YouTube account (name or slug). Omit to use the first connected account.',
  },
} as const;

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
    ...ACCOUNT_PROP,
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
    ...ACCOUNT_PROP,
  },
};

const GET_CHANNEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: { ...ACCOUNT_PROP },
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
    ...ACCOUNT_PROP,
  },
};

// Resolve a YouTube client for the selected account: registry first (with transparent refresh), then
// the legacy single YOUTUBE_ACCESS_TOKEN secret. Returns an error string when nothing usable resolves.
async function resolveClient(
  ctx: ToolContext,
  store: AccountStore | null,
  seal: SealFn | undefined,
  account: string | undefined,
): Promise<{ client?: YouTubeClient; error?: string }> {
  if (store) {
    try {
      const { accessToken } = await resolveAccessToken(store, youtubeAdapter, ctx, {
        ...(account ? { accountSelector: account } : {}),
        ...(seal ? { seal } : {}),
      });
      return { client: new YouTubeClient(accessToken) };
    } catch (exc) {
      if (exc instanceof AccountResolveError) return { error: exc.message };
      if (!(exc instanceof NotConnectedError)) {
        return { error: exc instanceof Error ? exc.message : 'failed to resolve YouTube account' };
      }
      // NotConnectedError → fall through to the legacy single-secret path.
    }
  }
  const token = await secretOpt(ctx, 'YOUTUBE_ACCESS_TOKEN');
  if (token) return { client: new YouTubeClient(token) };
  return {
    error:
      "YouTube isn't connected — add an account under Connections, or set the legacy YOUTUBE_ACCESS_TOKEN vault secret.",
  };
}

export function makeYoutubeTools(store: AccountStore | null, seal?: SealFn): Tool[] {
  const postCommentTool: Tool = {
    name: 'youtube_post_comment',
    description:
      'Post a comment on a YouTube video from a connected account. Use `account` to pick which connected YouTube account.',
    inputSchema: POST_COMMENT_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { video_id?: string; text?: string; account?: string };
        const videoId = String(args.video_id ?? '').trim();
        const text = String(args.text ?? '').trim();

        if (!videoId || !text) {
          yield { type: 'error', message: 'video_id and text are required' };
          return;
        }

        if (text.length > 10000) {
          yield { type: 'error', message: 'Comment text exceeds maximum length of 10,000 characters' };
          return;
        }

        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create YouTube client' };
          return;
        }

        const result = await client.postComment(videoId, text);
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
      'Search YouTube for videos by keywords, channel name, or title. Use `account` to pick which connected YouTube account.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { query?: string; limit?: number; account?: string };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create YouTube client' };
          return;
        }

        const result = await client.search(query, Number(args.limit) || 20);
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
      "Get a connected YouTube account's channel info (name, description, subscriber count, view count, video count). Use `account` to pick which connected YouTube account.",
    inputSchema: GET_CHANNEL_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { account?: string };
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create YouTube client' };
          return;
        }

        const result = await client.getChannel();
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
      "List a connected YouTube account's uploaded videos. Use `account` to pick which connected YouTube account.",
    inputSchema: LIST_VIDEOS_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { limit?: number; account?: string };

        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create YouTube client' };
          return;
        }

        const result = await client.listVideos(Number(args.limit) || 20);
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
