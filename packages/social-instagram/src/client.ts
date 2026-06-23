// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type { InstagramSearchResult, InstagramPostResult, InstagramProfileResult } from './types.js';

const API_BASE = 'https://graph.instagram.com/v18.0';

export class InstagramClient {
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  async post(caption: string, imageUrl?: string): Promise<InstagramPostResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'INSTAGRAM_ACCESS_TOKEN');
      const businessAccountId = await secretRequired(this.ctx, 'INSTAGRAM_BUSINESS_ACCOUNT_ID');

      const response = await fetch(`${API_BASE}/${businessAccountId}/media`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          media_type: imageUrl ? 'IMAGE' : 'CAROUSEL',
          image_url: imageUrl,
          caption,
        }),
      });

      if (!response.ok) {
        return { error: `Instagram API error: ${response.status}` };
      }

      const result = (await response.json()) as { id?: string };
      return { id: result.id };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async searchMedia(hashtag: string, limit: number = 10): Promise<InstagramSearchResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'INSTAGRAM_ACCESS_TOKEN');
      const businessAccountId = await secretRequired(this.ctx, 'INSTAGRAM_BUSINESS_ACCOUNT_ID');

      const response = await fetch(
        `${API_BASE}/${businessAccountId}/recently_searched_hashtags?user_id=${businessAccountId}&fields=id,name&limit=${Math.min(limit, 50)}`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!response.ok) {
        return { media: [], error: `Instagram API error: ${response.status}` };
      }

      const data = (await response.json()) as { data?: Array<{ id?: string; name?: string }> };
      return {
        media: (data.data || []).map((item) => ({
          id: item.id,
          caption: item.name,
        })),
      };
    } catch (error) {
      return { media: [], error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async getProfile(): Promise<InstagramProfileResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'INSTAGRAM_ACCESS_TOKEN');
      const businessAccountId = await secretRequired(this.ctx, 'INSTAGRAM_BUSINESS_ACCOUNT_ID');

      const response = await fetch(
        `${API_BASE}/${businessAccountId}?fields=id,username,name,biography,profile_picture_url,followers_count`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!response.ok) {
        return { error: `Instagram API error: ${response.status}` };
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
