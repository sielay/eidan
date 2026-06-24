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
      return { id: result.id };
    } catch (error) {
      return { error: 'Failed to post to Threads.' };
    }
  }

  async search(query: string, limit: number = 10): Promise<ThreadsSearchResult> {
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

      const user = (await response.json()) as any;

      return {
        user: {
          id: user?.id,
          username: user?.username,
          name: user?.name,
          biography: user?.biography,
          profile_picture_url: user?.profile_picture_url,
          followers_count: user?.followers_count,
        },
      };
    } catch (error) {
      return { error: 'Failed to retrieve Threads profile.' };
    }
  }
}
