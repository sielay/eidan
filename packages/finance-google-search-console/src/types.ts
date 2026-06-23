// SPDX-License-Identifier: AGPL-3.0-or-later

export interface PerformanceRow {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  keys?: string[];
}

export interface PerformanceResponse {
  rows?: PerformanceRow[];
  responseAggregationType?: string;
}

export interface Sitemap {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  type?: string;
  isSitemapIndex?: boolean;
  isPending?: boolean;
  isFailed?: boolean;
  contents?: Array<{
    type?: string;
    indexed?: string;
    submitted?: string;
    errors?: string;
  }>;
}

export interface SitemapListResponse {
  sitemap?: Sitemap[];
}

export interface CoverageIndex {
  indexedPages?: string;
  totalPages?: string;
  robotsTxtState?: string;
}

export interface CoverageError {
  category?: string;
  impact?: string;
  errorCount?: string;
  errorExamples?: Array<{
    example?: string;
    timestamp?: string;
    pageUrl?: string;
  }>;
  pageFetched?: string;
  lastCrawlTime?: string;
  resourceType?: string;
}

export interface CoverageResponse {
  coveredPages?: string;
  crawlablePages?: string;
  indexingState?: string;
  robotsTxt?: CoverageIndex;
  page?: CoverageIndex;
  pageControlledByHttpsStatus?: CoverageIndex;
  pageWithoutCanonical?: CoverageIndex;
  pageIndexStatus?: Array<{
    category?: string;
    pages?: string;
    coverage?: string;
  }>;
}

export interface IndexingErrorResponse {
  inspectionResult?: {
    inspectionUrl?: string;
    inspectionTime?: string;
    googlebot?: {
      crawlTime?: string;
      robotsTxtState?: string;
      pageFetchState?: string;
      userAgent?: string;
    };
    crawlState?: string;
    indexingState?: string;
    verdict?: string;
    pageState?: string;
    resources?: Array<{
      http?: Array<{
        httpStatusCode?: number;
        mimeType?: string;
      }>;
      url?: string;
    }>;
    mobileUsability?: {
      mobileFriendly?: boolean;
      issues?: Array<{
        rule?: string;
        message?: string;
        severity?: string;
      }>;
    };
    amp?: {
      ampIndexingState?: string;
      ampUrl?: string;
      issues?: Array<{
        issue?: string;
        severity?: string;
        message?: string;
      }>;
    };
    crawlIssues?: Array<{
      issueType?: string;
      severity?: string;
      details?: string;
    }>;
  };
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}
