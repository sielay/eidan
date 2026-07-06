// SPDX-License-Identifier: AGPL-3.0-or-later
// Content data layer. Owns plugin_content — starting with brand_kits: the per-scope voice/style that
// grounds every generative step so content stays on-brand and the model doesn't drift or invent a
// voice. Owner-scoped (ambient-principal RLS stamp), idempotent ensureSchema — same shape as
// packages/journal. `scope` is 'default' or a venture id/slug (loose reference, no FK to ventures).
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

import { scopeChain, mergeBrandLayers, parseScope, type BrandFields } from './scope.js';

type Q = (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The resolved brand for a scope: the exact-scope `layer` you edit, the merged `effective` brand that
// generation actually uses, and the `chain` of scopes that fed the merge (most-general first).
export interface ResolvedBrand {
  scope: string;
  layer: BrandKit | null;
  effective: BrandFields;
  chain: string[];
}

export interface BrandKit {
  scope: string;
  voice: string | null;
  styleguide: string | null;
  language: string | null;
  reference_images: string[];
  updated_at: Date;
}

export interface BrandPatch {
  voice?: string | null;
  styleguide?: string | null;
  language?: string | null;
  reference_images?: string[];
}

export class ContentDb {
  private pool: pg.Pool;
  readonly schema = 'plugin_content';

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url });
  }

  async ensureSchema(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query(`create schema if not exists ${this.schema}`);
      await c.query(
        `create table if not exists ${this.schema}.brand_kits (
           id uuid primary key default gen_random_uuid(),
           user_id uuid not null,
           scope text not null default 'default',
           voice text,
           styleguide text,
           language text,
           reference_images jsonb not null default '[]'::jsonb,
           metadata jsonb not null default '{}'::jsonb,
           created_at timestamptz not null default now(),
           updated_at timestamptz not null default now()
         )`,
      );
      await c.query(`create unique index if not exists uq_${this.schema}_brand on ${this.schema}.brand_kits (user_id, scope)`);
    } finally {
      c.release();
    }
  }

  private async tx<R>(fn: (q: Q) => Promise<R>): Promise<R> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const p = tryCurrentPrincipal();
      if (p) await client.query("select set_config('eidan.current_user_id', $1, true)", [p.id]);
      const q: Q = (text, params) => client.query(text, params as unknown[]);
      const r = await fn(q);
      await client.query('commit');
      return r;
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  private uid(): string | null {
    return tryCurrentPrincipal()?.id ?? null;
  }

  private row(r: unknown): BrandKit {
    const x = r as { scope: string; voice: string | null; styleguide: string | null; language: string | null; reference_images: unknown; updated_at: Date };
    return {
      scope: x.scope,
      voice: x.voice,
      styleguide: x.styleguide,
      language: x.language,
      reference_images: Array.isArray(x.reference_images) ? x.reference_images.map(String) : [],
      updated_at: x.updated_at,
    };
  }

  async getBrand(scope: string): Promise<BrandKit | null> {
    const uid = this.uid();
    if (!uid) return null;
    return this.tx(async (q) => {
      const r = await q(`select scope, voice, styleguide, language, reference_images, updated_at from ${this.schema}.brand_kits where user_id = $1 and scope = $2`, [uid, scope]);
      return r.rows[0] ? this.row(r.rows[0]) : null;
    });
  }

  async listScopes(): Promise<string[]> {
    const uid = this.uid();
    if (!uid) return [];
    return this.tx(async (q) => {
      const r = await q(`select scope from ${this.schema}.brand_kits where user_id = $1 order by scope`, [uid]);
      return (r.rows as Array<{ scope: string }>).map((x) => x.scope);
    });
  }

  // Fetch several scopes at once (for a cascade). Returns only the scopes that exist, in a map.
  async getBrands(scopes: string[]): Promise<Map<string, BrandKit>> {
    const uid = this.uid();
    const out = new Map<string, BrandKit>();
    if (!uid || !scopes.length) return out;
    return this.tx(async (q) => {
      const r = await q(
        `select scope, voice, styleguide, language, reference_images, updated_at
           from ${this.schema}.brand_kits where user_id = $1 and scope = any($2)`,
        [uid, scopes],
      );
      for (const row of r.rows) { const kit = this.row(row); out.set(kit.scope, kit); }
      return out;
    });
  }

  // Walk the venture parent chain (root → … → the target venture), owner-scoped. Cross-schema read of
  // plugin_ventures — read-only, guarded: a non-uuid scope (slug) or a missing ventures plugin yields
  // just [ventureId], so the cascade degrades to default → this-venture rather than erroring.
  async ventureAncestry(ventureId: string): Promise<string[]> {
    const uid = this.uid();
    if (!uid || !ventureId || !UUID_RE.test(ventureId)) return ventureId ? [ventureId] : [];
    try {
      return await this.tx(async (q) => {
        const r = await q(
          `with recursive up as (
             select id, parent_id, 0 as depth from plugin_ventures.ventures
               where id = $2 and user_id = $1 and status = 'active'
             union all
             select v.id, v.parent_id, up.depth + 1 from plugin_ventures.ventures v
               join up on v.id = up.parent_id where v.user_id = $1 and v.status = 'active'
           )
           select id from up order by depth desc`,
          [uid, ventureId],
        );
        const ids = (r.rows as Array<{ id: string }>).map((x) => x.id);
        return ids.length ? ids : [ventureId];
      });
    } catch {
      return [ventureId]; // plugin_ventures absent (undefined_table) or unreadable — degrade gracefully
    }
  }

  // Resolve the effective brand for a scope: layer (exact) + effective (merged cascade) + the chain.
  async resolveBrand(scope: string): Promise<ResolvedBrand> {
    const parts = parseScope(scope);
    const ancestry = parts.kind === 'default' ? [] : await this.ventureAncestry(parts.ventureId ?? '');
    const chain = scopeChain(scope, ancestry);
    const kits = await this.getBrands(chain);
    const layers = chain.map((s) => kits.get(s)).filter((k): k is BrandKit => !!k);
    const effective = mergeBrandLayers(layers);
    return { scope, layer: kits.get(scope) ?? null, effective, chain };
  }

  // Read-modify-write so a partial patch only touches the fields it names.
  async setBrand(scope: string, patch: BrandPatch): Promise<BrandKit | null> {
    const uid = this.uid();
    if (!uid) return null;
    return this.tx(async (q) => {
      const cur = await q(`select scope, voice, styleguide, language, reference_images, updated_at from ${this.schema}.brand_kits where user_id = $1 and scope = $2`, [uid, scope]);
      const existing = cur.rows[0] ? this.row(cur.rows[0]) : null;
      const merged: BrandKit = {
        scope,
        voice: patch.voice !== undefined ? patch.voice : existing?.voice ?? null,
        styleguide: patch.styleguide !== undefined ? patch.styleguide : existing?.styleguide ?? null,
        language: patch.language !== undefined ? patch.language : existing?.language ?? null,
        reference_images: patch.reference_images !== undefined ? patch.reference_images : existing?.reference_images ?? [],
        updated_at: new Date(),
      };
      const r = await q(
        `insert into ${this.schema}.brand_kits (user_id, scope, voice, styleguide, language, reference_images, updated_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, now())
         on conflict (user_id, scope) do update set
           voice = excluded.voice, styleguide = excluded.styleguide, language = excluded.language,
           reference_images = excluded.reference_images, updated_at = now()
         returning scope, voice, styleguide, language, reference_images, updated_at`,
        [uid, scope, merged.voice, merged.styleguide, merged.language, JSON.stringify(merged.reference_images)],
      );
      return r.rows[0] ? this.row(r.rows[0]) : null;
    });
  }
}
