// SPDX-License-Identifier: AGPL-3.0-or-later

export interface InstagramUser {
  id: string;
  username: string;
  name?: string;
  biography?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  profile_picture_url?: string;
  ig_id?: string;
  is_professional_account?: boolean;
  website?: string;
}

export interface InstagramMedia {
  id: string;
  caption?: string;
  media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL';
  media_url?: string;
  permalink: string;
  timestamp: string;
  like_count?: number;
  comments_count?: number;
  username?: string;
}

export interface InstagramHashtag {
  id: string;
  name: string;
}

export interface InstagramHashtagSearch {
  data: InstagramHashtag[];
}

export interface InstagramMediaSearchResponse {
  data?: InstagramMedia[];
  error?: {
    message: string;
    code: number;
  };
}

export interface InstagramUserResponse {
  user: InstagramUser;
  error?: {
    message: string;
    code: number;
  };
}

export interface InstagramMediaUploadResponse {
  id: string;
  error?: {
    message: string;
    code: number;
  };
}

export interface InstagramErrorResponse {
  error?: {
    message: string;
    code: number;
    error_code?: number;
    error_user_title?: string;
  };
}
