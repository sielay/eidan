// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type {
  PerformanceResponse,
  SitemapListResponse,
  CoverageResponse,
  IndexingErrorResponse,
  PerformanceRow,
  Sitemap,
  CoverageError,
} from './types.js';

const GSC_API_BASE = 'https://www.googleapis.com/webmasters/v3';

export class GoogleSearchConsoleClient {
  private ctx: ToolContext;
  private propertyUrl: string;
  private accessToken: string;

  constructor(ctx: ToolContext, propertyUrl: string, accessToken: string) {
    this.ctx = ctx;
    this.propertyUrl = propertyUrl;
    this.accessToken = accessToken;
  }

  private encodeProperty(url: string): string {
    return encodeURIComponent(url);
  }

  private async request<T>(
    endpoint: string,
    options?: {
      method?: string;
      body?: unknown;
    }
  ): Promise<T> {
    const url = `${GSC_API_BASE}${endpoint}`;
    const body = options?.body ? JSON.stringify(options.body) : null;
    const res = await fetch(url, {
      method: options?.method || 'GET',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body } : {}),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GSC API error (${res.status}): ${text}`);
    }

    return (await res.json()) as T;
  }

  async getPerformance(days: number = 7, limit: number = 10): Promise<{
    error?: string;
    data?: Array<{
      query?: string;
      page?: string;
      clicks: number;
      impressions: number;
      ctr: number;
      avgPosition: number;
    }>;
  }> {
    try {
      const endDate = new Date();
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - days);

      const formatDate = (d: Date): string => d.toISOString().split('T')[0]!;

      const body = {
        startDate: formatDate(startDate),
        endDate: formatDate(endDate),
        dimensions: ['query', 'page'],
        rowLimit: limit,
      };

      const response = await this.request<PerformanceResponse>(
        `/sites/${this.encodeProperty(this.propertyUrl)}/searchAnalytics/query`,
        {
          method: 'POST',
          body,
        }
      );

      const data = (response.rows || []).map((row: PerformanceRow) => ({
        query: row.keys?.[0] || 'unknown',
        page: row.keys?.[1] || 'unknown',
        clicks: row.clicks || 0,
        impressions: row.impressions || 0,
        ctr: row.ctr || 0,
        avgPosition: row.position || 0,
      }));

      return { data };
    } catch (exc) {
      return { error: exc instanceof Error ? exc.message : String(exc) };
    }
  }

  async getSitemaps(): Promise<{
    error?: string;
    sitemaps?: Array<{
      path: string;
      lastSubmitted?: string;
      type?: string;
      indexed?: string;
    }>;
  }> {
    try {
      const response = await this.request<SitemapListResponse>(
        `/sites/${this.encodeProperty(this.propertyUrl)}/sitemaps`
      );

      const sitemaps = (response.sitemap || []).map((sm: Sitemap) => ({
        path: sm.path || 'unknown',
        lastSubmitted: sm.lastSubmitted || 'Never',
        type: sm.type || 'sitemap',
        indexed: sm.contents?.[0]?.indexed || 'Unknown',
      }));

      return { sitemaps };
    } catch (exc) {
      return { error: exc instanceof Error ? exc.message : String(exc) };
    }
  }

  async getIndexingStatus(): Promise<{
    error?: string;
    status?: {
      indexedPages: string;
      totalPages: string;
      coverage: string;
    };
  }> {
    try {
      const response = await this.request<CoverageResponse>(
        `/sites/${this.encodeProperty(this.propertyUrl)}/inspectionIndex/coverage`
      );

      const indexed = response.coveredPages || '0';
      const total = response.crawlablePages || 'unknown';
      const coverage = total === 'unknown' ? 'Unknown' : `${indexed}/${total}`;

      return {
        status: {
          indexedPages: indexed,
          totalPages: total,
          coverage,
        },
      };
    } catch (exc) {
      return { error: exc instanceof Error ? exc.message : String(exc) };
    }
  }

  async getIndexingErrors(limit: number = 5): Promise<{
    error?: string;
    errors?: Array<{
      type: string;
      count: string;
      example?: string;
      severity?: string;
    }>;
  }> {
    try {
      const response = await this.request<{
        inspectionResult?: {
          crawlIssues?: Array<{
            issueType?: string;
            severity?: string;
            details?: string;
          }>;
        };
      }>(`/sites/${this.encodeProperty(this.propertyUrl)}/inspectionIndex/errors`);

      const crawlIssues = response.inspectionResult?.crawlIssues || [];

      // Aggregate by issue type to get accurate counts
      const issueMap = new Map<string, { count: number; example?: string; severity?: string }>();
      for (const issue of crawlIssues) {
        const type = issue.issueType || 'unknown';
        const existing = issueMap.get(type) || { count: 0, severity: issue.severity || 'unknown' };
        existing.count += 1;
        if (!existing.example && issue.details) {
          existing.example = issue.details;
        }
        issueMap.set(type, existing);
      }

      // Convert to array and limit
      const errors = Array.from(issueMap.entries())
        .slice(0, limit)
        .map(([type, data]) => ({
          type,
          count: String(data.count),
          ...(data.example ? { example: data.example } : {}),
          severity: data.severity || 'unknown',
        }));

      return { errors };
    } catch (exc) {
      return { error: exc instanceof Error ? exc.message : String(exc) };
    }
  }

  async checkUrl(url: string): Promise<{
    error?: string;
    indexed?: boolean;
    state?: string;
    issues?: string[];
  }> {
    try {
      const response = await this.request<IndexingErrorResponse>(
        `/urlInspection/v1/urlInspection:inspect`,
        {
          method: 'POST',
          body: {
            inspectionUrl: url,
            siteUrl: this.propertyUrl,
          },
        }
      );

      const result = response.inspectionResult;
      if (!result) {
        return { error: 'No inspection result' };
      }

      const indexed = result.indexingState === 'INDEXED';
      const state = result.indexingState || 'UNKNOWN';
      const issues: string[] = [];

      if (result.crawlIssues?.length) {
        issues.push(...result.crawlIssues.map((i) => i.issueType || 'unknown'));
      }

      if (result.mobileUsability?.issues?.length) {
        issues.push(...result.mobileUsability.issues.map((i) => i.rule || 'unknown'));
      }

      return { indexed, state, issues };
    } catch (exc) {
      return { error: exc instanceof Error ? exc.message : String(exc) };
    }
  }
}

export async function makeGSCClient(ctx: ToolContext): Promise<{
  error?: string;
  client?: GoogleSearchConsoleClient;
}> {
  try {
    const token = await secretRequired(ctx, 'GSC_ACCESS_TOKEN');
    const propertyUrl = await secretRequired(ctx, 'GSC_PROPERTY_URL');
    return { client: new GoogleSearchConsoleClient(ctx, propertyUrl, token) };
  } catch (exc) {
    return { error: exc instanceof Error ? exc.message : String(exc) };
  }
}
