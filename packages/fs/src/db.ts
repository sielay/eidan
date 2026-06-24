// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

export interface FsNode {
  id: string;
  user_id: string;
  parent_id: string | null;
  kind: 'folder' | 'file';
  name: string;
  storage_kind: 'local' | 's3' | 'supabase' | 'gdrive' | 'virtual';
  storage_ref: string | null;
  mime: string | null;
  size_bytes: number | null;
  metadata: Record<string, unknown>;
  status: 'active' | 'archived';
  created_at: Date;
  updated_at: Date;
}

type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

export class FsDb {
  private readonly pool: pg.Pool;
  readonly schema = 'plugin_fs';

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async ensureSchema(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query(`create schema if not exists ${this.schema}`);

      await c.query(
        `create table if not exists ${this.schema}.fs_nodes (
           id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           user_id              uuid NOT NULL,
           parent_id            uuid REFERENCES ${this.schema}.fs_nodes(id) ON DELETE CASCADE,
           kind                 text NOT NULL CHECK (kind IN ('folder', 'file')),
           name                 text NOT NULL,
           storage_kind         text NOT NULL DEFAULT 'local' CHECK (storage_kind IN ('local', 's3', 'supabase', 'gdrive', 'virtual')),
           storage_ref          text,
           mime                 text,
           size_bytes           bigint,
           metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
           status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
           created_at           timestamptz NOT NULL DEFAULT now(),
           updated_at           timestamptz NOT NULL DEFAULT now()
         )`,
      );

      await c.query(
        `create index if not exists idx_${this.schema}_nodes_user_parent on ${this.schema}.fs_nodes (user_id, parent_id)`,
      );

      await c.query(
        `create unique index if not exists uq_${this.schema}_nodes_user_parent_name on ${this.schema}.fs_nodes (user_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) where status = 'active'`,
      );

      await c.query(
        `create table if not exists ${this.schema}.fs_blobs (
           node_id              uuid PRIMARY KEY REFERENCES ${this.schema}.fs_nodes(id) ON DELETE CASCADE,
           user_id              uuid NOT NULL,
           data                 bytea NOT NULL,
           created_at           timestamptz NOT NULL DEFAULT now()
         )`,
      );

      await c.query(
        `create index if not exists idx_${this.schema}_blobs_user on ${this.schema}.fs_blobs (user_id)`,
      );
    } finally {
      c.release();
    }
  }

  async withPrincipalTx<R>(fn: (q: Q) => Promise<R>): Promise<R> {
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

  async listChildren(parentId: string | null): Promise<FsNode[]> {
    const p = tryCurrentPrincipal();
    if (!p) return [];
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, user_id, parent_id, kind, name, storage_kind, storage_ref, mime, size_bytes, metadata, status, created_at, updated_at
           from ${this.schema}.fs_nodes
          where user_id = $1 and parent_id ${parentId ? '= $2' : 'is null'} and status = 'active'
          order by kind desc, name`,
        parentId ? [p.id, parentId] : [p.id],
      );
      return (r.rows as Record<string, unknown>[]).map((row) => this.rowToNode(row));
    });
  }

  async getNode(id: string): Promise<FsNode | null> {
    const p = tryCurrentPrincipal();
    if (!p) return null;
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, user_id, parent_id, kind, name, storage_kind, storage_ref, mime, size_bytes, metadata, status, created_at, updated_at
           from ${this.schema}.fs_nodes
          where id = $1 and user_id = $2`,
        [id, p.id],
      );
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row ? this.rowToNode(row) : null;
    });
  }

  async createFolder(name: string, parentId: string | null): Promise<FsNode> {
    const p = tryCurrentPrincipal();
    if (!p) throw new Error('no principal');
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `insert into ${this.schema}.fs_nodes
            (user_id, parent_id, kind, name, storage_kind)
         values ($1, $2, 'folder', $3, 'virtual')
         returning id, user_id, parent_id, kind, name, storage_kind, storage_ref, mime, size_bytes, metadata, status, created_at, updated_at`,
        [p.id, parentId, name],
      );
      return this.rowToNode(r.rows[0] as Record<string, unknown>);
    });
  }

  async createFile(
    name: string,
    parentId: string | null,
    mime: string,
    sizeBytes: number,
  ): Promise<FsNode> {
    const p = tryCurrentPrincipal();
    if (!p) throw new Error('no principal');
    return this.withPrincipalTx(async (q) => {
      const nodeId = await q(
        `insert into ${this.schema}.fs_nodes
            (user_id, parent_id, kind, name, storage_kind, mime, size_bytes)
         values ($1, $2, 'file', $3, 'local', $4, $5)
         returning id`,
        [p.id, parentId, name, mime, sizeBytes],
      );
      const id = (nodeId.rows[0] as Record<string, unknown>)['id'];
      const r = await q(
        `select id, user_id, parent_id, kind, name, storage_kind, storage_ref, mime, size_bytes, metadata, status, created_at, updated_at
           from ${this.schema}.fs_nodes where id = $1`,
        [id],
      );
      return this.rowToNode(r.rows[0] as Record<string, unknown>);
    });
  }

  async storeBlob(nodeId: string, data: Uint8Array): Promise<void> {
    const p = tryCurrentPrincipal();
    if (!p) throw new Error('no principal');
    await this.withPrincipalTx(async (q) => {
      await q(
        `insert into ${this.schema}.fs_blobs (node_id, user_id, data)
         values ($1, $2, $3)
         on conflict (node_id) do update set data = excluded.data`,
        [nodeId, p.id, data],
      );
    });
  }

  async getBlob(nodeId: string): Promise<Uint8Array | null> {
    const p = tryCurrentPrincipal();
    if (!p) return null;
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select data from ${this.schema}.fs_blobs
          where node_id = $1 and user_id = $2`,
        [nodeId, p.id],
      );
      const row = r.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return new Uint8Array(row['data'] as Buffer);
    });
  }

  async renameNode(id: string, newName: string): Promise<void> {
    const p = tryCurrentPrincipal();
    if (!p) return;
    await this.withPrincipalTx(async (q) => {
      await q(
        `update ${this.schema}.fs_nodes
          set name = $1, updated_at = now()
         where id = $2 and user_id = $3`,
        [newName, id, p.id],
      );
    });
  }

  async moveNode(id: string, newParentId: string | null): Promise<void> {
    const p = tryCurrentPrincipal();
    if (!p) return;
    await this.withPrincipalTx(async (q) => {
      await q(
        `update ${this.schema}.fs_nodes
          set parent_id = $1, updated_at = now()
         where id = $2 and user_id = $3`,
        [newParentId, id, p.id],
      );
    });
  }

  async archiveNode(id: string): Promise<void> {
    const p = tryCurrentPrincipal();
    if (!p) return;
    await this.withPrincipalTx(async (q) => {
      await q(
        `with recursive archive_tree as (
           select id from ${this.schema}.fs_nodes where id = $1 and user_id = $2
           union all
           select n.id from ${this.schema}.fs_nodes n
           inner join archive_tree a on n.parent_id = a.id
         )
         update ${this.schema}.fs_nodes
            set status = 'archived', updated_at = now()
          where id in (select id from archive_tree)`,
        [id, p.id],
      );
    });
  }

  private rowToNode(row: Record<string, unknown>): FsNode {
    return {
      id: String(row['id']),
      user_id: String(row['user_id']),
      parent_id: (row['parent_id'] as string | null) ?? null,
      kind: row['kind'] as 'folder' | 'file',
      name: String(row['name']),
      storage_kind: row['storage_kind'] as 'local' | 's3' | 'supabase' | 'gdrive' | 'virtual',
      storage_ref: (row['storage_ref'] as string | null) ?? null,
      mime: (row['mime'] as string | null) ?? null,
      size_bytes: row['size_bytes'] ? Number(row['size_bytes']) : null,
      metadata: (row['metadata'] as Record<string, unknown>) ?? {},
      status: row['status'] as 'active' | 'archived',
      created_at: row['created_at'] as Date,
      updated_at: row['updated_at'] as Date,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
