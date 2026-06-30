// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import type { AffiliateService } from './affiliate-service.js';

export function listAffiliatePrograms(service: AffiliateService): Tool {
  return {
    name: 'list_affiliate_programs',
    description: 'Discover available affiliate programs, their commission rates, and types. Shows all enabled programs configured for your account.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled_only: { type: 'boolean', description: 'Only return enabled programs (default true).' },
      },
    },
    executor: {
      async *execute(input) {
        const { enabled_only = true } = input as { enabled_only?: boolean };
        const programs = await service.listPrograms(enabled_only);
        yield {
          type: 'result',
          value: {
            count: programs.length,
            programs: programs.map((p) => ({
              id: p.id,
              name: p.name,
              type: p.program_type,
              commission: p.commission_pct ? `${p.commission_pct}%` : 'N/A',
              enabled: p.enabled,
            })),
          },
        };
      },
    },
  };
}

export function generateAffiliateLink(service: AffiliateService): Tool {
  return {
    name: 'generate_affiliate_link',
    description: 'Generate a trackable affiliate link for a product from a specific program. Returns the affiliate URL ready to be injected into content.',
    inputSchema: {
      type: 'object',
      required: ['program_id', 'product_id'],
      additionalProperties: false,
      properties: {
        program_id: { type: 'string', description: 'The UUID of the affiliate program (get from list_affiliate_programs).' },
        product_id: { type: 'string', description: 'The product identifier (ASIN for Amazon, ISBN for KDP, course ID, etc.).' },
        context: { type: 'object', description: 'Additional template variables (affiliate_id, tag, etc.).' },
      },
    },
    executor: {
      async *execute(input) {
        const { program_id, product_id, context } = input as {
          program_id: string;
          product_id: string;
          context?: Record<string, string>;
        };
        const url = await service.generateLink(program_id, product_id, context);
        yield { type: 'result', value: { affiliate_url: url, product_id, program_id } };
      },
    },
  };
}

export function injectAffiliateLinks(service: AffiliateService): Tool {
  return {
    name: 'inject_affiliate_links',
    description: 'Safely inject affiliate links into content (YouTube description, blog post, tweet, etc.) without breaking formatting. Returns modified content and tracking record.',
    inputSchema: {
      type: 'object',
      required: ['content_type', 'content_id', 'content', 'links'],
      additionalProperties: false,
      properties: {
        content_type: {
          type: 'string',
          description: "Type of content: 'youtube_description', 'blog_markdown', 'tweet', 'landing_page', etc.",
        },
        content_id: { type: 'string', description: 'Identifier of the content (URL slug, video ID, tweet ID, etc.).' },
        content: { type: 'string', description: 'The actual content to inject links into.' },
        links: {
          type: 'object',
          description: 'Map of program_id -> { product_id -> affiliate_url }. Generate URLs first with generate_affiliate_link.',
        },
      },
    },
    executor: {
      async *execute(input) {
        const { content_type, content_id, content, links } = input as {
          content_type: string;
          content_id: string;
          content: string;
          links: Record<string, Record<string, string>>;
        };
        const result = await service.injectLinksIntoContent(content_type, content_id, content, links);
        yield { type: 'result', value: result };
      },
    },
  };
}

export function queryAffiliateLinks(service: AffiliateService): Tool {
  return {
    name: 'query_affiliate_links',
    description: 'Find all affiliate links in specific content or across all content. Shows where links are placed and performance data.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content_type: {
          type: 'string',
          description: "Filter by content type: 'youtube_description', 'blog_markdown', 'tweet', etc. (optional).",
        },
        content_id: { type: 'string', description: 'Filter by specific content ID (optional).' },
      },
    },
    executor: {
      async *execute(input) {
        const { content_type, content_id } = input as { content_type?: string; content_id?: string };
        const links = await service.queryLinksInContent(content_type, content_id);
        yield {
          type: 'result',
          value: {
            count: links.length,
            links: links.map((l) => ({
              id: l.id,
              content_type: l.content_type,
              content_id: l.content_id,
              product_id: l.product_id,
              url: l.generated_url,
              injected_at: l.injected_at,
            })),
          },
        };
      },
    },
  };
}

export function getAffiliatePerformance(service: AffiliateService): Tool {
  return {
    name: 'get_affiliate_performance',
    description: 'Get performance report on affiliate links: how many links placed per program, estimated commission value.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        program_id: {
          type: 'string',
          description: 'Filter by specific program (optional). If empty, shows all programs.',
        },
      },
    },
    executor: {
      async *execute(input) {
        const { program_id } = input as { program_id?: string };
        const report = await service.getPerformanceReport(program_id);
        const totalLinks = report.reduce((sum, r) => sum + r.total_links, 0);
        const weightedCommissionSum = report.reduce((sum, r) => sum + r.commission_est * r.total_links, 0);
        yield {
          type: 'result',
          value: {
            summary: report.map((r) => ({
              program: r.program,
              links_placed: r.total_links,
              top_product: r.product_id,
              commission_est: r.commission_est,
            })),
            avg_commission_pct: totalLinks > 0 ? weightedCommissionSum / totalLinks : 0,
          },
        };
      },
    },
  };
}
