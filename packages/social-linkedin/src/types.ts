// SPDX-License-Identifier: AGPL-3.0-or-later

export interface LinkedInProfile {
  id: string;
  localizedFirstName?: string;
  localizedLastName?: string;
  localizedHeadline?: string;
  profilePicture?: {
    elements?: Array<{
      identifiers?: Array<{
        identifier?: string;
      }>;
    }>;
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

export interface LinkedInAssetRegisterResponse {
  value: {
    mediaReferenceObjectId?: string;
    uploadMechanism?: {
      'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'?: {
        uploadUrl: string;
      };
    };
  };
}

export interface LinkedInUGCPostRequest {
  author: string;
  lifecycleState: 'PUBLISHED' | 'DRAFT';
  specificContent: {
    'com.linkedin.ugc.ShareContent': {
      shareCommentary: {
        text: string;
      };
      shareMediaCategory: 'NONE' | 'IMAGE' | 'ARTICLE' | 'VIDEO';
      media?: Array<{
        status: string;
        media: string;
      }>;
    };
  };
  visibility: {
    'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' | 'CONNECTIONS' | 'LOGGED_IN' | 'PRIVATE';
  };
}

export interface LinkedInProfileResponse {
  id: string;
  localizedFirstName?: string;
  localizedLastName?: string;
  localizedHeadline?: string;
  profilePicture?: {
    elements?: Array<{
      identifiers?: Array<{
        identifier?: string;
      }>;
    }>;
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
