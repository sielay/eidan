// SPDX-License-Identifier: AGPL-3.0-or-later

export interface TikTokUser {
  open_id?: string;
  union_id?: string;
  display_name?: string;
  bio_description?: string;
  is_verified?: boolean;
  follower_count?: number;
  following_count?: number;
  likes_count?: number;
  video_count?: number;
  profile_deep_link?: string;
}

export interface TikTokUserResponse {
  data?: { user?: TikTokUser };
  error?: { code?: string; message?: string };
}

export interface TikTokVideo {
  id: string;
  title?: string;
  video_description?: string;
  duration?: number;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
  create_time?: number;
  share_url?: string;
}

export interface TikTokVideoListResponse {
  data?: { videos?: TikTokVideo[]; cursor?: number; has_more?: boolean };
  error?: { code?: string; message?: string };
}

export interface TikTokPublishInitResponse {
  data?: { publish_id?: string };
  error?: { code?: string; message?: string };
}
