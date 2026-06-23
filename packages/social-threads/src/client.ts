// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type { ThreadsSearchResult, ThreadsPostResult, ThreadsProfileResult } from './types.js';

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
        return { error: `Threads API error: ${response.status}` };
      }

      const result = (await response.json()) as { id?: string };
      return { id: result.id };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async search(query: string, limit: number = 10): Promise<ThreadsSearchResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'THREADS_ACCESS_TOKEN');

      const response = await fetch(
        `${API_BASE}/ig_hashtag_search?user_id=me&fields=id,name&q=${encodeURIComponent(query)}&limit=${Math.min(limit, 50)}`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!response.ok) {
        return { posts: [], error: `Threads API error: ${response.status}` };
      }

      const data = (await response.json()) as { data?: Array<{ id?: string; name?: string }> };
      return {
        posts: (data.data || []).map((item) => ({
          id: item.id,
          text: item.name,
        })),
      };
    } catch (error) {
      return { posts: [], error: error instanceof Error ? error.message : 'Unknown error' };
    }
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
        return { error: `Threads API error: ${response.status}` };
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
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
