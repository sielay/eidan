// SPDX-License-Identifier: AGPL-3.0-or-later

export interface Account {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  locked: boolean;
  bot: boolean;
  discoverable?: boolean;
  group?: boolean;
  created_at: string;
  note: string;
  url: string;
  uri: string;
  avatar: string;
  avatar_static: string;
  header: string;
  header_static: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  last_status_at?: string;
}

export interface Status {
  id: string;
  created_at: string;
  in_reply_to_id?: string | null;
  in_reply_to_account_id?: string | null;
  sensitive: boolean;
  spoiler_text: string;
  visibility: 'public' | 'unlisted' | 'private' | 'direct';
  language?: string | null;
  uri: string;
  url: string;
  replies_count: number;
  reblogs_count: number;
  favourites_count: number;
  edited_at?: string | null;
  content: string;
  reblog?: Status | null;
  application?: {
    name: string;
    website?: string;
  };
  account: Account;
  media_attachments: Array<{
    id: string;
    type: 'image' | 'gifv' | 'video' | 'unknown';
    url: string;
    preview_url: string;
  }>;
  mentions: Array<{
    id: string;
    username: string;
    url: string;
    acct: string;
  }>;
  tags: Array<{
    name: string;
    url: string;
  }>;
  emojis: Array<{
    shortcode: string;
    url: string;
    static_url: string;
    visible_in_picker: boolean;
  }>;
}

export interface CreateStatusRequest {
  status: string;
  in_reply_to_id?: string;
  visibility?: 'public' | 'unlisted' | 'private' | 'direct';
  sensitive?: boolean;
  spoiler_text?: string;
  media_ids?: string[];
}

export interface SearchResults {
  accounts: Account[];
  statuses: Status[];
  hashtags: Array<{
    name: string;
    url: string;
    history: Array<{
      day: string;
      accounts: string;
      uses: string;
    }>;
  }>;
}

export interface VerifyCredentialsResponse {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  locked: boolean;
  bot: boolean;
  discoverable?: boolean;
  group?: boolean;
  created_at: string;
  note: string;
  url: string;
  uri: string;
  avatar: string;
  avatar_static: string;
  header: string;
  header_static: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  last_status_at?: string;
}

export interface TimelineParams {
  limit?: number;
  max_id?: string;
  min_id?: string;
  since_id?: string;
  exclude_replies?: boolean;
  exclude_reblogs?: boolean;
  only_media?: boolean;
}
