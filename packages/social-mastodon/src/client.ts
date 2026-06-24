// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type { MastodonProfileResult, MastodonPostResult, MastodonSearchResult } from './types.js';

export class MastodonClient {
  private ctx: ToolContext;
  private instanceUrl: string;

  constructor(ctx: ToolContext, instanceUrl: string) {
    this.ctx = ctx;
    this.instanceUrl = instanceUrl;
  }

  async post(text: string, spoilerText?: string, visibility?: string): Promise<MastodonPostResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'MASTODON_ACCESS_TOKEN');

      const response = await fetch(`${this.instanceUrl}/api/v1/statuses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: text,
          spoiler_text: spoilerText || undefined,
          visibility: visibility || 'public',
        }),
      });

      if (!response.ok) {
        return { error: 'Failed to post to Mastodon.' };
      }

      const result = (await response.json()) as { id?: string; uri?: string };
      return { id: result.id, uri: result.uri };
    } catch (error) {
      return { error: 'Failed to post to Mastodon.' };
    }
  }

  async search(query: string, limit: number = 20): Promise<MastodonSearchResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'MASTODON_ACCESS_TOKEN');

      const response = await fetch(
        `${this.instanceUrl}/api/v2/search?q=${encodeURIComponent(query)}&type=statuses&limit=${Math.min(limit, 40)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!response.ok) {
        return { statuses: [], error: 'Failed to search Mastodon.' };
      }

      const data = (await response.json()) as { statuses?: Array<{ id?: string; content?: string }> };
      return {
        statuses: (data.statuses || []).map((s) => ({
          id: s.id,
          content: s.content,
        })),
      };
    } catch (error) {
      return { statuses: [], error: 'Failed to search Mastodon.' };
    }
  }

  async getProfile(): Promise<MastodonProfileResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'MASTODON_ACCESS_TOKEN');

      const response = await fetch(`${this.instanceUrl}/api/v1/accounts/verify_credentials`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        return { error: 'Failed to retrieve Mastodon profile.' };
      }

      const account = (await response.json()) as any;
      return {
        account: {
          id: account.id,
          username: account.username,
          displayName: account.display_name,
          avatar: account.avatar,
          note: account.note,
        },
      };
    } catch (error) {
      return { error: 'Failed to retrieve Mastodon profile.' };
    }
  }
}
