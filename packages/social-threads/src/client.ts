// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretOpt } from './vault.js';
import type {
  ThreadsPost,
  ThreadsUser,
  CreateThreadResponse,
  SearchResponse,
  TimelineResponse,
  ProfileResponse,
  HashtagSearchResponse,
  Hashtag,
  TimelinePost,
  ThreadsHashtag,
} from './types.js';

const THREADS_API_BASE = 'https://graph.threads.com/v18.0';

export class ThreadsClient {
  private ctx: ToolContext;
  private cachedUsername: string | null = null;
  private cachedUsernameTime: number | null = null;
  private profileFetchPromise: Promise<{ user: ThreadsUser | null; error?: string }> | null = null;
  private readonly USERNAME_CACHE_TTL = 5 * 60 * 1000; // 5 minutes in ms

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  private async getAccessToken(): Promise<string | null> {
    return await secretOpt(this.ctx, 'THREADS_ACCESS_TOKEN');
  }

  async post(text: string, replyTo?: string): Promise<{ id: string; error?: string }> {
    const token = await this.getAccessToken();
    if (!token) {
      return {
        id: '',
        error:
          "Threads isn't connected — set THREADS_ACCESS_TOKEN in vault/env (Settings → Connections)",
      };
    }

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
          Authorization: `Bearer ${token}`,
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

  async search(query: string, limit: number = 20): Promise<{ hashtags: ThreadsHashtag[]; error?: string }> {
    const token = await this.getAccessToken();
    if (!token) {
      return {
        hashtags: [],
        error:
          "Threads isn't connected — set THREADS_ACCESS_TOKEN in vault/env (Settings → Connections)",
      };
    }

    if (!query.trim()) {
      return { hashtags: [], error: 'Search query is required' };
    }

    try {
      // ponytail: ig_hashtag_search returns hashtags, not posts. Meta's Threads API doesn't expose
      // a post search endpoint to non-business accounts. This searches for hashtags by keyword.
      const url = new URL(`${THREADS_API_BASE}/ig_hashtag_search`);
      url.searchParams.set('q', query);
      url.searchParams.set('fields', 'id,name');

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        return { hashtags: [], error: `Search failed: ${res.status}` };
      }

      const data = (await res.json()) as HashtagSearchResponse;
      const tags = data.data || [];

      const hashtags: ThreadsHashtag[] = tags
        .slice(0, Math.min(limit, 100))
        .filter((tag: Hashtag) => tag.id && tag.name)
        .map((tag: Hashtag) => ({
          id: tag.id,
          name: tag.name,
          search_url: `https://threads.net/search/${encodeURIComponent(tag.name)}`,
        }));

      return { hashtags };
    } catch {
      return {
        hashtags: [],
        error: 'Failed to search Threads',
      };
    }
  }

  async getProfile(): Promise<{ user: ThreadsUser | null; error?: string }> {
    const token = await this.getAccessToken();
    if (!token) {
      return {
        user: null,
        error:
          "Threads isn't connected — set THREADS_ACCESS_TOKEN in vault/env (Settings → Connections)",
      };
    }

    try {
      const url = new URL(`${THREADS_API_BASE}/me`);
      url.searchParams.set(
        'fields',
        'id,username,biography,threads_profile_picture_url'
      );

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
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
    const token = await this.getAccessToken();
    if (!token) {
      return {
        posts: [],
        error:
          "Threads isn't connected — set THREADS_ACCESS_TOKEN in vault/env (Settings → Connections)",
      };
    }

    try {
      // Fetch username once and cache it with TTL, preventing concurrent fetches and redundant API calls
      const now = Date.now();
      const isCacheExpired = !this.cachedUsernameTime || (now - this.cachedUsernameTime) > this.USERNAME_CACHE_TTL;

      if (isCacheExpired) {
        if (!this.profileFetchPromise) {
          this.profileFetchPromise = this.getProfile().then(profileRes => {
            if (!profileRes.error && profileRes.user) {
              this.cachedUsername = profileRes.user.username;
              this.cachedUsernameTime = Date.now();
            }
            return profileRes;
          }).finally(() => {
            this.profileFetchPromise = null;
          });
        }
        const profileRes = await this.profileFetchPromise;
        if (profileRes.error) {
          return { posts: [], error: profileRes.error };
        }
      }

      const url = new URL(`${THREADS_API_BASE}/me/threads`);
      url.searchParams.set('limit', String(Math.min(limit, 100)));
      url.searchParams.set('fields', 'id,text,timestamp,permalink,like_count,reply_count,repost_count');

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        return { posts: [], error: `Timeline fetch failed: ${res.status}` };
      }

      const data = (await res.json()) as TimelineResponse;
      const postsData = data.data || [];

      const posts: ThreadsPost[] = postsData
        .slice(0, Math.min(limit, 100))
        .filter((post: TimelinePost) => post.id && post.timestamp && post.permalink)
        .map((post: TimelinePost) => ({
          id: post.id,
          text: post.text,
          timestamp: post.timestamp,
          permalink: post.permalink,
          like_count: post.like_count,
          reply_count: post.reply_count,
          repost_count: post.repost_count,
          author: {
            id: 'me',
            username: this.cachedUsername || 'me',
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
