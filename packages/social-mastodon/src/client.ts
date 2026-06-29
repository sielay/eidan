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
      // Validate text length
      if (text.length > 500) {
        return { error: `Text exceeds maximum length of 500 characters (got ${text.length}).` };
      }

      // Validate visibility enum
      const validVisibilities = ['public', 'unlisted', 'private', 'direct'];
      const visibilityValue = visibility || 'public';
      if (!validVisibilities.includes(visibilityValue)) {
        return { error: `Invalid visibility value. Must be one of: ${validVisibilities.join(', ')}` };
      }

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
          visibility: visibilityValue,
        }),
      });

      if (!response.ok) {
        return { error: 'Failed to post to Mastodon.' };
      }

      const result = (await response.json()) as { id?: string; uri?: string };
      if (!result.id) {
        return { error: 'Failed to post to Mastodon.' };
      }
      const postData: any = { id: result.id };
      if (result.uri) postData.uri = result.uri;
      return postData;
    } catch (error) {
      return { error: 'Failed to post to Mastodon.' };
    }
  }

  async search(query: string, limit: number = 20): Promise<MastodonSearchResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'MASTODON_ACCESS_TOKEN');

      // Clamp limit to valid range
      const clampedLimit = Math.max(1, Math.min(limit, 40));

      const response = await fetch(
        `${this.instanceUrl}/api/v2/search?q=${encodeURIComponent(query)}&type=statuses&limit=${clampedLimit}&resolve=true`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!response.ok) {
        return { statuses: [], error: 'Failed to search Mastodon.' };
      }

      const data = (await response.json()) as {
        statuses?: Array<{
          id?: string;
          content?: string;
          created_at?: string;
          favourites_count?: number;
          replies_count?: number;
          reblogs_count?: number;
          account?: {
            id?: string;
            username?: string;
            display_name?: string;
            avatar?: string;
            note?: string;
          };
        }>;
      };
      return {
        statuses: (data.statuses || [])
          .filter((s) => s.id && s.content)
          .map((s) => ({
            id: s.id!,
            content: s.content!,
            ...(s.created_at && { createdAt: s.created_at }),
            favouritesCount: s.favourites_count ?? 0,
            repliesCount: s.replies_count ?? 0,
            reblogsCount: s.reblogs_count ?? 0,
            ...(s.account && {
              account: {
                ...(s.account.id && { id: s.account.id }),
                ...(s.account.username && { username: s.account.username }),
                ...(s.account.display_name && { displayName: s.account.display_name }),
                ...(s.account.avatar && { avatar: s.account.avatar }),
                ...(s.account.note && { note: s.account.note }),
              },
            }),
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

      const account = (await response.json()) as {
        id?: string;
        username?: string;
        display_name?: string;
        avatar?: string;
        note?: string;
      };
      const accountData: any = {};
      if (account.id) accountData.id = account.id;
      if (account.username) accountData.username = account.username;
      if (account.display_name) accountData.displayName = account.display_name;
      if (account.avatar) accountData.avatar = account.avatar;
      if (account.note) accountData.note = account.note;

      return { account: accountData };
    } catch (error) {
      return { error: 'Failed to retrieve Mastodon profile.' };
    }
  }
}
