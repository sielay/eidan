// SPDX-License-Identifier: AGPL-3.0-or-later

export interface FacebookErrorResponse {
  error: {
    message: string;
    type: string;
    code: number;
    fbtrace_id?: string;
  };
}

export interface FacebookUser {
  id: string;
  name: string;
  picture?: {
    data: {
      height: number;
      is_silhouette: boolean;
      url: string;
      width: number;
    };
  };
  friends?: {
    data: Array<{ name: string; id: string }>;
    summary?: { total_count: number };
  };
  bio?: string;
  email?: string;
}

export interface FacebookPost {
  id: string;
  message?: string;
  story?: string;
  created_time: string;
  type: string;
  link?: string;
  picture?: string;
  name?: string;
  description?: string;
  likes?: {
    data: Array<{ name: string; id: string }>;
    summary?: { total_count: number };
  };
  comments?: {
    data: Array<{ message: string; from: { name: string; id: string } }>;
    summary?: { total_count: number };
  };
  shares?: {
    data: Array<{ id: string }>;
  };
  from?: {
    name: string;
    id: string;
  };
}

export interface FacebookFeed {
  data: FacebookPost[];
  paging?: {
    cursors: {
      before: string;
      after: string;
    };
    next?: string;
    previous?: string;
  };
}

export interface FacebookSearchResponse {
  data: Array<{
    id: string;
    name: string;
    type?: string;
  }>;
  paging?: {
    cursors: {
      before: string;
      after: string;
    };
    next?: string;
    previous?: string;
  };
}

export interface FacebookPostResponse {
  id: string;
  post_id?: string;
}
