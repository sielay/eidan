// SPDX-License-Identifier: AGPL-3.0-or-later

export interface LinkedInProfile {
  id: string;
  localizedFirstName?: string;
  localizedLastName?: string;
  localizedHeadline?: string;
  profilePicture?: {
    displayImage?: string;
  };
}

export interface LinkedInElement {
  id?: string;
  actor?: string;
  created?: number;
  lastModified?: number;
}

export interface LinkedInPost {
  id: string;
  actor: string;
  content?: {
    contentEntities?: Array<{ entityLocation: string }>;
    description?: string;
    title?: string;
  };
  created?: number;
  liked?: boolean;
  likesSummary?: {
    totalLikes: number;
  };
  commentsSummary?: {
    totalFirstLevelComments: number;
  };
}

export interface LinkedInFeedResponse {
  elements?: LinkedInPost[];
  paging?: {
    start: number;
    count: number;
    total: number;
  };
}

export interface LinkedInSearchResponse {
  elements?: LinkedInPost[];
  paging?: {
    start: number;
    count: number;
    total: number;
  };
}

export interface LinkedInCreatePostResponse {
  id: string;
}

export interface LinkedInProfileResponse {
  id: string;
  localizedFirstName?: string;
  localizedLastName?: string;
  localizedHeadline?: string;
  profilePicture?: {
    displayImage?: string;
  };
  firstName?: {
    localized?: {
      [key: string]: string;
    };
    preferredLocale?: {
      language: string;
      country: string;
    };
  };
  lastName?: {
    localized?: {
      [key: string]: string;
    };
    preferredLocale?: {
      language: string;
      country: string;
    };
  };
  headline?: {
    localized?: {
      [key: string]: string;
    };
    preferredLocale?: {
      language: string;
      country: string;
    };
  };
}
