// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type { InstagramSearchResult, InstagramPostResult, InstagramProfileResult } from './types.js';

const API_BASE = 'https://graph.instagram.com/v20.0';

export class InstagramClient {
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  async post(caption: string, imageUrl?: string): Promise<InstagramPostResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'INSTAGRAM_ACCESS_TOKEN');
      const businessAccountId = await secretRequired(this.ctx, 'INSTAGRAM_BUSINESS_ACCOUNT_ID');

      if (!imageUrl) {
        return { error: 'Instagram posts require an image URL. Text-only posts are not supported via the API.' };
      }

      const containerResponse = await fetch(`${API_BASE}/${businessAccountId}/media`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          media_type: 'IMAGE',
          image_url: imageUrl,
          caption,
        }),
      });

      if (!containerResponse.ok) {
        return { error: 'Failed to post to Instagram.' };
      }

      const containerResult = (await containerResponse.json()) as { id?: string };
      const mediaId = containerResult.id;

      if (!mediaId) {
        return { error: 'Failed to post to Instagram.' };
      }

      const publishResponse = await fetch(`${API_BASE}/${businessAccountId}/media_publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          creation_id: mediaId,
        }),
      });

      if (!publishResponse.ok) {
        return { error: 'Failed to post to Instagram.' };
      }

      const publishResult = (await publishResponse.json()) as { id?: string };
      if (!publishResult.id) {
        return { error: 'Failed to post to Instagram.' };
      }
      return { id: publishResult.id };
    } catch (error) {
      return { error: 'Failed to post to Instagram.' };
    }
  }

  async searchMedia(hashtag: string, limit: number = 10): Promise<InstagramSearchResult> {
    // ponytail: hashtag search requires 2-step process: search for hashtag ID, then get media for that hashtag
    // current endpoint limitation: recently_searched_hashtags is for user's search history, not general search
    // upgrade path: implement full 2-step hashtag search or use ig_hashtag_search -> media endpoint
    return { media: [], error: 'Hashtag search requires 2-step API flow not currently implemented. Use account insights instead.' };
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
        return { error: 'Failed to retrieve Instagram profile.' };
      }

      const user = (await response.json()) as {
        id?: string;
        username?: string;
        name?: string;
        biography?: string;
        profile_picture_url?: string;
        followers_count?: number;
      };

      const profileData: any = {};
      if (user?.id) profileData.id = user.id;
      if (user?.username) profileData.username = user.username;
      if (user?.name) profileData.name = user.name;
      if (user?.biography) profileData.biography = user.biography;
      if (user?.profile_picture_url) profileData.profile_picture_url = user.profile_picture_url;
      if (user?.followers_count !== undefined) profileData.followers_count = user.followers_count;

      return { user: profileData };
    } catch (error) {
      return { error: 'Failed to retrieve Instagram profile.' };
    }
  }
}
