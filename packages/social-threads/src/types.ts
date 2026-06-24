// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ThreadsUser {
  id: string;
  username: string;
  name?: string;
  biography?: string;
  profile_picture_url?: string;
  follower_count?: number;
  following_count?: number;
  threads_profile_picture_url?: string;
  is_verified?: boolean;
  website?: string;
}

export interface ThreadsPost {
  id: string;
  text?: string;
  timestamp: string;
  permalink: string;
  author: {
    id: string;
    username: string;
    name?: string;
    profile_picture_url?: string;
  };
  like_count?: number;
  reply_count?: number;
  repost_count?: number;
  quote_count?: number;
  hidden?: boolean;
}

export interface CreateThreadResponse {
  id: string;
  thread_id: string;
}

export interface UserResponse {
  data: ThreadsUser;
}

export interface PostResponse {
  data: ThreadsPost;
}

export interface Hashtag {
  id: string;
  name: string;
}

export interface ThreadsHashtag {
  id: string;
  name: string;
  search_url: string;
}

export interface HashtagSearchResponse {
  data: Hashtag[];
}

export interface TimelinePost {
  id: string;
  text?: string;
  timestamp: string;
  permalink: string;
  like_count?: number;
  reply_count?: number;
  repost_count?: number;
}

export interface SearchResponse {
  data?: ThreadsPost[];
}

export interface TimelineResponse {
  data?: TimelinePost[];
  paging?: {
    cursors?: {
      before?: string;
      after?: string;
    };
  };
}

export interface ProfileResponse {
  data: ThreadsUser;
}
