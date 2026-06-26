// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FileStore, FileHandle, FileMetaData, FileEvent, FileFilter, MimeType } from '@matatbread/matbot-plugin-api';
import { currentPrincipal } from '@matatbread/matbot-plugin-api';
import type { Db, Q } from './db.js';

// Backs matbot's FileStore with the unified virtual filesystem (plugin_fs.fs_nodes + fs_blobs, bytes
// in Postgres bytea — node-agnostic). This is the ONE store: agent fs_* tools, the Files screen, and
// every FileStore writer (rendered decks, background task outputs) all read/write here, so a file an
// agent makes is visible in one place regardless of who wrote it.
//
// The FileStore API is flat (name + optional namespace); the fs is a tree. We map a `namespace` to a
// top-level folder of that name and write the file under it (root when absent). sessionId/messageId/
// allowed (which fs_nodes has no column for) ride in metadata jsonb. The fs plugin owns the schema
// (always loaded here); we only read/write it.

interface FsRow {
  id: string;
  name: string;
  mime: string | null;
  size_bytes: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function rowToMeta(r: FsRow): FileMetaData {
  const m = r.metadata ?? {};
  const ns = typeof m['namespace'] === 'string' ? (m['namespace'] as string) : undefined;
  const sessionId = typeof m['sessionId'] === 'string' ? (m['sessionId'] as string) : undefined;
  const messageId = typeof m['messageId'] === 'string' ? (m['messageId'] as string) : undefined;
  const allowed = m['allowed'] === true;
  return {
    id: r.id,
    version: r.updated_at.toISOString(),
    name: r.name,
    mimeType: (r.mime ?? 'application/octet-stream') as MimeType,
    size: Number(r.size_bytes ?? 0),
    createdAt: r.created_at.toISOString(),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(ns !== undefined ? { namespace: ns } : {}),
    ...(allowed ? { allowed: true } : {}),
  };
}

async function collect(data: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of data) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

const COLS = 'id, name, mime, size_bytes, metadata, created_at, updated_at';

// Find/create the top-level folder for a namespace; returns its id (null when no namespace → root).
async function namespaceFolderId(q: Q, owner: string, namespace: string | null | undefined): Promise<string | null> {
  if (!namespace) return null;
  const ex = await q(
    `select id from plugin_fs.fs_nodes where user_id=$1 and parent_id is null and kind='folder' and lower(name)=lower($2) and status='active' limit 1`,
    [owner, namespace],
  );
  const row = ex.rows[0] as { id: string } | undefined;
  if (row) return row.id;
  const ins = await q(
    `insert into plugin_fs.fs_nodes (user_id, parent_id, kind, name, storage_kind) values ($1, null, 'folder', $2, 'virtual') returning id`,
    [owner, namespace],
  );
  return (ins.rows[0] as { id: string }).id;
}

export class PgFileStore implements FileStore {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  private handle(row: FsRow): FileHandle {
    const db = this.db;
    return {
      ...rowToMeta(row),
      stream(): AsyncIterable<Uint8Array> {
        return (async function* () {
          const r = await db.withPrincipalTx((q) => q('select data from plugin_fs.fs_blobs where node_id=$1', [row.id]));
          const blob = r.rows[0] as { data: Buffer } | undefined;
          if (blob) yield new Uint8Array(blob.data);
        })();
      },
    };
  }

