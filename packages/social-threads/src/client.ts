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

      // Returns hashtag metadata only; post search is not available via the Threads API.
      const hashtags: ThreadsHashtag[] = tags
        .slice(0, Math.min(limit, 100))
        .filter((tag: Hashtag) => tag.id && tag.name && /^[\w\s\-_.]+$/.test(tag.name))
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
        'id,username,biography,threads_profile_picture_url,follower_count,following_count,is_verified,website'
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
      const profile = data.data;
      if (!profile) {
        return { user: null, error: 'No profile data returned' };
      }

      // Explicitly filter to only expected fields to guard against API changes or unexpected data.
      const safeProfile: ThreadsUser = {
        id: String(profile.id || ''),
        username: String(profile.username || ''),
        biography: profile.biography ? String(profile.biography) : undefined,
        threads_profile_picture_url: profile.threads_profile_picture_url
          ? String(profile.threads_profile_picture_url)
          : undefined,
        follower_count: typeof profile.follower_count === 'number' ? profile.follower_count : 0,
        following_count: typeof profile.following_count === 'number' ? profile.following_count : 0,
        is_verified: Boolean(profile.is_verified),
        website: profile.website ? String(profile.website) : undefined,
      };

      return { user: safeProfile };
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
            id: 'unknown',
            username: 'unknown',
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
