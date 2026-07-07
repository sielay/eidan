// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `social-tiktok` plugin — read profile + own videos, and publish a video from a
// public URL. TikTok's public API has no content/hashtag search and no DM/comment read, so there is
// no `*_search` tool here (unlike the other social plugins).
//
// Per-account OAuth: the operator connects one or more TikTok accounts in the Connections screen.
// Each account's OAuth client (sealed under client_vault_key) + access/refresh tokens live in the
// vault; the registry rows live in plugin_social_tiktok.accounts. At call time the tools resolve the
// requested account (or the first), mint/refresh an access token via the connections kit, then call
// the TikTok Display / Content Posting APIs. Falls back to the legacy single TIKTOK_ACCESS_TOKEN
// secret when no account is connected.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import {
  type AccountStore,
  type SealFn,
  AccountResolveError,
  NotConnectedError,
  resolveAccessToken,
} from '@eidandev/connections-kit';
import { TikTokClient } from './client.js';
import { tiktokAdapter } from './adapter.js';
import { secretOpt } from './vault.js';

const ACCOUNT_PROP = {
  account: {
    type: 'string',
    description: 'Which connected TikTok account (name or slug). Omit to use the first connected account.',
  },
} as const;

const GET_PROFILE_SCHEMA = {
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
      maximum: 20,
      description: 'Max videos (default 20; TikTok caps a page at 20).',
    },
    ...ACCOUNT_PROP,
  },
};

const POST_VIDEO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['video_url'],
  properties: {
    video_url: {
      type: 'string',
      minLength: 1,
      description:
        'Public URL of an MP4 video TikTok will pull. The URL domain must be verified on the TikTok app for non-private posts (unaudited apps can only post SELF_ONLY).',
    },
    title: {
      type: 'string',
      maxLength: 2200,
      description: 'Caption / title (max 2200 characters). Hashtags in the text are honoured.',
    },
    privacy_level: {
      type: 'string',
      enum: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
      description: 'Audience. Default SELF_ONLY (the only option for unaudited apps).',
    },
    disable_comment: {
      type: 'boolean',
      description: 'Disable comments on the post (default false).',
    },
    ...ACCOUNT_PROP,
  },
};

// Resolve a TikTok client for the selected account: registry first (with transparent refresh), then
// the legacy single TIKTOK_ACCESS_TOKEN secret. Returns an error string when nothing usable resolves.
async function resolveClient(
  ctx: ToolContext,
  store: AccountStore | null,
  seal: SealFn | undefined,
  account: string | undefined,
): Promise<{ client?: TikTokClient; error?: string }> {
  if (store) {
    try {
      const { accessToken } = await resolveAccessToken(store, tiktokAdapter, ctx, {
        ...(account ? { accountSelector: account } : {}),
        ...(seal ? { seal } : {}),
      });
      return { client: new TikTokClient(accessToken) };
    } catch (exc) {
      if (exc instanceof AccountResolveError) return { error: exc.message };
      if (!(exc instanceof NotConnectedError)) {
        return { error: exc instanceof Error ? exc.message : 'failed to resolve TikTok account' };
      }
      // NotConnectedError → fall through to the legacy single-secret path.
    }
  }
  const token = await secretOpt(ctx, 'TIKTOK_ACCESS_TOKEN');
  if (token) return { client: new TikTokClient(token) };
  return {
    error:
      "TikTok isn't connected — add an account under Connections, or set the legacy TIKTOK_ACCESS_TOKEN vault secret.",
  };
}

export function makeTiktokTools(store: AccountStore | null, seal?: SealFn): Tool[] {
  const getProfileTool: Tool = {
    name: 'tiktok_get_profile',
    description:
      "Get a connected TikTok account's profile (display name, verification, follower/following/likes/video counts). Use `account` to pick which connected TikTok account.",
    inputSchema: GET_PROFILE_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { account?: string };
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create TikTok client' };
          return;
        }
        const result = await client.getProfile();
        if (result.error || !result.user) {
          yield { type: 'error', message: result.error ?? 'No profile returned' };
          return;
        }
        const u = result.user;
        yield {
          type: 'result',
          value: {
            openId: u.open_id,
            displayName: u.display_name,
            isVerified: u.is_verified,
            followers: u.follower_count,
            following: u.following_count,
            likes: u.likes_count,
            videos: u.video_count,
            bio: u.bio_description,
            profileUrl: u.profile_deep_link,
          },
        };
      },
    },
  };

  const listVideosTool: Tool = {
    name: 'tiktok_list_videos',
    description:
      "List a connected TikTok account's recent videos with engagement metrics (views, likes, comments, shares). Use `account` to pick which connected TikTok account.",
    inputSchema: LIST_VIDEOS_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { limit?: number; account?: string };
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create TikTok client' };
          return;
        }
        const result = await client.listVideos(Number(args.limit) || 20);
        if (result.error) {
          yield { type: 'error', message: result.error };
          return;
        }
        yield {
          type: 'result',
          value: {
            videos: result.videos.map((v) => ({
              id: v.id,
              title: v.title ?? v.video_description,
              views: v.view_count,
              likes: v.like_count,
              comments: v.comment_count,
              shares: v.share_count,
              createdAt: v.create_time ? new Date(v.create_time * 1000).toISOString() : undefined,
              url: v.share_url,
            })),
            count: result.videos.length,
          },
        };
      },
    },
  };

  const postVideoTool: Tool = {
    name: 'tiktok_post_video',
    description:
      'Publish a video to a connected TikTok account by pulling it from a public URL (TikTok Content Posting API). Returns a publish_id; upload + moderation complete asynchronously on TikTok. Unaudited apps can only post SELF_ONLY (private). Use `account` to pick which connected TikTok account.',
    inputSchema: POST_VIDEO_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as {
          video_url?: string;
          title?: string;
          privacy_level?: string;
          disable_comment?: boolean;
          account?: string;
        };
        const videoUrl = String(args.video_url ?? '').trim();
        if (!videoUrl) {
          yield { type: 'error', message: 'video_url is required' };
          return;
        }
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create TikTok client' };
          return;
        }
        const result = await client.postVideoFromUrl({
          videoUrl,
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.privacy_level !== undefined ? { privacyLevel: args.privacy_level } : {}),
          ...(args.disable_comment !== undefined ? { disableComment: args.disable_comment } : {}),
        });
        if (result.error) {
          yield { type: 'error', message: result.error };
          return;
        }
        yield {
          type: 'result',
          value: {
            publishId: result.publishId,
            privacyLevel: args.privacy_level ?? 'SELF_ONLY',
            message: 'TikTok is processing the video (async). Check the app for the published post.',
          },
        };
      },
    },
  };

  return [getProfileTool, listVideosTool, postVideoTool];
}
