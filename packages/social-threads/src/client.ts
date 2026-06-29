// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type { ThreadsSearchResult, ThreadsPostResult, ThreadsProfileResult } from './types.js';

// Threads API is in limited rollout and endpoints subject to change. See: https://developers.facebook.com/docs/threads/overview
const API_BASE = 'https://graph.threads.net/v1.0';

export class ThreadsClient {
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  async post(text: string, mediaUrl?: string): Promise<ThreadsPostResult> {
    try {
      // Validate text length
      if (text.length > 500) {
        return { error: `Text exceeds maximum length of 500 characters (got ${text.length}).` };
      }

      // Validate mediaUrl format if provided
      if (mediaUrl) {
        try {
          new URL(mediaUrl);
        } catch {
          return { error: 'Invalid mediaUrl format. Must be a valid URL.' };
        }
      }

      const accessToken = await secretRequired(this.ctx, 'THREADS_ACCESS_TOKEN');
      const userId = await secretRequired(this.ctx, 'THREADS_USER_ID');

      const response = await fetch(`${API_BASE}/${userId}/threads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          text,
          media_url: mediaUrl || undefined,
        }),
      });

      if (!response.ok) {
        return { error: 'Failed to post to Threads.' };
      }

      const result = (await response.json()) as { id?: string };
      if (!result.id) {
        return { error: 'Failed to post to Threads.' };
      }
      return { id: result.id };
    } catch (error) {
      return { error: 'Failed to post to Threads.' };
    }
  }

  async search(query: string, limit: number = 10): Promise<ThreadsSearchResult> {
    // Clamp limit to valid range
    const clampedLimit = Math.max(1, Math.min(limit, 50));

    // ponytail: Threads API search is not yet fully available in the public API; ig_hashtag_search is Instagram-specific
    // upgrade path: monitor Threads API docs for search endpoint releases
    return { posts: [], error: 'Threads search API is not yet available. Check developer docs for updates.' };
  }

  async getProfile(): Promise<ThreadsProfileResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'THREADS_ACCESS_TOKEN');
      const userId = await secretRequired(this.ctx, 'THREADS_USER_ID');

      const response = await fetch(
        `${API_BASE}/${userId}?fields=id,username,name,biography,profile_picture_url,followers_count`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!response.ok) {
        return { error: 'Failed to retrieve Threads profile.' };
      }

      const user = (await response.json()) as {
        id?: string;
        username?: string;
        name?: string;
        biography?: string;
        profile_picture_url?: string;
        followers_count?: number;
      };

      const userData: any = {};
      if (user?.id) userData.id = user.id;
      if (user?.username) userData.username = user.username;
      if (user?.name) userData.name = user.name;
      if (user?.biography) userData.biography = user.biography;
      if (user?.profile_picture_url) userData.profile_picture_url = user.profile_picture_url;
      if (user?.followers_count !== undefined) userData.followers_count = user.followers_count;

      return { user: userData };
    } catch (error) {
      return { error: 'Failed to retrieve Threads profile.' };
    }
  }
}
