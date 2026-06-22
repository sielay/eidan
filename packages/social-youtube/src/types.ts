// SPDX-License-Identifier: AGPL-3.0-or-later

export interface YouTubeSearchResult {
  kind: string;
  etag: string;
  nextPageToken?: string;
  items?: SearchItem[];
}

export interface SearchItem {
  kind: string;
  etag: string;
  id: {
    kind: string;
    videoId: string;
  };
  snippet: {
    publishedAt: string;
    title: string;
    description: string;
    thumbnails: Record<string, { url: string; width?: number; height?: number }>;
    channelId: string;
    channelTitle: string;
    liveBroadcastContent: string;
  };
}

export interface ChannelResponse {
  kind: string;
  etag: string;
  pageInfo: {
    totalResults: number;
    resultsPerPage: number;
  };
  items?: ChannelItem[];
}

export interface ChannelItem {
  kind: string;
  etag: string;
  id: string;
  snippet: {
    title: string;
    description: string;
    customUrl?: string;
    publishedAt: string;
    thumbnails: Record<string, { url: string; width?: number; height?: number }>;
    defaultLanguage?: string;
    localized?: {
      title: string;
      description: string;
    };
  };
  statistics: {
    viewCount: string;
    commentCount: string;
    subscriberCount: string;
    hiddenSubscriberCount: boolean;
    videoCount: string;
  };
}

export interface VideoListResponse {
  kind: string;
  etag: string;
  nextPageToken?: string;
  pageInfo: {
    totalResults: number;
    resultsPerPage: number;
  };
  items?: VideoItem[];
}

export interface VideoItem {
  kind: string;
  etag: string;
  id: string;
  snippet: {
    publishedAt: string;
    title: string;
    description: string;
    thumbnails: Record<string, { url: string; width?: number; height?: number }>;
    channelId: string;
    channelTitle: string;
    tags?: string[];
    categoryId: string;
    liveBroadcastContent: string;
    defaultLanguage?: string;
    localized?: {
      title: string;
      description: string;
    };
  };
  statistics: {
    viewCount: string;
    likeCount: string;
    dislikeCount?: string;
    favoriteCount: string;
    commentCount: string;
  };
}

export interface CommentThreadResponse {
  kind: string;
  etag: string;
  id: string;
  snippet: {
    videoId: string;
    topLevelComment: {
      kind: string;
      etag: string;
      id: string;
      snippet: {
        videoId: string;
        textDisplay: string;
        textOriginal: string;
        parentId: string;
        authorDisplayName: string;
        authorProfileImageUrl: string;
        authorChannelUrl: string;
        authorChannelId: {
          value: string;
        };
        canReply: boolean;
        canDelete: boolean;
        canLike: boolean;
        canReport: boolean;
        likeCount: number;
        publishedAt: string;
        updatedAt: string;
      };
    };
    canReply: boolean;
    totalReplyCount: number;
    isPublic: boolean;
  };
}

export interface CommentInsertResponse {
  kind: string;
  etag: string;
  id: string;
  snippet: {
    videoId: string;
    textDisplay: string;
    textOriginal: string;
    parentId: string;
    authorDisplayName: string;
    authorProfileImageUrl: string;
    authorChannelUrl: string;
    authorChannelId: {
      value: string;
    };
    canReply: boolean;
    canDelete: boolean;
    canLike: boolean;
    likeCount: number;
    publishedAt: string;
    updatedAt: string;
  };
}
