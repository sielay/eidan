// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  YouTubeSearchResult,
  ChannelResponse,
  CommentInsertResponse,
} from './types.js';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

export class YouTubeClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async fetch<T>(
    endpoint: string,
    params: Record<string, string | number | boolean> = {}
  ): Promise<T | { error: string }> {
    try {
      const url = new URL(`${API_BASE}${endpoint}`);
      url.searchParams.set('access_token', this.accessToken);
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, String(v));
      }

      const res = await fetch(url.toString());
      if (!res.ok) {
        const text = await res.text();
        return { error: `YouTube API error: ${res.status} ${text}` };
      }
      return (await res.json()) as T;
    } catch (exc) {
      return { error: `YouTube API request failed: ${String(exc)}` };
    }
  }

  async search(query: string, limit: number = 20): Promise<{ videos: Array<any>; error?: string }> {
    const result = await this.fetch<YouTubeSearchResult>('/search', {
      q: query,
      type: 'video',
      part: 'snippet',
      maxResults: Math.min(limit, 50),
      order: 'relevance',
    });

    if ('error' in result) {
      return { videos: [], error: result.error };
    }

    return {
      videos: (result.items ?? []).map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        description: item.snippet.description,
        channelTitle: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt,
      })),
    };
  }

  async getChannel(): Promise<{ channel?: any; error?: string }> {
    const result = await this.fetch<ChannelResponse>('/channels', {
      part: 'snippet,statistics',
      mine: true,
    });

    if ('error' in result) {
      return { error: result.error };
    }

    if (!result.items || result.items.length === 0) {
      return { error: 'No channel found' };
    }

    const channel = result.items[0];
    if (!channel) {
      return { error: 'No channel found' };
    }
    return {
      channel: {
        channelId: channel.id,
        title: channel.snippet.title,
        description: channel.snippet.description,
        subscribers: channel.statistics.subscriberCount,
        views: channel.statistics.viewCount,
        videos: channel.statistics.videoCount,
      },
    };
  }

  async listVideos(limit: number = 20): Promise<{ videos: Array<any>; error?: string }> {
    const result = await this.fetch<YouTubeSearchResult>('/search', {
      forMine: true,
      type: 'video',
      part: 'snippet',
      maxResults: Math.min(limit, 50),
      order: 'date',
    });

    if ('error' in result) {
      return { videos: [], error: result.error };
    }

    return {
      videos: (result.items ?? []).map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        description: item.snippet.description,
        publishedAt: item.snippet.publishedAt,
      })),
    };
  }

  async postComment(videoId: string, text: string): Promise<{ commentId?: string; error?: string }> {
    if (text.length > 10000) {
      return { error: 'Comment text exceeds maximum length of 10,000 characters' };
    }

    try {
      const url = new URL(`${API_BASE}/commentThreads`);
      url.searchParams.set('access_token', this.accessToken);
      url.searchParams.set('part', 'snippet');

      const body = {
        snippet: {
          videoId,
          textOriginal: text,
        },
      };

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        return { error: `Failed to post comment: ${res.status} ${text}` };
      }

      const data = (await res.json()) as CommentInsertResponse;
      return { commentId: data.id };
    } catch (exc) {
      return { error: `Failed to post comment: ${String(exc)}` };
    }
  }
}
