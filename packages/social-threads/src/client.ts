// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ThreadsPost,
  ThreadsUser,
  CreateThreadResponse,
  ProfileResponse,
} from './types.js';

const THREADS_API_BASE = 'https://graph.threads.com/v18.0';

export class ThreadsClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  async post(text: string, replyTo?: string): Promise<{ id: string; error?: string }> {
    if (text.length === 0) {
      return { id: '', error: 'Post text is required' };
    }

    if (text.length > 500) {
      return { id: '', error: 'Post exceeds 500 character limit' };
    }

    try {
      const url = new URL(`${THREADS_API_BASE}/me/threads`);
      const body: Record<string, unknown> = { text };

      if (replyTo) {
        body.reply_to_id = replyTo;
      }

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        return { id: '', error: `Post failed: ${res.status}` };
      }

      const data = (await res.json()) as CreateThreadResponse;
      return { id: data.id };
    } catch {
      return {
        id: '',
        error: 'Failed to post to Threads',
      };
    }
  }

  async search(query: string, limit: number = 20): Promise<{ posts: ThreadsPost[]; error?: string }> {
    if (!query.trim()) {
      return { posts: [], error: 'Search query is required' };
    }

    try {
      // ponytail: ig_hashtag_search returns hashtags, not posts. Meta's Threads API doesn't expose
      // a post search endpoint to non-business accounts. This searches for hashtags by keyword.
      const url = new URL(`${THREADS_API_BASE}/ig_hashtag_search`);
      url.searchParams.set('q', query);
      url.searchParams.set('fields', 'id,name');

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      if (!res.ok) {
        return { posts: [], error: `Search failed: ${res.status}` };
      }

      const data = (await res.json()) as { data?: Array<{ id: string; name: string }> };
      const hashtags = data.data || [];

      const posts: ThreadsPost[] = hashtags
        .slice(0, Math.min(limit, 100))
        .map((tag) => ({
          id: tag.id,
          text: `#${tag.name}`,
          timestamp: new Date().toISOString(),
          permalink: `https://threads.net/search/${encodeURIComponent(tag.name)}`,
          author: {
            id: 'hashtag',
            username: tag.name,
          },
        }));

      return { posts };
    } catch {
      return {
        posts: [],
        error: 'Failed to search Threads',
      };
    }
  }

  async getProfile(): Promise<{ user: ThreadsUser | null; error?: string }> {
    try {
      const url = new URL(`${THREADS_API_BASE}/me`);
      url.searchParams.set(
        'fields',
        'id,username,biography,threads_profile_picture_url'
      );

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      if (!res.ok) {
        return {
          user: null,
          error: `Profile fetch failed: ${res.status}`,
        };
      }

      const data = (await res.json()) as ProfileResponse;
      return { user: data.data };
    } catch {
      return {
        user: null,
        error: 'Failed to get profile from Threads',
      };
    }
  }

  async listTimeline(limit: number = 20): Promise<{ posts: ThreadsPost[]; error?: string }> {
    try {
      const url = new URL(`${THREADS_API_BASE}/me/threads`);
      url.searchParams.set('limit', String(Math.min(limit, 100)));
      url.searchParams.set('fields', 'id,text,timestamp,permalink,like_count,reply_count,repost_count');

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      if (!res.ok) {
        return { posts: [], error: `Timeline fetch failed: ${res.status}` };
      }

      const data = (await res.json()) as {
        data?: Array<{
          id: string;
          text?: string;
          timestamp: string;
          permalink: string;
          like_count?: number;
          reply_count?: number;
          repost_count?: number;
        }>;
      };
      const postsData = data.data || [];

      const posts: ThreadsPost[] = postsData
        .slice(0, Math.min(limit, 100))
        .map((post) => ({
          id: post.id,
          ...(post.text !== undefined ? { text: post.text } : {}),
          timestamp: post.timestamp,
          permalink: post.permalink,
          ...(post.like_count !== undefined ? { like_count: post.like_count } : {}),
          ...(post.reply_count !== undefined ? { reply_count: post.reply_count } : {}),
          ...(post.repost_count !== undefined ? { repost_count: post.repost_count } : {}),
          author: {
            id: 'me',
            username: 'me',
          },
        }));

      return { posts };
    } catch {
      return {
        posts: [],
        error: 'Failed to list timeline from Threads',
      };
    }
  }
}
