// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type { YouTubeSearchResult, YouTubeUploadResult, YouTubeChannelResult } from './types.js';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

export class YouTubeClient {
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  async search(query: string, limit: number = 10): Promise<YouTubeSearchResult> {
    try {
      const apiKey = await secretRequired(this.ctx, 'YOUTUBE_API_KEY');

      const response = await fetch(
        `${API_BASE}/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${Math.min(limit, 50)}&key=${apiKey}`,
        {
          headers: {
            Accept: 'application/json',
          },
        }
      );

      if (!response.ok) {
        return { videos: [], error: `YouTube API error: ${response.status}` };
      }

      const data = (await response.json()) as { items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string } }> };
      return {
        videos: (data.items || []).map((item) => ({
          id: item.id?.videoId,
          title: item.snippet?.title,
        })),
      };
    } catch (error) {
      return { videos: [], error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async getChannel(): Promise<YouTubeChannelResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'YOUTUBE_ACCESS_TOKEN');

      const response = await fetch(`${API_BASE}/channels?part=snippet,statistics&mine=true`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        return { error: `YouTube API error: ${response.status}` };
      }

      const data = (await response.json()) as { items?: Array<{ id?: string; snippet?: any; statistics?: any }> };
      const channel = data.items?.[0];

      return {
        channel: {
          id: channel?.id,
          title: channel?.snippet?.title,
          description: channel?.snippet?.description,
          subscriberCount: parseInt(channel?.statistics?.subscriberCount || '0'),
          videoCount: parseInt(channel?.statistics?.videoCount || '0'),
        },
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async uploadMetadata(title: string, description: string): Promise<YouTubeUploadResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'YOUTUBE_ACCESS_TOKEN');

      const response = await fetch(`${API_BASE}/videos?part=snippet,status`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          snippet: {
            title,
            description,
            tags: ['eidan'],
            categoryId: '22',
          },
          status: {
            privacyStatus: 'private',
          },
        }),
      });

      if (!response.ok) {
        return { error: `YouTube API error: ${response.status}` };
      }

      const result = (await response.json()) as { id?: string };
      return { id: result.id };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
