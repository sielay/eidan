// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired, secretOpt } from './vault.js';
import type { LinkedInProfileResult, LinkedInPostResult, LinkedInSearchResult } from './types.js';

const API_BASE = 'https://api.linkedin.com/v2';

export class LinkedInClient {
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  async post(text: string): Promise<LinkedInPostResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'LINKEDIN_ACCESS_TOKEN');
      const userId = await secretRequired(this.ctx, 'LINKEDIN_USER_ID');

      const response = await fetch(`${API_BASE}/me/posts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'LinkedIn-Version': '202412',
        },
        body: JSON.stringify({
          author: `urn:li:person:${userId}`,
          lifecycleState: 'PUBLISHED',
          specificContent: {
            'com.linkedin.ugc.ShareContent': {
              shareCommentary: { text },
              shareMediaCategory: 'NONE',
            },
          },
          visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
        }),
      });

      if (!response.ok) {
        return { error: `LinkedIn API error: ${response.status}` };
      }

      const result = (await response.json()) as { id?: string };
      return { id: result.id };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async search(query: string, limit: number = 10): Promise<LinkedInSearchResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'LINKEDIN_ACCESS_TOKEN');

      const response = await fetch(
        `${API_BASE}/search/queries?q=${encodeURIComponent(query)}&type=post&count=${Math.min(limit, 100)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'LinkedIn-Version': '202412',
          },
        }
      );

      if (!response.ok) {
        return { posts: [], error: `LinkedIn API error: ${response.status}` };
      }

      const data = (await response.json()) as { elements?: Array<{ id?: string }> };
      return { posts: (data.elements || []).map((e) => ({ id: e.id })) };
    } catch (error) {
      return { posts: [], error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async getProfile(): Promise<LinkedInProfileResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'LINKEDIN_ACCESS_TOKEN');

      const response = await fetch(`${API_BASE}/me`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'LinkedIn-Version': '202412',
        },
      });

      if (!response.ok) {
        return { error: `LinkedIn API error: ${response.status}` };
      }

      const profile = (await response.json()) as any;
      return {
        profile: {
          localizedFirstName: profile.localizedFirstName,
          localizedLastName: profile.localizedLastName,
          headline: profile.headline,
        },
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
