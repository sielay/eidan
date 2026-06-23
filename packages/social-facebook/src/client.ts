// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type { FacebookSearchResult, FacebookPostResult, FacebookProfileResult } from './types.js';

const API_BASE = 'https://graph.facebook.com/v20.0';

export class FacebookClient {
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  async post(message: string): Promise<FacebookPostResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'FACEBOOK_ACCESS_TOKEN');

      const response = await fetch(`${API_BASE}/me/feed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          message,
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
    // ponytail: public post search via /search is restricted by Facebook and not available for most apps
    // upgrade path: use page/group-specific search or implement feed search within a user's own posts
    return { posts: [], error: 'Public post search is not available via Facebook API for this app. Use page-specific searches instead.' };
  }

  async getProfile(): Promise<FacebookProfileResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'FACEBOOK_ACCESS_TOKEN');

      const response = await fetch(`${API_BASE}/me?fields=id,name,email,picture`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
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
