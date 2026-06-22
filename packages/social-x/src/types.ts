// SPDX-License-Identifier: AGPL-3.0-or-later
export interface XUser {
  id?: string;
  name?: string;
  username?: string;
  description?: string;
  followers_count?: number;
}

export interface XTweet {
  id?: string;
  text?: string;
  created_at?: string;
  public_metrics?: {
    like_count?: number;
    reply_count?: number;
    retweet_count?: number;
  };
  author_id?: string;
}

export interface XSearchResult {
  tweets: XTweet[];
  error?: string;
}

export interface XPostResult {
  id?: string;
  error?: string;
}

export interface XProfileResult {
  user?: XUser;
  error?: string;
}
