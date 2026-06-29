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

      // Clamp limit to valid range
      const clampedLimit = Math.max(1, Math.min(limit, 50));

      const response = await fetch(
        `${API_BASE}/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${clampedLimit}&key=${apiKey}`,
        {
          headers: {
            Accept: 'application/json',
          },
        }
      );

      if (!response.ok) {
        return { videos: [], error: 'Failed to search YouTube.' };
      }

      const data = (await response.json()) as { items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string } }> };
      return {
        videos: (data.items || [])
          .filter((item) => item.id?.videoId && item.snippet?.title)
          .map((item) => ({
            id: item.id!.videoId!,
            title: item.snippet!.title!,
          })),
      };
    } catch (error) {
      return { videos: [], error: 'Failed to search YouTube.' };
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
        return { error: 'Failed to retrieve YouTube channel information.' };
      }

      const data = (await response.json()) as {
        items?: Array<{
          id?: string;
          snippet?: { title?: string; description?: string };
          statistics?: { subscriberCount?: string; videoCount?: string };
        }>;
      };
      const channel = data.items?.[0];

      if (!channel?.id || !channel?.snippet?.title) {
        return { error: 'Failed to retrieve YouTube channel information.' };
      }

      return {
        channel: {
          id: channel.id,
          title: channel.snippet.title,
          ...(channel.snippet?.description && { description: channel.snippet.description }),
          subscriberCount: parseInt(channel?.statistics?.subscriberCount || '0'),
          videoCount: parseInt(channel?.statistics?.videoCount || '0'),
        },
      };
    } catch (error) {
      return { error: 'Failed to retrieve YouTube channel information.' };
    }
  }

  async uploadMetadata(title: string, description: string, privacyStatus: string = 'private'): Promise<YouTubeUploadResult> {
    // ponytail: videos.insert endpoint requires multipart upload with video file (media part) + metadata (snippet/status)
    // this method only creates metadata; the actual video file upload requires resumable upload protocol
    // upgrade path: implement resumable upload with fetch in chunks, or switch to gapi.youtube.videos.insert
    try {
      // Validate title length
      if (title.length > 100) {
        return { error: `Title exceeds maximum length of 100 characters (got ${title.length}).` };
      }

      // Validate description length
      if (description.length > 5000) {
        return { error: `Description exceeds maximum length of 5000 characters (got ${description.length}).` };
      }

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
            privacyStatus,
          },
        }),
      });

      if (!response.ok) {
        return { error: 'Failed to upload video metadata to YouTube.' };
      }

      const result = (await response.json()) as { id?: string };
      if (!result.id) {
        return { error: 'Failed to upload video metadata to YouTube.' };
      }
      return { id: result.id };
    } catch (error) {
      return { error: 'Failed to upload video metadata to YouTube.' };
    }
  }
}
