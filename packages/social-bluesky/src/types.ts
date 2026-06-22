// SPDX-License-Identifier: AGPL-3.0-or-later

export interface JwtPayload {
  jwt: string;
}

export interface CreateSessionResponse {
  did: string;
  handle: string;
  email?: string;
  accessJwt: string;
  refreshJwt: string;
}

export interface RefreshSessionResponse {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
}

export interface SessionState {
  accessJwt: string;
  did: string;
  service: string;
}

export interface FacetIndex {
  byteStart: number;
  byteEnd: number;
}

export interface Facet {
  index: FacetIndex;
  features: Array<
    | { $type: 'app.bsky.richtext.facet#link'; uri: string }
    | { $type: 'app.bsky.richtext.facet#tag'; tag: string }
  >;
}

export interface BlobRef {
  $type: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
}

export interface CreateRecordResponse {
  uri: string;
  cid: string;
}

export interface FeedPost {
  uri: string;
  cid: string;
  author: {
    did: string;
    handle: string;
    displayName?: string;
    avatar?: string;
  };
  record: {
    text: string;
    createdAt: string;
  };
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
  quoteCount?: number;
}

export interface FeedResponse {
  feed?: Array<{ post: FeedPost }>;
}

export interface SearchPostsResponse {
  posts?: FeedPost[];
}

export interface GetPostsResponse {
  posts?: Array<{
    uri: string;
    cid: string;
    author: {
      did: string;
      handle: string;
      displayName?: string;
      avatar?: string;
    };
    record: {
      text: string;
      createdAt: string;
    };
    likeCount?: number;
    replyCount?: number;
    repostCount?: number;
    quoteCount?: number;
  }>;
}
