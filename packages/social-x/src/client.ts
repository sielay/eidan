// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  XUserProfile,
  XTweet,
  XUserResponse,
  XTweetsResponse,
  XCreateTweetResponse,
} from './types.js';

const BASE_URL = 'https://api.twitter.com/2';

export class XClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async makeRequest<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const data = await response.json();

    // X API v2 responses are validated by callers checking for data/errors properties
    return data as T;
  }

  async getMe(): Promise<{ profile: XUserProfile | null; error?: string }> {
    try {
      const result = await this.makeRequest<XUserResponse>(
        'GET',
        '/users/me?user.fields=created_at,description,public_metrics,verified,verified_type'
      );

      if (!result.data) {
        const errorMessage =
          result?.errors?.[0]?.message || 'Failed to fetch profile';
        return {
          profile: null,
          error: errorMessage,
        };
      }

      // Extract followers/following/tweet counts from public_metrics (X API v2 nests them there). Guard
      // each assignment so an absent metric doesn't violate exactOptionalPropertyTypes (number, not undefined).
      const profile = { ...result.data };
      const pm = result.data.public_metrics;
      if (pm) {
        if (pm.followers_count !== undefined) profile.followers_count = pm.followers_count;
        if (pm.following_count !== undefined) profile.following_count = pm.following_count;
        if (pm.tweet_count !== undefined) profile.tweet_count = pm.tweet_count;
      }

      return { profile };
    } catch (exc) {
      const errorMessage = exc instanceof Error ? exc.message : 'Unknown error';
      return {
        profile: null,
        error: `Failed to fetch profile: ${errorMessage}`,
      };
    }
  }

  async postTweet(
    text: string,
    replyToId?: string
  ): Promise<{ tweetId: string; text: string; error?: string }> {
    if (text.length > 280) {
      return {
        tweetId: '',
        text: '',
        error: 'Tweet exceeds 280 character limit',
      };
    }

    try {
      const body: Record<string, unknown> = { text };
      if (replyToId) {
        body.reply = { in_reply_to_tweet_id: replyToId };
      }

      const result = await this.makeRequest<XCreateTweetResponse>(
        'POST',
        '/tweets',
        body
      );

      if (!result.data) {
        const errorMessage =
          result?.errors?.[0]?.message || 'Failed to post tweet';
        return {
          tweetId: '',
          text: '',
          error: errorMessage,
        };
      }

      return { tweetId: result.data.id, text: result.data.text };
    } catch (exc) {
      const errorMessage = exc instanceof Error ? exc.message : 'Unknown error';
      return {
        tweetId: '',
        text: '',
        error: `Failed to post tweet: ${errorMessage}`,
      };
    }
  }

  async searchTweets(
    query: string,
    limit: number = 20
  ): Promise<{ tweets: XTweet[]; error?: string }> {
    try {
      const params = new URLSearchParams({
        query,
        max_results: String(Math.min(limit, 100)),
        'tweet.fields': 'created_at,public_metrics,author_id',
        expansions: 'author_id',
        'user.fields': 'username,name',
      });

      const result = await this.makeRequest<XTweetsResponse>(
        'GET',
        `/tweets/search/recent?${params.toString()}`
      );

      if (!result.data) {
        const errorMessage =
          result?.errors?.[0]?.message || 'Failed to search tweets';
        return {
          tweets: [],
          error: errorMessage,
        };
      }

      return { tweets: result.data };
    } catch (exc) {
      const errorMessage = exc instanceof Error ? exc.message : 'Unknown error';
      return {
        tweets: [],
        error: `Failed to search tweets: ${errorMessage}`,
      };
    }
  }

  // The authenticated user's HOME feed — the reverse-chronological stream of tweets from the accounts
  // they follow (not their own tweets). Paginates up to `maxResults` (or until posts are older than
  // `hours`), returning each tweet's author handle (from the expansion) + engagement metrics, so a feed
  // signal/noise analysis can rank who floods the timeline. Needs OAuth2 user context (tweet.read +
  // users.read) — this endpoint is not on the free API tier, so a 403 is surfaced as a clear message.
  async homeTimeline(
    maxResults = 200,
    hours = 24,
  ): Promise<{ tweets: XTweet[]; handles: Record<string, string>; error?: string }> {
    try {
      const me = await this.getMe();
      if (!me.profile) return { tweets: [], handles: {}, error: me.error ?? 'Failed to get authenticated user' };

      const cutoff = Date.now() - hours * 3600_000;
      const tweets: XTweet[] = [];
      const handles: Record<string, string> = {};
      let token: string | undefined;
      // Cap pages so a runaway loop can't hammer the rate limit; 100/page → 5 pages = up to 500 tweets.
      for (let page = 0; page < 6 && tweets.length < maxResults; page++) {
        const params = new URLSearchParams({
          max_results: '100',
          'tweet.fields': 'created_at,public_metrics,author_id',
          expansions: 'author_id',
          'user.fields': 'username,name',
        });
        if (token) params.set('pagination_token', token);
        const result = await this.makeRequest<XTweetsResponse>(
          'GET',
          `/users/${me.profile.id}/timelines/reverse_chronological?${params.toString()}`,
        );
        if (!result.data) {
          const msg = result?.errors?.[0]?.message || 'Failed to fetch home timeline';
          // First page failing = hard error; later pages failing = return what we have.
          if (page === 0) return { tweets: [], handles: {}, error: msg };
          break;
        }
        for (const u of result.includes?.users ?? []) handles[u.id] = u.username;
        tweets.push(...result.data);
        // Stop once we've paged past the requested window.
        const oldest = result.data[result.data.length - 1]?.created_at;
        if (oldest && Date.parse(oldest) < cutoff) break;
        token = result.meta?.next_token;
        if (!token) break;
      }
      const within = tweets.filter((t) => !t.created_at || Date.parse(t.created_at) >= cutoff).slice(0, maxResults);
      return { tweets: within, handles };
    } catch (exc) {
      return { tweets: [], handles: {}, error: `Failed to fetch home timeline: ${exc instanceof Error ? exc.message : 'Unknown error'}` };
    }
  }

  async getTimeline(
    limit: number = 20
  ): Promise<{ tweets: XTweet[]; error?: string }> {
    try {
      const me = await this.getMe();
      if (!me.profile) {
        return {
          tweets: [],
          error: me.error ?? 'Failed to get authenticated user: profile is null',
        };
      }

      const params = new URLSearchParams({
        max_results: String(Math.min(limit, 100)),
        'tweet.fields': 'created_at,public_metrics',
      });

      const result = await this.makeRequest<XTweetsResponse>(
        'GET',
        `/users/${me.profile.id}/tweets?${params.toString()}`
      );

      if (!result.data) {
        const errorMessage =
          result?.errors?.[0]?.message || 'Failed to fetch timeline';
        return {
          tweets: [],
          error: errorMessage,
        };
      }

      return { tweets: result.data };
    } catch (exc) {
      const errorMessage = exc instanceof Error ? exc.message : 'Unknown error';
      return {
        tweets: [],
        error: `Failed to fetch timeline: ${errorMessage}`,
      };
    }
  }
}

