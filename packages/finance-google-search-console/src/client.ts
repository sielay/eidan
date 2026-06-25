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
  CrawlIssue,
  MobileUsabilityIssue,
  AmpIssue,
} from './types.js';

// Using webmasters/v3 — the current Google Search Console API endpoint.
// While task description mentions searchconsole.googleapis.com/v1, webmasters/v3
// is the authoritative endpoint for GSC indexing, sitemaps, and performance data.
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
    try {
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
        let errorMsg: string;
        const contentType = res.headers.get('content-type') || '';
        try {
          if (contentType.includes('application/json')) {
            const json = await res.json();
            errorMsg = json.error?.message || 'API returned an error';
          } else {
            errorMsg = await res.text();
          }
        } catch {
          errorMsg = 'Failed to parse error response';
        }
        throw new Error(`GSC API error (${res.status}): ${errorMsg}`);
      }

      return (await res.json()) as T;
    } catch (exc) {
      if (exc instanceof Error) {
        throw exc;
      }
      throw new Error('Unexpected error calling GSC API');
    }
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
        query: row.keys && row.keys.length > 0 ? row.keys[0] : 'unknown',
        page: row.keys && row.keys.length > 1 ? row.keys[1] : 'unknown',
        clicks: typeof row.clicks === 'number' ? row.clicks : 0,
        impressions: typeof row.impressions === 'number' ? row.impressions : 0,
        ctr: typeof row.ctr === 'number' ? row.ctr : 0,
        avgPosition: typeof row.position === 'number' ? row.position : 0,
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
        indexed: sm.contents && sm.contents.length > 0 && sm.contents[0]?.indexed ? sm.contents[0].indexed : 'Unknown',
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

      const indexed = String(response.coveredPages ?? '0');
      const total = String(response.crawlablePages ?? 'unknown');
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
      const response = await this.request<IndexingErrorResponse>(
        `/sites/${this.encodeProperty(this.propertyUrl)}/inspectionIndex/errors`
      );

      const crawlIssues: CrawlIssue[] = response.inspectionResult?.crawlIssues || [];
      const mobileUsabilityIssues: MobileUsabilityIssue[] = response.inspectionResult?.mobileUsability?.issues || [];
      const ampIssues: AmpIssue[] = response.inspectionResult?.amp?.issues || [];

      // Aggregate by issue type to get accurate counts
      const issueMap = new Map<string, { count: number; example?: string; severity?: string }>();

      // Process crawl issues
      for (const issue of crawlIssues) {
        const type = issue.issueType || 'unknown';
        const existing = issueMap.get(type) || { count: 0, severity: issue.severity || 'unknown' };
        existing.count += 1;
        if (!existing.example && issue.details && typeof issue.details === 'string') {
          existing.example = issue.details;
        }
        issueMap.set(type, existing);
      }

      // Process mobile usability issues
      for (const issue of mobileUsabilityIssues) {
        const type = `mobile_usability:${issue.rule || 'unknown'}`;
        const existing = issueMap.get(type) || { count: 0, severity: issue.severity || 'warning' };
        existing.count += 1;
        if (!existing.example && issue.message) {
          existing.example = issue.message;
        }
        issueMap.set(type, existing);
      }

      // Process AMP issues
      for (const issue of ampIssues) {
        const type = `amp:${issue.issue || 'unknown'}`;
        const existing = issueMap.get(type) || { count: 0, severity: issue.severity || 'warning' };
        existing.count += 1;
        if (!existing.example && issue.message) {
          existing.example = issue.message;
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
