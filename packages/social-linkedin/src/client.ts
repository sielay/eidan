// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretOpt } from './vault.js';
import type { LinkedInPost, LinkedInProfileResponse, LinkedInFeedResponse, LinkedInUGCPostRequest, LinkedInAssetRegisterResponse } from './types.js';

const API_BASE = 'https://api.linkedin.com/v2';

export class LinkedInClient {
  private ctx: ToolContext;
  private accessToken: string;

  constructor(ctx: ToolContext, accessToken: string) {
    this.ctx = ctx;
    this.accessToken = accessToken;
  }

  private async request<T>(
    endpoint: string,
    method: string = 'GET',
    body?: Record<string, unknown>
  ): Promise<{ data?: T; error?: string }> {
    try {
      const url = `${API_BASE}${endpoint}`;
      const options: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'LinkedIn-Version': '202312',
        },
      };

      if (body) {
        options.body = JSON.stringify(body);
      }

      const res = await fetch(url, options);

      if (!res.ok) {
        const errorText = await res.text();
        return {
          error: `LinkedIn API error: ${res.status} ${errorText}`,
        };
      }

      const data = (await res.json()) as T;
      return { data };
    } catch (err) {
      return {
        error: `Request failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  async getProfile(): Promise<{ profile?: LinkedInProfileResponse; error?: string }> {
    const result = await this.request<LinkedInProfileResponse>('/me');
    if (result.error) {
      return { error: result.error };
    }
    if (!result.data) {
      return { error: 'No profile data received' };
    }
    return { profile: result.data };
  }

  private async registerAsset(imageUrl: string): Promise<{ urn?: string; error?: string }> {
    try {
      const assetRegisterPayload = {
        registerRequest: {
          recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
          serviceRelationships: [
            {
              relationshipType: 'OWNER',
              identifier: 'urn:li:userGeneratedContent',
            },
          ],
        },
      };

      const registerResult = await this.request<{ value: string }>('/assets', 'POST', assetRegisterPayload);
      if (registerResult.error) {
        return { error: registerResult.error };
      }

      if (!registerResult.data?.value) {
        return { error: 'Failed to register image asset' };
      }

      const urn = registerResult.data.value;
      const uploadUrl = `${API_BASE}/assets?action=upload`;

      let imageBuffer: Buffer;
      try {
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
          return { error: `Failed to fetch image from URL: ${imageResponse.status}` };
        }
        imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      } catch (fetchErr) {
        return {
          error: `Failed to download image: ${fetchErr instanceof Error ? fetchErr.message : 'Unknown error'}`,
        };
      }

      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/octet-stream',
        },
        body: imageBuffer,
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        return { error: `Image upload failed: ${uploadResponse.status} ${errorText}` };
      }

      return { urn };
    } catch (err) {
      return {
        error: `Asset registration failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  async post(text: string, imageUrl?: string): Promise<{ id?: string; error?: string }> {
    const userResult = await this.request<{ id: string }>('/me');
    if (userResult.error || !userResult.data?.id) {
      return { error: 'Failed to get user ID' };
    }

    const userId = userResult.data.id;

    let mediaUrn: string | undefined;
    if (imageUrl) {
      const assetResult = await this.registerAsset(imageUrl);
      if (assetResult.error) {
        return { error: assetResult.error };
      }
      mediaUrn = assetResult.urn;
    }

    const postPayload: LinkedInUGCPostRequest = {
      author: `urn:li:person:${userId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text,
          },
          shareMediaCategory: mediaUrn ? 'IMAGE' : 'NONE',
          ...(mediaUrn && {
            media: [
              {
                status: 'READY',
                media: mediaUrn,
              },
            ],
          }),
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    };

    const result = await this.request<{ id: string }>('/ugcPosts', 'POST', postPayload as Record<string, unknown>);
    if (result.error) {
      return { error: result.error };
    }
    if (!result.data?.id) {
      return { error: 'No post ID received' };
    }
    return { id: result.data.id };
  }

  async listFeed(limit: number = 20): Promise<{ posts?: Array<{ id: string; text?: string; author?: string; likes: number; comments: number }>; error?: string }> {
    const url = `/feed?count=${Math.min(limit, 100)}&sortBy=RECENT`;
    const result = await this.request<LinkedInFeedResponse>(url);

    if (result.error) {
      return { error: result.error };
    }

    const posts =
      result.data?.elements?.map((post) => ({
        id: post.id,
        text: post.content?.description || post.content?.title || '',
        author: post.actor ?? '',
        likes: post.likesSummary?.totalLikes ?? 0,
        comments: post.commentsSummary?.totalFirstLevelComments ?? 0,
      })) ?? [];

    return { posts };
  }

  async search(query: string, limit: number = 20): Promise<{ posts?: Array<{ id: string; text?: string; author?: string; likes: number; comments: number }>; error?: string }> {
    const url = `/search/posts?keywords=${encodeURIComponent(query)}&count=${Math.min(limit, 100)}`;
    const result = await this.request<LinkedInFeedResponse>(url);

    if (result.error) {
      return { error: result.error };
    }

    const posts =
      result.data?.elements?.map((post) => ({
        id: post.id,
        text: post.content?.description || post.content?.title || '',
        author: post.actor ?? '',
        likes: post.likesSummary?.totalLikes ?? 0,
        comments: post.commentsSummary?.totalFirstLevelComments ?? 0,
      })) ?? [];

    return { posts };
  }
}