  async put(
    name: string | undefined,
    mimeType: MimeType,
    data: AsyncIterable<Uint8Array>,
    meta?: { sessionId?: string; messageId?: string; namespace?: string; allowed?: boolean },
  ): Promise<FileHandle> {
    const buf = await collect(data);
    return this.db.withPrincipalTx(async (q) => {
      const owner = currentPrincipal().id;
      const parentId = await namespaceFolderId(q, owner, meta?.namespace);
      const fname = name && name.trim() ? name : 'file';
      const metaJson = JSON.stringify({
        ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
        ...(meta?.messageId ? { messageId: meta.messageId } : {}),
        ...(meta?.namespace ? { namespace: meta.namespace } : {}),
        ...(meta?.allowed ? { allowed: true } : {}),
      });

      // Upsert by (parent, name): overwrite an existing file's bytes/meta, else insert a new node.
      const ex = await q(
        `select id from plugin_fs.fs_nodes where user_id=$1 and parent_id ${parentId ? '= $3' : 'is null'} and kind='file' and lower(name)=lower($2) and status='active' limit 1`,
        parentId ? [owner, fname, parentId] : [owner, fname],
      );
      let id = (ex.rows[0] as { id: string } | undefined)?.id ?? null;

      if (id !== null) {
        await q(`update plugin_fs.fs_nodes set mime=$2, size_bytes=$3, metadata=$4::jsonb, storage_kind='local', updated_at=now() where id=$1`, [id, mimeType, buf.length, metaJson]);
        await q(`insert into plugin_fs.fs_blobs (node_id, user_id, data) values ($1,$2,$3) on conflict (node_id) do update set data=excluded.data`, [id, owner, buf]);
      } else {
        const r = await q(
          `insert into plugin_fs.fs_nodes (user_id, parent_id, kind, name, storage_kind, mime, size_bytes, metadata)
           values ($1, $2, 'file', $3, 'local', $4, $5, $6::jsonb) returning id`,
          [owner, parentId, fname, mimeType, buf.length, metaJson],
        );
        id = (r.rows[0] as { id: string }).id;
        await q(`insert into plugin_fs.fs_blobs (node_id, user_id, data) values ($1,$2,$3)`, [id, owner, buf]);
      }

      const fresh = await q(`select ${COLS} from plugin_fs.fs_nodes where id=$1`, [id]);
      return this.handle(fresh.rows[0] as FsRow);
    });
  }

  async get(id: string): Promise<FileHandle | null> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(`select ${COLS} from plugin_fs.fs_nodes where id=$1 and user_id=$2 and kind='file' and status='active'`, [id, currentPrincipal().id]);
      const row = r.rows[0] as FsRow | undefined;
      return row ? this.handle(row) : null;
    });
  }

  async getByName(name: string, namespace?: string): Promise<FileHandle | null> {
    return this.db.withPrincipalTx(async (q) => {
      const owner = currentPrincipal().id;
      const parentId = await namespaceFolderId(q, owner, namespace ?? null);
      const r = await q(
        `select ${COLS} from plugin_fs.fs_nodes where user_id=$1 and parent_id ${parentId ? '= $3' : 'is null'} and kind='file' and lower(name)=lower($2) and status='active' order by updated_at desc limit 1`,
        parentId ? [owner, name, parentId] : [owner, name],
      );
      const row = r.rows[0] as FsRow | undefined;
      return row ? this.handle(row) : null;
    });
  }

  async delete(id: string): Promise<void> {
    await this.db.withPrincipalTx((q) => q(`update plugin_fs.fs_nodes set status='archived', updated_at=now() where id=$1 and user_id=$2 and status='active'`, [id, currentPrincipal().id]));
  }

  async *list(filter?: FileFilter): AsyncIterable<FileHandle> {
    const rows = await this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `select ${COLS} from plugin_fs.fs_nodes
          where user_id=$1 and kind='file' and status='active'
            and ($2::text is null or metadata->>'sessionId'=$2)
            and ($3::text is null or mime=$3)
            and ($4::text is null or coalesce(metadata->>'namespace','')=$4)
            and ($5::timestamptz is null or created_at > $5)
            and ($6::timestamptz is null or created_at < $6)
          order by created_at desc`,
        [currentPrincipal().id, filter?.sessionId ?? null, filter?.mimeType ?? null, filter?.namespace ?? null, filter?.createdAfter ?? null, filter?.createdBefore ?? null],
      );
      return r.rows as FsRow[];
    });
    for (const row of rows) yield this.handle(row);
  }

  async putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle> {
    return this.put(name, mimeType, data, { namespace: '_temp' });
  }

  // No backing watcher yet: honour the contract (yield nothing; resolve when the signal fires).
  async *watch(signal?: AbortSignal): AsyncIterable<FileEvent> {
    if (signal) await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
  }
}
