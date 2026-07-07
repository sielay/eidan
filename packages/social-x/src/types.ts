// SPDX-License-Identifier: AGPL-3.0-or-later

export interface XUserProfile {
  id: string;
  name: string;
  username: string;
  created_at?: string;
  description?: string;
  followers_count?: number;
  following_count?: number;
  tweet_count?: number;
  verified?: boolean;
  verified_type?: string;
  public_metrics?: {
    followers_count?: number;
    following_count?: number;
    tweet_count?: number;
    listed_count?: number;
  };
}

export interface XTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: {
    retweet_count?: number;
    reply_count?: number;
    like_count?: number;
    quote_count?: number;
  };
}

export interface XUserResponse {
  data?: XUserProfile;
  errors?: Array<{ message: string; type?: string }>;
}

export interface XTweetsResponse {
  data?: XTweet[];
  includes?: {
    users?: Array<{ id: string; username: string; name?: string }>;
  };
  meta?: {
    result_count?: number;
    newest_id?: string;
    oldest_id?: string;
    next_token?: string;
  };
  errors?: Array<{ message: string; type?: string }>;
}

export interface XCreateTweetResponse {
  data?: {
    id: string;
    text: string;
  };
  errors?: Array<{ message: string; type?: string }>;
}

export interface XSearchMetadata {
  query_count?: number;
  result_count?: number;
  newest_id?: string;
  oldest_id?: string;
}
