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

export class InstagramAPIError extends Error {
  status: number | null;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'InstagramAPIError';
    this.status = status ?? null;
  }
}

export class InstagramPostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstagramPostError';
  }
}

export class InstagramClient {
  private ctx: ToolContext;
  private accessToken: string | null | undefined;
  private userId: string | null | undefined;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken) return this.accessToken;
    const token = await secretOpt(this.ctx, 'INSTAGRAM_ACCESS_TOKEN');
    this.accessToken = token ?? null;
    return this.accessToken;
  }

  private async getUserId(): Promise<string | null> {
    if (this.userId !== undefined) return this.userId;
    try {
      const user = await this.getAuthenticatedUser();
      this.userId = user?.id ?? null;
    } catch (err) {
      this.userId = null;
      throw err;
    }
    return this.userId;
  }

  private async makeRequest(path: string, options?: RequestInit & { body?: string | undefined }): Promise<Response> {
    const token = await this.getAccessToken();
    if (!token) {
      throw new InstagramAuthError('Instagram access token not configured. Set INSTAGRAM_ACCESS_TOKEN in vault/env.');
    }

    const url = new URL(path, BASE_URL).toString();
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
        throw new InstagramAPIError(`Failed to fetch user: ${res.status}`, res.status);
      }
      const data = (await res.json()) as InstagramUser;
      return data;
    } catch (err) {
      if (err instanceof InstagramAuthError) {
        throw err;
      }
      if (err instanceof InstagramAPIError && err.status === 401) {
        return null;
      }
      throw err;
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
      const userId = await this.getUserId();
      if (!userId) {
        return null;
      }
      const res = await this.makeRequest(`/ig_hashtag_search?user_id=${encodeURIComponent(userId)}&fields=id,name&query=${encodeURIComponent(hashtag_clean)}`);

      if (!res.ok) {
        throw new InstagramAPIError(`Hashtag search failed: ${res.status}`, res.status);
      }

      const data = (await res.json()) as InstagramHashtagSearch;
      return data.data?.[0] ?? null;
    } catch (err) {
      if (err instanceof InstagramAuthError) {
        throw err;
      }
      if (err instanceof InstagramAPIError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async postMedia(imageUrl: string, caption?: string): Promise<{ id: string }> {
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
        throw new InstagramPostError(`Create media failed: ${uploadRes.status} ${error}`);
      }

      const createResult = (await uploadRes.json()) as InstagramMediaUploadResponse;
      if (createResult.error) {
        throw new InstagramPostError(createResult.error.message);
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
        throw new InstagramPostError(`Publish failed: ${publishRes.status} ${error}`);
      }

      const publishResult = (await publishRes.json()) as InstagramMediaUploadResponse;
      if (publishResult.error) {
        throw new InstagramPostError(publishResult.error.message);
      }

      return { id: publishResult.id };
    } catch (err) {
      if (err instanceof InstagramPostError || err instanceof InstagramAuthError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : 'Failed to post media';
      throw new InstagramPostError(message);
    }
  }

  async getHashtagMedia(hashtag_id: string, limit: number = 20): Promise<InstagramMedia[]> {
    try {
      const userId = await this.getUserId();
      if (!userId) {
        return [];
      }
      const res = await this.makeRequest(
        `/${encodeURIComponent(hashtag_id)}/recent_media?user_id=${encodeURIComponent(userId)}&fields=id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count&limit=${Math.min(limit, 100)}`
      );

      if (!res.ok) {
        throw new InstagramAPIError(`Failed to fetch hashtag media: ${res.status}`, res.status);
      }

      const data = (await res.json()) as { data?: InstagramMedia[] };
      return data.data ?? [];
    } catch (err) {
      if (err instanceof InstagramAuthError) {
        throw err;
      }
      if (err instanceof InstagramAPIError && err.status === 404) {
        return [];
      }
      throw err;
    }
  }
}
