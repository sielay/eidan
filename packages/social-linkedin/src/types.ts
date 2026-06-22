// SPDX-License-Identifier: AGPL-3.0-or-later
export interface LinkedInProfile {
  localizedFirstName?: string;
  localizedLastName?: string;
  profilePicture?: string;
  headline?: string;
}

export interface LinkedInPost {
  id?: string;
  text?: string;
  createdAt?: string;
  likes?: number;
  comments?: number;
  reposts?: number;
}

export interface LinkedInSearchResult {
  posts: LinkedInPost[];
  error?: string;
}

export interface LinkedInPostResult {
  id?: string;
  uri?: string;
  error?: string;
}

export interface LinkedInProfileResult {
  profile?: LinkedInProfile;
  error?: string;
}
