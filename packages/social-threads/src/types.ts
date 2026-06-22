// SPDX-License-Identifier: AGPL-3.0-or-later
export interface ThreadsUser {
  id?: string;
  username?: string;
  name?: string;
  biography?: string;
  profile_picture_url?: string;
  followers_count?: number;
}

export interface ThreadsPost {
  id?: string;
  text?: string;
  media_url?: string;
  timestamp?: string;
  like_count?: number;
  reply_count?: number;
}

export interface ThreadsSearchResult {
  posts: ThreadsPost[];
  error?: string;
}

export interface ThreadsPostResult {
  id?: string;
  error?: string;
}

export interface ThreadsProfileResult {
  user?: ThreadsUser;
  error?: string;
}
