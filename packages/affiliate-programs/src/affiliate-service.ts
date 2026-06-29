// SPDX-License-Identifier: AGPL-3.0-or-later
import { Db } from './db.js';
import { currentPrincipal } from '@matatbread/matbot-plugin-api';

export interface AffiliateProgram {
  id: string;
  name: string;
  description?: string;
  program_type: string;
  api_endpoint?: string;
  link_template: string;
  commission_pct?: number;
  enabled: boolean;
}

export interface AffiliateLink {
  id: string;
  program_id: string;
  content_type: string;
  content_id: string;
  product_id: string;
  generated_url: string;
  position_context?: string;
  injected_at?: string;
  performance_data: Record<string, unknown>;
}

export interface LinkInjectionResult {
  success: boolean;
  modified_content: string;
  links_injected: number;
  error?: string;
}

export class AffiliateService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async listPrograms(enabled_only = true): Promise<AffiliateProgram[]> {
    return this.db.withPrincipalTx(async (q) => {
      const whereClause = enabled_only ? 'where enabled = true and deleted_at is null' : 'where deleted_at is null';
      const r = await q(
        `select id, name, description, program_type, api_endpoint, link_template, commission_pct, enabled
         from eidan.affiliate_programs
         ${whereClause}
         order by name`,
      );
      return r.rows as AffiliateProgram[];
    });
  }

  async createProgram(input: {
    name: string;
    description?: string;
    program_type: string;
    api_endpoint?: string;
    link_template: string;
    commission_pct?: number;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `insert into eidan.affiliate_programs
         (user_id, name, description, program_type, api_endpoint, link_template, commission_pct, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id`,
        [
          currentPrincipal().id,
          input.name,
          input.description ?? null,
          input.program_type,
          input.api_endpoint ?? null,
          input.link_template,
          input.commission_pct ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      return (r.rows[0] as { id: string }).id;
    });
  }

  async generateLink(programId: string, productId: string, context?: Record<string, string>): Promise<string> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `select link_template from eidan.affiliate_programs
         where id = $1 and user_id = $2 and deleted_at is null`,
        [programId, currentPrincipal().id],
      );
      if (r.rows.length === 0) throw new Error(`Program ${programId} not found`);
      const template = (r.rows[0] as { link_template: string }).link_template;
      return this.interpolateTemplate(template, { product_id: productId, ...context });
    });
  }

  async injectLinksIntoContent(
    contentType: string,
    contentId: string,
    content: string,
    linkMap: Record<string, Record<string, string>>, // programId -> { productId -> URL }
  ): Promise<LinkInjectionResult> {
    // Build injection list with composite keys to avoid collisions across programs
    const linksList: Array<{ productId: string; url: string; programId: string }> = [];
    for (const [programId, links] of Object.entries(linkMap)) {
      for (const [productId, url] of Object.entries(links)) {
        linksList.push({ productId, url, programId });
      }
    }

    const modifiedContent = this.safeInjectLinks(content, linksList, contentType);
    let injectedCount = 0;

    await this.db.withPrincipalTx(async (q) => {
      for (const { programId, productId, url } of linksList) {
        await q(
          `insert into eidan.affiliate_links
           (user_id, program_id, content_type, content_id, product_id, generated_url, injected_at)
           values ($1, $2, $3, $4, $5, $6, now())`,
          [currentPrincipal().id, programId, contentType, contentId, productId, url],
        );
        injectedCount++;
      }
    });

    return {
      success: true,
      modified_content: modifiedContent,
      links_injected: injectedCount,
    };
  }

  async queryLinksInContent(contentType?: string, contentId?: string): Promise<AffiliateLink[]> {
    return this.db.withPrincipalTx(async (q) => {
      let whereClause = 'where user_id = $1 and deleted_at is null';
      const params: unknown[] = [currentPrincipal().id];
      let paramIdx = 2;

      if (contentType) {
        whereClause += ` and content_type = $${paramIdx}`;
        params.push(contentType);
        paramIdx++;
      }
      if (contentId) {
        whereClause += ` and content_id = $${paramIdx}`;
        params.push(contentId);
      }

      const r = await q(
        `select id, program_id, content_type, content_id, product_id, generated_url, position_context, injected_at, performance_data
         from eidan.affiliate_links
         ${whereClause}
         order by injected_at desc`,
        params,
      );
      return r.rows as AffiliateLink[];
    });
  }

  async getPerformanceReport(
    programId?: string,
  ): Promise<Array<{ program: string; product_id: string; total_links: number; commission_est: number }>> {
    return this.db.withPrincipalTx(async (q) => {
      let whereClause = 'where al.user_id = $1 and al.deleted_at is null';
      const params: unknown[] = [currentPrincipal().id];

      if (programId) {
        whereClause += ` and al.program_id = $2`;
        params.push(programId);
      }

      const r = await q(
        `select ap.name as program, al.product_id,
                count(al.id) as total_links,
                coalesce(ap.commission_pct * count(al.id), 0) as commission_est
         from eidan.affiliate_links al
         join eidan.affiliate_programs ap on al.program_id = ap.id
         ${whereClause}
         group by ap.id, ap.name, al.product_id, ap.commission_pct
         order by ap.name, al.product_id`,
        params,
      );
      return (
        r.rows as Array<{ program: string; product_id: string; total_links: number; commission_est: number }>
      ).map((row) => ({
        program: row.program,
        product_id: row.product_id,
        total_links: Number(row.total_links),
        commission_est: Number(row.commission_est),
      }));
    });
  }

  private interpolateTemplate(template: string, vars: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      // Escape regex metacharacters in the key to prevent ReDoS
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`\\{${escapedKey}\\}`, 'g'), value || '');
    }
    return result;
  }

  private safeInjectLinks(
    content: string,
    linksList: Array<{ productId: string; url: string; programId: string }>,
    contentType: string,
  ): string {
    if (contentType.includes('youtube')) {
      return this.injectIntoYouTubeDescription(content, linksList);
    } else if (contentType.includes('markdown') || contentType.includes('blog')) {
      return this.injectIntoMarkdown(content, linksList);
    } else if (contentType.includes('tweet') || contentType.includes('social')) {
      return this.injectIntoText(content, linksList);
    }
    return this.injectIntoText(content, linksList);
  }

  private injectIntoYouTubeDescription(
    content: string,
    linksList: Array<{ productId: string; url: string }>,
  ): string {
    let lines = content.split('\n');
    const linksToAdd = linksList
      .filter((link) => !content.includes(link.url))
      .map((link) => `${link.productId}: ${link.url}`);
    if (linksToAdd.length > 0) {
      lines = [...lines.filter((l) => l.trim()), '', '--- Affiliate Links ---', ...linksToAdd];
    }
    return lines.join('\n');
  }

  private injectIntoMarkdown(
    content: string,
    linksList: Array<{ productId: string; url: string }>,
  ): string {
    let result = content;
    const linksToAdd: string[] = [];
    const urlsAlreadyPresent = new Set<string>();

    // Extract URLs already in the content (both in markdown links and plain URLs)
    const urlPattern = /\[([^\]]+)\]\(([^)]+)\)|https?:\/\/[^\s)]+/g;
    let match;
    while ((match = urlPattern.exec(content)) !== null) {
      if (match[2]) {
        urlsAlreadyPresent.add(match[2]);
      } else if (match[0]) {
        urlsAlreadyPresent.add(match[0]);
      }
    }

    for (const { productId, url } of linksList) {
      if (!urlsAlreadyPresent.has(url)) {
        linksToAdd.push(`[${productId}](${url})`);
        urlsAlreadyPresent.add(url);
      }
    }

    if (linksToAdd.length === 0) return result;

    const sectionPattern = /##\s*(?:Resources|Related|Links|Recommended|See Also|Further Reading|Learn More|References|Affiliate)/i;
    const sectionMatch = result.match(sectionPattern);

    if (sectionMatch) {
      const insertPos = sectionMatch.index! + sectionMatch[0].length;
      result = result.slice(0, insertPos) + '\n' + linksToAdd.join('\n') + result.slice(insertPos);
    } else {
      result += `\n\n## Resources\n${linksToAdd.join('\n')}`;
    }

    return result;
  }

  private injectIntoText(
    content: string,
    linksList: Array<{ productId: string; url: string }>,
  ): string {
    const MAX_TWITTER_LENGTH = 280;
    const linksToAdd: string[] = [];
    const urlPattern = /https?:\/\/[^\s)]+/g;
    const existingUrls = new Set((content.match(urlPattern) || []).map((u) => u.trim()));

    for (const { url } of linksList) {
      if (!existingUrls.has(url)) {
        linksToAdd.push(url);
      }
    }

    if (linksToAdd.length === 0) return content;

    let result = content;
    // For twitter/short content, try to add links with priority to fitting one main link
    for (let i = 0; i < linksToAdd.length; i++) {
      const url = linksToAdd[i];
      // Try appending with space separator
      const withLink = result + ` ${url}`;
      if (withLink.length <= MAX_TWITTER_LENGTH) {
        result = withLink;
      } else if (i === 0) {
        // If first link doesn't fit and we're on Twitter, prioritize it by trimming content
        // This ensures at least the primary link is included
        const availableSpace = MAX_TWITTER_LENGTH - url.length - 1;
        if (availableSpace > 20) {
          result = content.slice(0, availableSpace).trim() + ` ${url}`;
        }
        break;
      } else {
        // Stop adding more links if we run out of space
        break;
      }
    }

    return result;
  }
}
