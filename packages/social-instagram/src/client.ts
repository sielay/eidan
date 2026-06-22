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

export class InstagramAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstagramAuthError';
  }
}

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

  private async makeRequest(path: string, options?: RequestInit & { body?: string | undefined }): Promise<Response> {
    const token = await this.getAccessToken();
    if (!token) {
      throw new InstagramAuthError('Instagram access token not configured. Set INSTAGRAM_ACCESS_TOKEN in vault/env.');
    }

    const url = `${BASE_URL}${path}`;
    const headers = {
      ...((options?.headers as Record<string, string>) ?? {}),
      'Authorization': `Bearer ${token}`,
    };
    return fetch(url, { ...options, headers });
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
      const res = await this.makeRequest(
        `/me/media?fields=id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count&limit=${Math.min(limit, 100)}`
      );

      if (!res.ok) {
        return [];
      }

      const data = (await res.json()) as { data?: InstagramMedia[] };
      return data.data ?? [];
    } catch (err) {
      if (err instanceof InstagramAuthError) {
        throw err;
      }
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
    } catch (err) {
      if (err instanceof InstagramAuthError) {
        throw err;
      }
      return null;
    }
  }

  async postMedia(imageUrl: string, caption?: string): Promise<{ id: string; error?: string } | null> {
    try {
      // Step 1: Create media container
      const uploadRes = await this.makeRequest('/me/media', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image_url: imageUrl,
          caption: caption || '',
        }),
      });

      if (!uploadRes.ok) {
        const error = await uploadRes.text();
        return { id: '', error: `Create media failed: ${uploadRes.status} ${error}` };
      }

      const createResult = (await uploadRes.json()) as InstagramMediaUploadResponse;
      if (createResult.error) {
        return { id: '', error: createResult.error.message };
      }

      const creationId = createResult.id;

      // Step 2: Publish the media container
      const publishRes = await this.makeRequest('/me/media_publish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          creation_id: creationId,
        }),
      });

      if (!publishRes.ok) {
        const error = await publishRes.text();
        return { id: '', error: `Publish failed: ${publishRes.status} ${error}` };
      }

      const publishResult = (await publishRes.json()) as InstagramMediaUploadResponse;
      if (publishResult.error) {
        return { id: '', error: publishResult.error.message };
      }

      return { id: publishResult.id };
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
    } catch (err) {
      if (err instanceof InstagramAuthError) {
        throw err;
      }
      return [];
    }
  }
}
