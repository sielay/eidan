// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type { FacebookSearchResult, FacebookPostResult, FacebookProfileResult } from './types.js';

const API_BASE = 'https://graph.facebook.com/v18.0';

export class FacebookClient {
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  async post(message: string): Promise<FacebookPostResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'FACEBOOK_ACCESS_TOKEN');
      const userId = await secretRequired(this.ctx, 'FACEBOOK_USER_ID');

      const response = await fetch(`${API_BASE}/${userId}/feed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          access_token: accessToken,
        }),
      });

      if (!response.ok) {
        return { error: `Facebook API error: ${response.status}` };
      }

      const result = (await response.json()) as { id?: string };
      return { id: result.id };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async search(query: string, limit: number = 10): Promise<FacebookSearchResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'FACEBOOK_ACCESS_TOKEN');

      const response = await fetch(
        `${API_BASE}/search?q=${encodeURIComponent(query)}&type=post&limit=${Math.min(limit, 100)}&access_token=${accessToken}`,
        {
          headers: {
            Accept: 'application/json',
          },
        }
      );

      if (!response.ok) {
        return { posts: [], error: `Facebook API error: ${response.status}` };
      }

      const data = (await response.json()) as { data?: Array<{ id?: string; message?: string }> };
      return {
        posts: (data.data || []).map((post) => ({
          id: post.id,
          message: post.message,
        })),
      };
    } catch (error) {
      return { posts: [], error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async getProfile(): Promise<FacebookProfileResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'FACEBOOK_ACCESS_TOKEN');

      const response = await fetch(`${API_BASE}/me?fields=id,name,email,picture&access_token=${accessToken}`, {
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        return { error: `Facebook API error: ${response.status}` };
      }

      const user = (await response.json()) as any;

      return {
        user: {
          id: user?.id,
          name: user?.name,
          email: user?.email,
          picture: user?.picture?.data?.url,
        },
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
