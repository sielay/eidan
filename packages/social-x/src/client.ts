// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type { XSearchResult, XPostResult, XProfileResult } from './types.js';

const API_BASE = 'https://api.twitter.com/2';

export class XClient {
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  async post(text: string): Promise<XPostResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'X_ACCESS_TOKEN');

      const response = await fetch(`${API_BASE}/tweets`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        return { error: `X API error: ${response.status}` };
      }

      const result = (await response.json()) as { data?: { id?: string } };
      return { id: result.data?.id };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async search(query: string, limit: number = 20): Promise<XSearchResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'X_ACCESS_TOKEN');

      const response = await fetch(
        `${API_BASE}/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${Math.min(limit, 100)}&tweet.fields=public_metrics,created_at&expansions=author_id`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!response.ok) {
        return { tweets: [], error: `X API error: ${response.status}` };
      }

      const data = (await response.json()) as { data?: Array<{ id?: string; text?: string }> };
      return {
        tweets: (data.data || []).map((tweet) => ({
          id: tweet.id,
          text: tweet.text,
        })),
      };
    } catch (error) {
      return { tweets: [], error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async getProfile(): Promise<XProfileResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'X_ACCESS_TOKEN');

      const response = await fetch(`${API_BASE}/users/me?user.fields=public_metrics,description`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        return { error: `X API error: ${response.status}` };
      }

      const result = (await response.json()) as { data?: any };
      const user = result.data;

      return {
        user: {
          id: user?.id,
          name: user?.name,
          username: user?.username,
          description: user?.description,
          followers_count: user?.public_metrics?.followers_count,
        },
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
