// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FacebookPost, FacebookUser, FacebookFeed, FacebookSearchResponse, FacebookPostResponse } from './types.js';

const DEFAULT_API_VERSION = 'v18.0';
const GRAPH_API_BASE = 'https://graph.facebook.com';

export class FacebookClient {
  private accessToken: string;
  private pageId: string;

  constructor(accessToken: string, pageId: string = '') {
    this.accessToken = accessToken;
    this.pageId = pageId;
  }

  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    body?: Record<string, unknown>
  ): Promise<T | { error: string }> {
    try {
      const url = new URL(`${GRAPH_API_BASE}/${DEFAULT_API_VERSION}${endpoint}`);
      url.searchParams.set('access_token', this.accessToken);

      const options: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };

      if (body && method === 'POST') {
        const formData = new URLSearchParams();
        for (const [key, value] of Object.entries(body)) {
          if (value !== null && value !== undefined) {
            formData.append(key, String(value));
          }
        }
        options.body = formData.toString();
        options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      }

      const res = await fetch(url.toString(), options);
      const data = (await res.json()) as T | { error?: Record<string, unknown> };

      if (!res.ok || (typeof data === 'object' && data !== null && 'error' in data)) {
        const errorMsg = typeof data === 'object' && data !== null && 'error' in data
          ? ((data as any).error?.message ?? 'Unknown error')
          : `HTTP ${res.status}`;
        return { error: `Graph API error: ${errorMsg}` } as T | { error: string };
      }

      return data as T | { error: string };
    } catch (err) {
      return { error: `Request failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async postFeed(text: string, imageUrl?: string): Promise<{ id: string; error?: string }> {
    const targetId = this.pageId || 'me';
    const endpoint = `/${targetId}/feed`;

    if (imageUrl) {
      try {
        new URL(imageUrl);
      } catch {
        return { id: '', error: 'Invalid image_url: must be a valid URL' };
      }
    }

    const body: Record<string, unknown> = { message: text };
    if (imageUrl) {
      body.url = imageUrl;
    }

    const result = await this.request<FacebookPostResponse>(endpoint, 'POST', body);

    if ('error' in result) {
      return { id: '', error: result.error };
    }

    return { id: result.id || result.post_id || '' };
  }

  async search(query: string, limit: number = 20): Promise<{ posts: FacebookPost[]; error?: string }> {
    const url = new URL(`${GRAPH_API_BASE}/${DEFAULT_API_VERSION}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('type', 'post');
    url.searchParams.set('limit', String(Math.min(limit, 100)));

    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.accessToken}` },
      });
      const data = (await res.json()) as FacebookSearchResponse | { error?: Record<string, unknown> };

      if (!res.ok || (typeof data === 'object' && data !== null && 'error' in data)) {
        const errorMsg = typeof data === 'object' && data !== null && 'error' in data
          ? ((data as any).error?.message ?? 'Unknown error')
          : `HTTP ${res.status}`;
        return { posts: [], error: `Search failed: ${errorMsg}` };
      }

      const searchData = data as FacebookSearchResponse;
      const posts: FacebookPost[] = searchData.data
        .filter((item) => item.type === 'post')
        .map((item) => ({
          id: item.id,
          message: item.name || '',
          created_time: '',
          type: 'post',
        }));

      return { posts };
    } catch (err) {
      return {
        posts: [],
        error: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async getProfile(): Promise<{ profile: FacebookUser | null; error?: string }> {
    const result = await this.request<FacebookUser>('/me?fields=id,name,picture,bio');

    if ('error' in result) {
      return { profile: null, error: result.error };
    }

    return { profile: result };
  }

  async listFeed(limit: number = 20): Promise<{ posts: FacebookPost[]; error?: string }> {
    const targetId = this.pageId || 'me';
    const endpoint = `/${targetId}/feed`;
    const fields = 'id,message,story,created_time,type,link,picture,name,description,likes.summary(total_count),comments.summary(total_count),shares.summary(total_count)';

    const url = new URL(`${GRAPH_API_BASE}/${DEFAULT_API_VERSION}${endpoint}`);
    url.searchParams.set('fields', fields);
    url.searchParams.set('limit', String(Math.min(limit, 100)));

    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.accessToken}` },
      });
      const data = (await res.json()) as FacebookFeed | { error?: Record<string, unknown> };

      if (!res.ok || (typeof data === 'object' && data !== null && 'error' in data)) {
        const errorMsg = typeof data === 'object' && data !== null && 'error' in data
          ? ((data as any).error?.message ?? 'Unknown error')
          : `HTTP ${res.status}`;
        return { posts: [], error: `Feed fetch failed: ${errorMsg}` };
      }

      const feedData = data as FacebookFeed;
      return { posts: feedData.data || [] };
    } catch (err) {
      return {
        posts: [],
        error: `Feed fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
