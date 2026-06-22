// SPDX-License-Identifier: AGPL-3.0-or-later
export interface InstagramUser {
  id?: string;
  username?: string;
  name?: string;
  biography?: string;
  profile_picture_url?: string;
  followers_count?: number;
}

export interface InstagramMedia {
  id?: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  timestamp?: string;
  like_count?: number;
}

export interface InstagramSearchResult {
  media: InstagramMedia[];
  error?: string;
}

export interface InstagramPostResult {
  id?: string;
  error?: string;
}

export interface InstagramProfileResult {
  user?: InstagramUser;
  error?: string;
}
