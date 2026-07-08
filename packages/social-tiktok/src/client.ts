// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  TikTokUser,
  TikTokUserResponse,
  TikTokVideo,
  TikTokVideoListResponse,
  TikTokPublishInitResponse,
} from './types.js';

const API_BASE = 'https://open.tiktokapis.com/v2';

const USER_FIELDS =
  'open_id,union_id,display_name,bio_description,is_verified,follower_count,following_count,likes_count,video_count,profile_deep_link';
const VIDEO_FIELDS =
  'id,title,video_description,duration,view_count,like_count,comment_count,share_count,create_time,share_url';

// Thin wrapper over the TikTok Display + Content Posting APIs. Read paths (profile, own videos) use
// the Display API; posting uses the Content Posting API's PULL_FROM_URL flow (TikTok fetches the file
// from a public URL — the URL's domain must be verified on the app for non-SELF_ONLY posts).
export class TikTokClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.accessToken}` };
    if (json) h['content-type'] = 'application/json; charset=UTF-8';
    return h;
  }

  async getProfile(): Promise<{ user?: TikTokUser; error?: string }> {
    try {
      const url = `${API_BASE}/user/info/?fields=${encodeURIComponent(USER_FIELDS)}`;
      const res = await fetch(url, { headers: this.headers(false) });
      const j = (await res.json().catch(() => ({}))) as TikTokUserResponse;
      if (!res.ok || j.error?.code !== 'ok') {
        return { error: `TikTok user.info error: ${res.status} ${j.error?.message ?? ''}`.trim() };
      }
      const user = j.data?.user;
      if (!user) return { error: 'TikTok returned no profile' };
      return { user };
    } catch (exc) {
      return { error: `TikTok user.info request failed: ${String(exc)}` };
    }
  }

  async listVideos(limit: number = 20): Promise<{ videos: TikTokVideo[]; error?: string }> {
    try {
      const url = `${API_BASE}/video/list/?fields=${encodeURIComponent(VIDEO_FIELDS)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ max_count: Math.min(Math.max(limit, 1), 20) }),
      });
      const j = (await res.json().catch(() => ({}))) as TikTokVideoListResponse;
      if (!res.ok || (j.error && j.error.code !== 'ok')) {
        return { videos: [], error: `TikTok video.list error: ${res.status} ${j.error?.message ?? ''}`.trim() };
      }
      return { videos: j.data?.videos ?? [] };
    } catch (exc) {
      return { videos: [], error: `TikTok video.list request failed: ${String(exc)}` };
    }
  }

  // Initiate a PULL_FROM_URL publish. Returns a publish_id the caller can surface; the actual upload
  // + moderation happens asynchronously on TikTok's side. `privacyLevel` must be one the account
  // allows (unaudited apps only permit SELF_ONLY).
  async postVideoFromUrl(args: {
    videoUrl: string;
    title?: string;
    privacyLevel?: string;
    disableComment?: boolean;
  }): Promise<{ publishId?: string; error?: string }> {
    try {
      const body = {
        post_info: {
          title: args.title ?? '',
          privacy_level: args.privacyLevel ?? 'SELF_ONLY',
          disable_comment: args.disableComment ?? false,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: args.videoUrl,
        },
      };
      const res = await fetch(`${API_BASE}/post/publish/video/init/`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as TikTokPublishInitResponse;
      if (!res.ok || (j.error && j.error.code !== 'ok')) {
        return { error: `TikTok publish init error: ${res.status} ${j.error?.message ?? ''}`.trim() };
      }
      const publishId = j.data?.publish_id;
      return publishId ? { publishId } : { error: 'TikTok returned no publish_id' };
    } catch (exc) {
      return { error: `TikTok publish request failed: ${String(exc)}` };
    }
  }
}
