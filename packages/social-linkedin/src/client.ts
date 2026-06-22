// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretOpt } from './vault.js';
import type { LinkedInPost, LinkedInProfileResponse, LinkedInFeedResponse } from './types.js';

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
    return result;
  }

  async post(text: string, imageUrl?: string): Promise<{ id?: string; error?: string }> {
    const userResult = await this.request<{ id: string }>('/me');
    if (userResult.error || !userResult.data?.id) {
      return { error: 'Failed to get user ID' };
    }

    const userId = userResult.data.id;

    const postData: Record<string, unknown> = {
      author: `urn:li:person:${userId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text,
          },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    };

    if (imageUrl) {
      postData.specificContent = {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text,
          },
          shareMediaCategory: 'IMAGE',
          media: [
            {
              status: 'READY',
              media: imageUrl,
            },
          ],
        },
      };
    }

    const result = await this.request<{ id: string }>('/ugcPosts', 'POST', postData as Record<string, unknown>);
    return result;
  }

  async listFeed(limit: number = 20): Promise<{ posts?: Array<{ id: string; text?: string; author?: string }>; error?: string }> {
    const url = `/feed?count=${Math.min(limit, 100)}&sortBy=RECENT`;
    const result = await this.request<LinkedInFeedResponse>(url);

    if (result.error) {
      return { error: result.error };
    }

    const posts =
      result.data?.elements?.map((post) => ({
        id: post.id,
        text: post.content?.description || post.content?.title || '',
        author: post.actor || '',
        likes: post.likesSummary?.totalLikes ?? 0,
        comments: post.commentsSummary?.totalFirstLevelComments ?? 0,
      })) ?? [];

    return { posts };
  }

  async search(query: string, limit: number = 20): Promise<{ posts?: Array<{ id: string; text?: string; author?: string }>; error?: string }> {
    const url = `/search/posts?keywords=${encodeURIComponent(query)}&count=${Math.min(limit, 100)}`;
    const result = await this.request<LinkedInFeedResponse>(url);

    if (result.error) {
      return { error: result.error };
    }

    const posts =
      result.data?.elements?.map((post) => ({
        id: post.id,
        text: post.content?.description || post.content?.title || '',
        author: post.actor || '',
        likes: post.likesSummary?.totalLikes ?? 0,
        comments: post.commentsSummary?.totalFirstLevelComments ?? 0,
      })) ?? [];

    return { posts };
  }
}
