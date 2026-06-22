// SPDX-License-Identifier: AGPL-3.0-or-later
export interface PerformanceMetric {
  page?: string;
  query?: string;
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export interface Sitemap {
  path?: string;
  type?: string;
  lastSubmitted?: string;
  lastRead?: string;
  indexed?: number;
}

export interface IndexingStatus {
  status?: string;
  lastCrawlTime?: string;
  indexedPages?: number;
  excludedPages?: number;
}

export interface GSCResult {
  data?: any;
  error?: string;
}
