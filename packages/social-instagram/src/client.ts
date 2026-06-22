// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretOpt } from './vault.js';
import type {
  InstagramUser,
  InstagramMedia,
  InstagramHashtagSearch,
  InstagramMediaSearchResponse,
  InstagramUserResponse,
  InstagramMediaUploadResponse,
} from './types.js';

const API_VERSION = 'v19.0';
const BASE_URL = `https://graph.instagram.com/${API_VERSION}`;

export class InstagramClient {
  private ctx: ToolContext;
  private accessToken: string | null | undefined;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken) return this.accessToken;
    const token = await secretOpt(this.ctx, 'INSTAGRAM_ACCESS_TOKEN');
    this.accessToken = token ?? null;
    return this.accessToken;
  }

  private async makeRequest(path: string, options?: RequestInit): Promise<Response> {
    const token = await this.getAccessToken();
    if (!token) {
      const res = new Response('', { status: 401 });
      return res;
    }

    const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}access_token=${token}`;
    return fetch(url, options);
  }

  async getAuthenticatedUser(): Promise<InstagramUser | null> {
    try {
      const res = await this.makeRequest('/me?fields=id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,ig_id,is_professional_account,website');
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as InstagramUser;
      return data;
    } catch {
      return null;
    }
  }

  async getUserFeed(limit: number = 20): Promise<InstagramMedia[]> {
    try {
      const token = await this.getAccessToken();
      if (!token) return [];

      const user = await this.getAuthenticatedUser();
      if (!user?.id) return [];

      const res = await this.makeRequest(
        `/me/media?fields=id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count&limit=${Math.min(limit, 100)}`
      );

      if (!res.ok) {
        return [];
      }

      const data = (await res.json()) as { data?: InstagramMedia[] };
      return data.data ?? [];
    } catch {
      return [];
    }
  }

  async searchHashtag(hashtag: string): Promise<{ id: string; name: string } | null> {
    try {
      const hashtag_clean = hashtag.replace(/^#/, '');
      const res = await this.makeRequest(`/ig_hashtag_search?user_id=me&fields=id,name&query=${encodeURIComponent(hashtag_clean)}`);

      if (!res.ok) {
        return null;
      }

      const data = (await res.json()) as InstagramHashtagSearch;
      return data.data?.[0] ?? null;
    } catch {
      return null;
    }
  }

  async searchUsers(query: string, limit: number = 20): Promise<{ username: string; name?: string }[]> {
    try {
      const results: { username: string; name?: string }[] = [];
      const res = await this.makeRequest(`/ig_hashtag_search?user_id=me&fields=id,name&query=${encodeURIComponent(query)}`);

      if (!res.ok) {
        return [];
      }

      const data = (await res.json()) as any;
      if (data.data) {
        return data.data.slice(0, limit).map((item: any) => ({
          username: item.name,
          name: item.name,
        }));
      }

      return results;
    } catch {
      return [];
    }
  }

  async postMedia(imageUrl: string, caption?: string): Promise<{ id: string; error?: string } | null> {
    try {
      const token = await this.getAccessToken();
      if (!token) return null;

      const user = await this.getAuthenticatedUser();
      if (!user?.id) {
        return { id: '', error: 'Failed to get authenticated user' };
      }

      const uploadRes = await fetch(
        `${BASE_URL}/me/media?fields=id&access_token=${token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image_url: imageUrl,
            caption: caption || '',
          }),
        }
      );

      if (!uploadRes.ok) {
        const error = await uploadRes.text();
        return { id: '', error: `Upload failed: ${uploadRes.status} ${error}` };
      }

      const result = (await uploadRes.json()) as InstagramMediaUploadResponse;
      if (result.error) {
        return { id: '', error: result.error.message };
      }

      return { id: result.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to post media';
      return { id: '', error: message };
    }
  }

  async getHashtagMedia(hashtag_id: string, limit: number = 20): Promise<InstagramMedia[]> {
    try {
      const res = await this.makeRequest(
        `/${hashtag_id}/recent_media?user_id=me&fields=id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count&limit=${Math.min(limit, 100)}`
      );

      if (!res.ok) {
        return [];
      }

      const data = (await res.json()) as { data?: InstagramMedia[] };
      return data.data ?? [];
    } catch {
      return [];
    }
  }
}
