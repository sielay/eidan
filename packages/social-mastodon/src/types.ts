// SPDX-License-Identifier: AGPL-3.0-or-later
export interface MastodonAccount {
  id?: string;
  username?: string;
  displayName?: string;
  avatar?: string;
  note?: string;
}

export interface MastodonStatus {
  id?: string;
  content?: string;
  createdAt?: string;
  favouritesCount?: number;
  repliesCount?: number;
  reblogsCount?: number;
  account?: MastodonAccount;
}

export interface MastodonSearchResult {
  statuses: MastodonStatus[];
  error?: string;
}

export interface MastodonPostResult {
  id?: string;
  uri?: string;
  error?: string;
}

export interface MastodonProfileResult {
  account?: MastodonAccount;
  error?: string;
}
