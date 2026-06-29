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
    // Flatten linkMap for injection
    const flattenedLinks: Record<string, string> = {};
    for (const [programId, links] of Object.entries(linkMap)) {
      for (const [productId, url] of Object.entries(links)) {
        flattenedLinks[productId] = url;
      }
    }

    const modifiedContent = this.safeInjectLinks(content, flattenedLinks, contentType);
    let injectedCount = 0;

    await this.db.withPrincipalTx(async (q) => {
      for (const [programId, links] of Object.entries(linkMap)) {
        for (const [productId, url] of Object.entries(links)) {
          await q(
            `insert into eidan.affiliate_links
             (user_id, program_id, content_type, content_id, product_id, generated_url, injected_at)
             values ($1, $2, $3, $4, $5, $6, now())`,
            [currentPrincipal().id, programId, contentType, contentId, productId, url],
          );
          injectedCount++;
        }
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
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
    }
    return result;
  }

  private safeInjectLinks(content: string, linkMap: Record<string, string>, contentType: string): string {
    if (contentType.includes('youtube')) {
      return this.injectIntoYouTubeDescription(content, linkMap);
    } else if (contentType.includes('markdown') || contentType.includes('blog')) {
      return this.injectIntoMarkdown(content, linkMap);
    } else if (contentType.includes('tweet') || contentType.includes('social')) {
      return this.injectIntoText(content, linkMap);
    }
    return this.injectIntoText(content, linkMap);
  }

  private injectIntoYouTubeDescription(content: string, linkMap: Record<string, string>): string {
    let lines = content.split('\n');
    const linksToAdd = Object.entries(linkMap).map(([product, url]) => `${product}: ${url}`);
    if (linksToAdd.length > 0) {
      lines = [...lines.filter((l) => l.trim()), '', '--- Affiliate Links ---', ...linksToAdd];
    }
    return lines.join('\n');
  }

  private injectIntoMarkdown(content: string, linkMap: Record<string, string>): string {
    let result = content;
    const linksToAdd: string[] = [];

    for (const [product, url] of Object.entries(linkMap)) {
      const linkMd = `[${product}](${url})`;
      if (!result.includes(linkMd) && !result.includes(url)) {
        linksToAdd.push(linkMd);
      }
    }

    if (linksToAdd.length === 0) return result;

    const resourcesPattern = /##\s*(?:Resources|Related|Links|Recommended)/i;
    const match = result.match(resourcesPattern);

    if (match) {
      const insertPos = match.index! + match[0].length;
      result = result.slice(0, insertPos) + '\n' + linksToAdd.join('\n') + result.slice(insertPos);
    } else {
      result += `\n\n## Resources\n${linksToAdd.join('\n')}`;
    }

    return result;
  }

  private injectIntoText(content: string, linkMap: Record<string, string>): string {
    const MAX_TWITTER_LENGTH = 280;
    const linksToAdd: string[] = [];

    for (const [product, url] of Object.entries(linkMap)) {
      if (!content.includes(url) && !content.includes(product)) {
        linksToAdd.push(url);
      }
    }

    if (linksToAdd.length === 0) return content;

    let result = content;
    for (const url of linksToAdd) {
      const withLink = result + ` ${url}`;
      if (withLink.length <= MAX_TWITTER_LENGTH) {
        result = withLink;
      } else {
        break;
      }
    }

    return result;
  }
}
