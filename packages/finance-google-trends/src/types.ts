// SPDX-License-Identifier: AGPL-3.0-or-later

export interface TrendData {
  date: string;
  value: number;
}

export interface RelatedQuery {
  query: string;
  value: number;
}

export interface TopChart {
  title: string;
  exploreUrl: string;
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
