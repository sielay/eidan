// SPDX-License-Identifier: AGPL-3.0-or-later
export interface YouTubeVideo {
  id?: string;
  title?: string;
  description?: string;
  publishedAt?: string;
  viewCount?: number;
  likeCount?: number;
}

export interface YouTubeChannel {
  id?: string;
  title?: string;
  description?: string;
  subscriberCount?: number;
  videoCount?: number;
}

export interface YouTubeSearchResult {
  videos: YouTubeVideo[];
  error?: string;
}

export interface YouTubeUploadResult {
  id?: string;
  error?: string;
}

export interface YouTubeChannelResult {
  channel?: YouTubeChannel;
  error?: string;
}
