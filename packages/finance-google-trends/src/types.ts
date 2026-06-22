// SPDX-License-Identifier: AGPL-3.0-or-later
export interface TrendQuery {
  query?: string;
  interest?: number;
  timestamp?: string;
}

export interface TrendTopic {
  title?: string;
  id?: string;
  type?: string;
  relevance?: number;
}

export interface SearchTrendsResult {
  trends: TrendQuery[];
  error?: string;
}

export interface TopicsResult {
  topics: TrendTopic[];
  error?: string;
}

export interface RisingQueriesResult {
  queries: TrendQuery[];
  error?: string;
}
