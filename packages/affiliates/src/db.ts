// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';

export interface AffiliateProgram {
  id: string;
  user_id: string;
  program_name: string;
  provider: string;
  category: 'book' | 'content' | 'tech' | 'other';
  commission_rate: number | null;
  commission_currency: string;
  link_format: 'url' | 'api' | 'pixel';
  signup_url: string | null;
  api_endpoint: string | null;
  api_docs_url: string | null;
  approval_status: 'pending' | 'approved' | 'rejected' | 'active';
  relevance_score: number;
  content_types: string[];
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface AffiliateCredential {
  id: string;
  user_id: string;
  program_id: string;
  credential_type: 'api_key' | 'affiliate_id' | 'tracking_code' | 'custom';
  key_vault_key: string;
  status: 'active' | 'inactive';
  last_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AffiliateLink {
  id: string;
  user_id: string;
  program_id: string;
  content_id: string | null;
  content_type: string;
  generated_link: string;
  link_type: 'direct_url' | 'api_based' | 'tracking_pixel';
  created_at: Date;
  expires_at: Date | null;
}

export class AffiliateDb {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listPrograms(userId: string, category?: string): Promise<AffiliateProgram[]> {
    let query = 'SELECT * FROM eidan.affiliate_programs WHERE user_id = $1 AND deleted_at IS NULL';
    const params: any[] = [userId];
    if (category) {
      query += ' AND category = $2';
      params.push(category);
    }
    query += ' ORDER BY approval_status DESC, relevance_score DESC, created_at DESC';
    const result = await this.pool.query(query, params);
    return result.rows.map(this.mapProgram);
  }

  async getProgramById(programId: string, userId: string): Promise<AffiliateProgram | null> {
    const result = await this.pool.query(
      'SELECT * FROM eidan.affiliate_programs WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [programId, userId],
    );
    return result.rows[0] ? this.mapProgram(result.rows[0]) : null;
  }

  async insertProgram(
    userId: string,
    data: {
      program_name: string;
      provider: string;
      category: string;
      commission_rate?: number;
      link_format: string;
      signup_url?: string;
      api_endpoint?: string;
      api_docs_url?: string;
      relevance_score?: number;
      content_types?: string[];
      metadata?: Record<string, unknown>;
    },
  ): Promise<AffiliateProgram> {
    const result = await this.pool.query(
      `INSERT INTO eidan.affiliate_programs
       (user_id, program_name, provider, category, commission_rate, link_format,
        signup_url, api_endpoint, api_docs_url, relevance_score, content_types, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        userId,
        data.program_name,
        data.provider,
        data.category,
        data.commission_rate ?? null,
        data.link_format,
        data.signup_url ?? null,
        data.api_endpoint ?? null,
        data.api_docs_url ?? null,
        data.relevance_score ?? 0,
        JSON.stringify(data.content_types ?? []),
        JSON.stringify(data.metadata ?? {}),
      ],
    );
    return this.mapProgram(result.rows[0]);
  }

  async updateProgram(
    userId: string,
    programId: string,
    data: Partial<AffiliateProgram>,
  ): Promise<AffiliateProgram | null> {
    const allowedColumns = new Set([
      'program_name',
      'provider',
      'category',
      'commission_rate',
      'commission_currency',
      'link_format',
      'signup_url',
      'api_endpoint',
      'api_docs_url',
      'approval_status',
      'relevance_score',
      'content_types',
      'metadata',
    ]);

    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(data)) {
      if (allowedColumns.has(key) && value !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(key === 'content_types' ? JSON.stringify(value) : value);
        paramCount++;
      }
    }

    if (fields.length === 0) return this.getProgramById(programId, userId);

    fields.push(`updated_at = $${paramCount}`);
    values.push(new Date());
    paramCount++;

    values.push(programId, userId);

    const query =
      `UPDATE eidan.affiliate_programs SET ${fields.join(', ')} ` +
      `WHERE id = $${paramCount} AND user_id = $${paramCount + 1} AND deleted_at IS NULL RETURNING *`;

    const result = await this.pool.query(query, values);
    return result.rows[0] ? this.mapProgram(result.rows[0]) : null;
  }

  async deleteProgram(userId: string, programId: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE eidan.affiliate_programs SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id',
      [programId, userId],
    );
    return result.rows.length > 0;
  }

  async storeCredential(
    userId: string,
    programId: string,
    credentialType: string,
    vaultKey: string,
  ): Promise<AffiliateCredential> {
    const result = await this.pool.query(
      `INSERT INTO eidan.affiliate_credentials
       (user_id, program_id, credential_type, key_vault_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, program_id, credential_type) DO UPDATE SET key_vault_key = $4, updated_at = now()
       RETURNING *`,
      [userId, programId, credentialType, vaultKey],
    );
    return result.rows[0];
  }

  async getCredentials(userId: string, programId: string): Promise<AffiliateCredential[]> {
    const result = await this.pool.query(
      'SELECT * FROM eidan.affiliate_credentials WHERE user_id = $1 AND program_id = $2 ORDER BY created_at',
      [userId, programId],
    );
    return result.rows;
  }

  async recordLink(
    userId: string,
    programId: string,
    contentId: string | null,
    contentType: string,
    generatedLink: string,
    linkType: string,
  ): Promise<AffiliateLink> {
    const result = await this.pool.query(
      `INSERT INTO eidan.affiliate_links
       (user_id, program_id, content_id, content_type, generated_link, link_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, programId, contentId, contentType, generatedLink, linkType],
    );
    return result.rows[0];
  }

  async logDiscovery(
    userId: string,
    programsFound: number,
    newPrograms: number,
    source?: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO eidan.affiliate_discovery_log
       (user_id, programs_found, new_programs, source)
       VALUES ($1, $2, $3, $4)`,
      [userId, programsFound, newPrograms, source ?? null],
    );
  }

  private mapProgram(row: any): AffiliateProgram {
    return {
      ...row,
      content_types: Array.isArray(row.content_types) ? row.content_types : [],
      metadata: typeof row.metadata === 'object' ? row.metadata : {},
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
}
