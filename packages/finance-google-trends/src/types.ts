// SPDX-License-Identifier: AGPL-3.0-or-later

export interface TrendData {
  date: string;
  // Value is always a number after extraction/normalization in the client.
  // Google Trends may return value as a single number or an array; we extract the first element if array.
  value: number;
}

export interface RelatedQuery {
  query: string;
  // value may be missing in API response; defaults to 0 if absent
  value?: number;
}

export interface TopChart {
  title: string;
  // exploreUrl may not always be present in the API response
  exploreUrl: string | null;
  deltaMonthOverMonth: number;
}

export interface SearchTrendResult {
  query: string;
  timeframe: string;
  geo: string;
  category: string;
  trends: TrendData[];
  error?: string;
}

export interface TopChartsResult {
  category: string;
  geo: string;
  date: string;
  charts: TopChart[];
  error?: string;
}

export interface RisingQueriesResult {
  category: string;
  geo: string;
  queries: RelatedQuery[];
  error?: string;
}

export interface RelatedQueriesResult {
  query: string;
  geo: string;
  queries: RelatedQuery[];
  topics: RelatedQuery[];
  error?: string;
}
