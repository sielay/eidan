// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretOpt } from './vault.js';
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
  private ctx: ToolContext;

  constructor(ctx: ToolContext, accessToken: string) {
    this.ctx = ctx;
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
        '/users/me?user.fields=created_at,description,followers_count,following_count,public_metrics,verified,verified_type'
      );

      if (!result.data) {
        const errorMessage =
          result?.errors?.[0]?.message || 'Failed to fetch profile';
        return {
          profile: null,
          error: errorMessage,
        };
      }

      return { profile: result.data };
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

export async function createXClient(
  ctx: ToolContext
): Promise<{ client: XClient | null; error?: string }> {
  try {
    const accessToken = await secretOpt(ctx, 'X_ACCESS_TOKEN');

    if (!accessToken) {
      return {
        client: null,
        error: "X isn't connected — set X_ACCESS_TOKEN in vault (Settings → Connections)",
      };
    }

    return { client: new XClient(ctx, accessToken) };
  } catch (exc) {
    const errorMessage = exc instanceof Error ? exc.message : 'Unknown vault error';
    return {
      client: null,
      error: `Failed to access X credentials: ${errorMessage}`,
    };
  }
}
