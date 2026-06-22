// SPDX-License-Identifier: AGPL-3.0-or-later
export interface FacebookUser {
  id?: string;
  name?: string;
  email?: string;
  picture?: string;
}

export interface FacebookPost {
  id?: string;
  message?: string;
  created_time?: string;
  likes?: { data?: Array<{ id?: string }> };
  comments?: { data?: Array<{ id?: string }> };
}

export interface FacebookSearchResult {
  posts: FacebookPost[];
  error?: string;
}

export interface FacebookPostResult {
  id?: string;
  error?: string;
}

export interface FacebookProfileResult {
  user?: FacebookUser;
  error?: string;
}
