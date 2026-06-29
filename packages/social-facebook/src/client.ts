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
    // ponytail: /me/feed endpoint is deprecated and text-only posts to user feeds are restricted
    // upgrade path: post to a page instead (/me/accounts -> get page ID -> POST /page-id/feed) or use /me/photos for media
    return { error: 'Direct posting to user feed is not supported. Post to a Page instead (POST /page-id/feed) or share photos (/me/photos).' };
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
        return { error: 'Failed to retrieve Facebook profile.' };
      }

      const user = (await response.json()) as {
        id?: string;
        name?: string;
        email?: string;
        picture?: { data?: { url?: string } };
      };

      const profileData: any = {};
      if (user?.id) profileData.id = user.id;
      if (user?.name) profileData.name = user.name;
      if (user?.email) profileData.email = user.email;
      if (user?.picture?.data?.url) profileData.picture = user.picture.data.url;

      return { user: profileData };
    } catch (error) {
      return { error: 'Failed to retrieve Facebook profile.' };
    }
  }
}
