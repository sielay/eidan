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
    // Validate text length
    if (text.length > 280) {
      return { error: `Text exceeds maximum length of 280 characters (got ${text.length}).` };
    }

    // ponytail: X API v2 POST /tweets requires OAuth 1.0a User Context, not Bearer (OAuth 2.0)
    // Bearer tokens work only for read-only operations or app-only contexts
    // upgrade path: implement OAuth 1.0a signing for write operations, or use the legacy v1.1 API
    return { error: 'Posting tweets requires OAuth 1.0a User Context authentication. Configure X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET.' };
  }

  async search(query: string, limit: number = 20): Promise<XSearchResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'X_ACCESS_TOKEN');

      // Clamp limit to valid range
      const clampedLimit = Math.max(1, Math.min(limit, 100));

      const response = await fetch(
        `${API_BASE}/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${clampedLimit}&tweet.fields=public_metrics,created_at&expansions=author_id&user.fields=username`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!response.ok) {
        return { tweets: [], error: 'Failed to search X.' };
      }

      const data = (await response.json()) as {
        data?: Array<{ id?: string; text?: string; author_id?: string }>;
        includes?: { users?: Array<{ id?: string; username?: string }> };
      };

      return {
        tweets: (data.data || [])
          .filter((tweet) => tweet.id && tweet.text)
          .map((tweet) => ({
            id: tweet.id!,
            text: tweet.text!,
          })),
      };
    } catch (error) {
      return { tweets: [], error: 'Failed to search X.' };
    }
  }

  async getProfile(): Promise<XProfileResult> {
    // ponytail: X API v2 GET /users/me requires OAuth 1.0a User Context, not Bearer (OAuth 2.0)
    // Bearer tokens work only for specific app-only contexts with limited data access
    // upgrade path: implement OAuth 1.0a signing, or query public user endpoint with username
    return { error: 'Retrieving authenticated user profile requires OAuth 1.0a User Context authentication.' };
  }
}
