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
  ): Promise<T | null> {
    const url = `${BASE_URL}${path}`;
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  async getMe(): Promise<{ profile: XUserProfile | null; error?: string }> {
    const result = await this.makeRequest<XUserResponse>(
      'GET',
      '/users/me?user.fields=created_at,description,followers_count,following_count,public_metrics,verified,verified_type'
    );

    if (!result || !result.data) {
      return {
        profile: null,
        error: result?.errors?.[0]?.message || 'Failed to fetch profile',
      };
    }

    return { profile: result.data };
  }

  async postTweet(
    text: string,
    replyToId?: string
  ): Promise<{ tweetId: string; text: string; error?: string }> {
    if (text.length > 280) {
      return {
        tweetId: '',
        text,
        error: 'Tweet exceeds 280 character limit',
      };
    }

    const body: Record<string, unknown> = { text };
    if (replyToId) {
      body.reply = { in_reply_to_tweet_id: replyToId };
    }

    const result = await this.makeRequest<XCreateTweetResponse>(
      'POST',
      '/tweets',
      body
    );

    if (!result || !result.data) {
      return {
        tweetId: '',
        text,
        error: result?.errors?.[0]?.message || 'Failed to post tweet',
      };
    }

    return { tweetId: result.data.id, text: result.data.text };
  }

  async searchTweets(
    query: string,
    limit: number = 20
  ): Promise<{ tweets: XTweet[]; error?: string }> {
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

    if (!result || !result.data) {
      return {
        tweets: [],
        error: result?.errors?.[0]?.message || 'Failed to search tweets',
      };
    }

    return { tweets: result.data };
  }

  async getTimeline(
    limit: number = 20
  ): Promise<{ tweets: XTweet[]; error?: string }> {
    const me = await this.getMe();
    if (!me.profile) {
      return {
        tweets: [],
        error: me.error || 'Failed to get authenticated user',
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

    if (!result || !result.data) {
      return {
        tweets: [],
        error: result?.errors?.[0]?.message || 'Failed to fetch timeline',
      };
    }

    return { tweets: result.data };
  }
}

export async function createXClient(
  ctx: ToolContext
): Promise<{ client: XClient | null; error?: string }> {
  const accessToken = await secretOpt(ctx, 'X_ACCESS_TOKEN');

  if (!accessToken) {
    return {
      client: null,
      error: "X isn't connected — set X_ACCESS_TOKEN in vault (Settings → Connections)",
    };
  }

  return { client: new XClient(ctx, accessToken) };
}
