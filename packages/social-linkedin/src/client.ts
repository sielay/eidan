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
        return { error: 'Failed to post to LinkedIn.' };
      }

      const result = (await response.json()) as { id?: string };
      return { id: result.id };
    } catch (error) {
      return { error: 'Failed to post to LinkedIn.' };
    }
  }

  async search(query: string, limit: number = 10): Promise<LinkedInSearchResult> {
    // ponytail: public post search on LinkedIn is not available via the standard API
    // upgrade path: use feed endpoint to search within user's own posts, or integrate LinkedIn Search API if available
    return { posts: [], error: 'Public post search is not available via LinkedIn API. Use feed endpoint for personal posts.' };
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
        return { error: 'Failed to retrieve LinkedIn profile.' };
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
      return { error: 'Failed to retrieve LinkedIn profile.' };
    }
  }
}
