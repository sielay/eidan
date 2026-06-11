// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FileStore, FileHandle, FileMetaData, FileEvent, FileFilter, MimeType } from '@matatbread/matbot-plugin-api';
import { currentPrincipal } from '@matatbread/matbot-plugin-api';
import type { Db, Q } from './db.js';

// Backs matbot's FileStore with eidan.artifacts (metadata, user-scoped) + eidan.artifact_blobs
// (bytes in Postgres bytea — the zero-dependency default; an S3 backend would key off storage_key).
// All ops are scoped to the ambient principal; watch() is a no-op for now (a LISTEN/NOTIFY watcher
// is a follow-up).

interface ArtifactRow {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: string;
  conversation_id: string | null;
  message_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function rowToMeta(r: ArtifactRow): FileMetaData {
  const ns = typeof r.metadata['namespace'] === 'string' ? (r.metadata['namespace'] as string) : undefined;
  const allowed = r.metadata['allowed'] === true;
  return {
    id: r.id,
    version: r.updated_at.toISOString(),
    name: r.filename,
    mimeType: r.mime_type,
    size: Number(r.size_bytes),
    createdAt: r.created_at.toISOString(),
    ...(r.conversation_id != null ? { sessionId: r.conversation_id } : {}),
    ...(r.message_id != null ? { messageId: r.message_id } : {}),
    ...(ns !== undefined ? { namespace: ns } : {}),
    ...(allowed ? { allowed: true } : {}),
  };
}

async function collect(data: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of data) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

const SELECT_COLS = 'id, filename, mime_type, size_bytes, conversation_id, message_id, metadata, created_at, updated_at';

export class PgFileStore implements FileStore {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  // The bytes-backed handle: stream() reads the blob on demand (within the reader's principal scope).
  private handle(row: ArtifactRow): FileHandle {
    const db = this.db;
    return {
      ...rowToMeta(row),
      stream(): AsyncIterable<Uint8Array> {
        return (async function* () {
          const r = await db.withPrincipalTx((q) => q('select data from eidan.artifact_blobs where artifact_id=$1', [row.id]));
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
      const ns = meta?.namespace ?? null;
      const metaJson = JSON.stringify({ ...(ns != null ? { namespace: ns } : {}), ...(meta?.allowed ? { allowed: true } : {}) });

      let id: string | null = null;
      if (name) {
        const ex = await q(
          `select id from eidan.artifacts where user_id=$1 and filename=$2 and coalesce(metadata->>'namespace','')=coalesce($3,'') and deleted_at is null`,
          [owner, name, ns],
        );
        const row = ex.rows[0] as { id: string } | undefined;
        if (row) id = row.id;
      }

      if (id !== null) {
        await q(
          `update eidan.artifacts set mime_type=$2, size_bytes=$3, conversation_id=$4, message_id=$5, metadata=$6::jsonb, updated_at=now() where id=$1`,
          [id, mimeType, buf.length, meta?.sessionId ?? null, meta?.messageId ?? null, metaJson],
        );
        await q('update eidan.artifact_blobs set data=$2 where artifact_id=$1', [id, buf]);
      } else {
        const r = await q(
          `insert into eidan.artifacts (user_id,conversation_id,message_id,kind,mime_type,filename,size_bytes,storage_key,metadata,created_by)
           values ($1,$2,$3,'file',$4,$5,$6,'',$7::jsonb,'agent') returning id`,
          [owner, meta?.sessionId ?? null, meta?.messageId ?? null, mimeType, name ?? 'file', buf.length, metaJson],
        );
        id = (r.rows[0] as { id: string }).id;
        await q('update eidan.artifacts set storage_key=$1 where id=$1', [id]); // pg backend: storage_key == id
        await q('insert into eidan.artifact_blobs (artifact_id,data) values ($1,$2)', [id, buf]);
      }

      const fresh = await q(`select ${SELECT_COLS} from eidan.artifacts where id=$1`, [id]);
      return this.handle(fresh.rows[0] as ArtifactRow);
    });
  }

  async get(id: string): Promise<FileHandle | null> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(`select ${SELECT_COLS} from eidan.artifacts where id=$1 and user_id=$2 and deleted_at is null`, [id, currentPrincipal().id]);
      const row = r.rows[0] as ArtifactRow | undefined;
      return row ? this.handle(row) : null;
    });
  }

  async getByName(name: string, namespace?: string): Promise<FileHandle | null> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `select ${SELECT_COLS} from eidan.artifacts where user_id=$1 and filename=$2 and coalesce(metadata->>'namespace','')=coalesce($3,'') and deleted_at is null order by updated_at desc limit 1`,
        [currentPrincipal().id, name, namespace ?? null],
      );
      const row = r.rows[0] as ArtifactRow | undefined;
      return row ? this.handle(row) : null;
    });
  }

  async delete(id: string): Promise<void> {
    await this.db.withPrincipalTx((q) => q('update eidan.artifacts set deleted_at=now() where id=$1 and user_id=$2 and deleted_at is null', [id, currentPrincipal().id]));
  }

  async *list(filter?: FileFilter): AsyncIterable<FileHandle> {
    const rows = await this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `select ${SELECT_COLS} from eidan.artifacts
          where user_id=$1 and deleted_at is null
            and ($2::uuid is null or conversation_id=$2)
            and ($3::text is null or mime_type=$3)
            and ($4::text is null or coalesce(metadata->>'namespace','')=$4)
            and ($5::timestamptz is null or created_at > $5)
            and ($6::timestamptz is null or created_at < $6)
          order by created_at desc`,
        [currentPrincipal().id, filter?.sessionId ?? null, filter?.mimeType ?? null, filter?.namespace ?? null, filter?.createdAfter ?? null, filter?.createdBefore ?? null],
      );
      return r.rows as ArtifactRow[];
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
