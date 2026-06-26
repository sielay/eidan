// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, ToolEvent, ToolContext } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type { FsDb, FsNode } from './db.js';
import type { AdapterRegistry } from './adapters.js';
import { resolveSupabaseCfg, supabaseUpload, supabaseDownload } from './supabase.js';
import { resolveS3Cfg, s3Upload, s3Download } from './s3.js';
import { vaultResolve, OFFLOAD_BYTES } from './vault.js';

// The slice of the gdrive plugin's GoogleDrive service this plugin uses (structural — matbot service
// registry idiom; no hard dep on the gdrive package). Lets a Drive file be linked into the fs as a
// reference (storage_kind='gdrive', storage_ref=<drive file id>) and read live through fs_read.
interface DriveMeta { id: string; name: string; mimeType: string }
export interface GoogleDriveSvc {
  stat(ctx: ToolContext, fileId: string): Promise<DriveMeta>;
  readFile(ctx: ToolContext, fileId: string): Promise<{ bytes: Uint8Array; mime: string; file: DriveMeta }>;
}
type GetDrive = () => GoogleDriveSvc | undefined;

// Read a file node's bytes from whatever backend holds them — local (pg bytea), Supabase Storage / S3
// (resolved from the vault on ctx), or a Google Drive reference (via the GoogleDrive service). The one
// place storage-kind dispatch lives, shared by fs_read + the EidanFs service that serves the web.
async function readNodeBytes(db: FsDb, getDrive: GetDrive, ctx: ToolContext, node: FsNode): Promise<{ mime: string; bytes: Uint8Array } | null> {
  let mime = node.mime ?? 'application/octet-stream';
  let bytes: Uint8Array | null = null;
  if (node.storage_kind === 'local') {
    bytes = await db.getBlob(node.id);
  } else if (node.storage_kind === 'gdrive') {
    const drive = getDrive();
    if (!drive || !node.storage_ref) return null;
    const r = await drive.readFile(ctx, node.storage_ref);
    bytes = r.bytes;
    if (r.mime) mime = r.mime;
  } else if (node.storage_kind === 'supabase') {
    const cfg = await resolveSupabaseCfg(vaultResolve(ctx.vault));
    if (!cfg || !node.storage_ref) return null;
    bytes = await supabaseDownload(cfg, node.storage_ref);
  } else if (node.storage_kind === 's3') {
    const cfg = await resolveS3Cfg(vaultResolve(ctx.vault));
    if (!cfg || !node.storage_ref) return null;
    bytes = await s3Download(cfg, node.storage_ref);
  } else {
    return null;
  }
  return bytes ? { mime, bytes } : null;
}

export type FsReader = (ctx: ToolContext, nodeId: string) => Promise<{ name: string; mime: string; bytes: Uint8Array } | null>;

// Serve any owned file node's bytes (used by the engine /api/fs/blob route so the web can read
// offloaded/Drive files without ever holding the vault).
export function makeFsReader(db: FsDb, getDrive: GetDrive): FsReader {
  return async (ctx, nodeId) => {
    const node = await db.getNode(nodeId);
    if (!node || node.kind !== 'file') return null;
    const r = await readNodeBytes(db, getDrive, ctx, node);
    return r ? { name: node.name, mime: r.mime, bytes: r.bytes } : null;
  };
}

// Whether a file's bytes are human-readable text (→ returned/accepted as utf8) vs binary (→ base64).
function isTextMime(mime: string, name: string): boolean {
  if (mime.startsWith('text/')) return true;
  if (/(json|xml|x-ndjson|csv|yaml|x-sh|javascript|sql)/.test(mime)) return true;
  return /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|log|js|ts|tsx|jsx|py|sql|sh|html?|css|toml|ini|env|rs|go|java|rb|c|cpp|h)$/i.test(name);
}

// Best-effort mime from a filename extension (so the agent rarely needs to pass one).
function mimeFromName(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const map: Record<string, string> = {
    md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
    json: 'application/json', xml: 'application/xml', yaml: 'application/x-yaml', yml: 'application/x-yaml',
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/plain', log: 'text/plain', sql: 'text/plain', sh: 'text/x-sh',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

async function* executeList(db: FsDb, input: unknown): AsyncIterable<ToolEvent> {
  const inp = (input ?? {}) as Record<string, unknown>;
  const path = typeof inp['path'] === 'string' ? (inp['path'] as string).trim() : '';
  let parentId = inp['parent_id'] ? String(inp['parent_id']) : null;
  try {
    if (path) {
      const folder = await db.resolvePath(path);
      if (!folder) { yield { type: 'error', message: `no such folder: ${path}` }; return; }
      if (folder.kind !== 'folder') { yield { type: 'error', message: `${path} is a file, not a folder` }; return; }
      parentId = folder.id;
    }
    const nodes = await db.listChildren(parentId);
    const base = path ? path.replace(/\/+$/, '') + '/' : '';
    yield {
      type: 'result',
      value: {
        nodes: nodes.map((n) => ({
          id: n.id,
          name: n.name,
          path: base + n.name,
          kind: n.kind,
          mime: n.mime,
          size_bytes: n.size_bytes,
        })),
      },
    };
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

async function* executeMkdir(db: FsDb, input: unknown): AsyncIterable<ToolEvent> {
  const p = tryCurrentPrincipal();
  if (!p) {
    yield { type: 'error', message: 'not authorized' };
    return;
  }
  const inp = input as Record<string, unknown>;
  const name = String(inp['name'] ?? '').trim();
  const parentId = inp['parent_id'] ? String(inp['parent_id']) : null;
  if (!name) {
    yield { type: 'error', message: 'name is required' };
    return;
  }
  try {
    const node = await db.createFolder(name, parentId);
    yield { type: 'result', value: { ok: true, node: { id: node.id, name: node.name, kind: node.kind } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique|duplicate/i.test(msg)) {
      yield { type: 'error', message: 'folder already exists' };
    } else {
      yield { type: 'error', message: msg };
    }
  }
}

async function* executeWrite(db: FsDb, input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
  const p = tryCurrentPrincipal();
  if (!p) {
    yield { type: 'error', message: 'not authorized' };
    return;
  }
  const inp = input as Record<string, unknown>;
  const path = typeof inp['path'] === 'string' ? (inp['path'] as string).trim() : '';
  const nameIn = String(inp['name'] ?? '').trim();
  const parentIdIn = inp['parent_id'] ? String(inp['parent_id']) : null;
  const content = String(inp['content'] ?? '');
  const encoding = inp['encoding'] === 'base64' ? 'base64' : 'utf8';
  if (!path && !nameIn) {
    yield { type: 'error', message: 'provide a path (e.g. "reports/q1.md") or a name' };
    return;
  }
  try {
    // Path resolves (and creates) the folder chain; otherwise write under parent_id (or root).
    let parentId: string | null;
    let fileName: string;
    if (path) {
      const r = await db.ensureParentFolders(path);
      parentId = r.parentId;
      fileName = r.fileName;
    } else {
      parentId = parentIdIn;
      fileName = nameIn;
    }
    const bytes = encoding === 'base64' ? new Uint8Array(Buffer.from(content, 'base64')) : new TextEncoder().encode(content);
    const explicit = typeof inp['mime'] === 'string' && inp['mime'] ? (inp['mime'] as string) : '';
    let mime = explicit || mimeFromName(fileName);
    if (mime === 'application/octet-stream' && encoding === 'utf8') mime = 'text/plain';

    // Offload large files to an external backend (config resolved from the VAULT) so big bytes don't
    // bloat the DB; small files stay in Postgres bytea. The node keeps only a reference. Supabase is
    // preferred when both are configured.
    if (bytes.length >= OFFLOAD_BYTES) {
      const resolve = vaultResolve(ctx.vault);
      const sup = await resolveSupabaseCfg(resolve);
      const s3 = sup ? null : await resolveS3Cfg(resolve);
      if (sup || s3) {
        const kind = sup ? 'supabase' : 's3';
        const existing = await db.childByName(parentId, fileName);
        const node = existing && existing.kind === 'file' ? existing : await db.createRef(fileName, parentId, mime, kind, 'pending');
        const objectPath = `${p.id}/${node.id}`;
        if (sup) await supabaseUpload(sup, objectPath, bytes, mime);
        else await s3Upload(s3 as NonNullable<typeof s3>, objectPath, bytes, mime);
        await db.setRef(node.id, objectPath, bytes.length, kind);
        yield { type: 'result', value: { ok: true, node: { id: node.id, name: node.name, mime, size_bytes: bytes.length, storage_kind: kind } } };
        return;
      }
    }

    // Create-or-overwrite (upsert) — re-writing a path replaces its contents.
    const node = await db.upsertFile(fileName, parentId, mime, bytes);
    yield { type: 'result', value: { ok: true, node: { id: node.id, name: node.name, mime: node.mime, size_bytes: node.size_bytes } } };
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

async function* executeRead(db: FsDb, input: unknown, ctx: ToolContext, getDrive: GetDrive): AsyncIterable<ToolEvent> {
  const p = tryCurrentPrincipal();
  if (!p) {
    yield { type: 'error', message: 'not authorized' };
    return;
  }
  const inp = input as Record<string, unknown>;
  const path = typeof inp['path'] === 'string' ? (inp['path'] as string).trim() : '';
  const id = String(inp['id'] ?? '').trim();
  if (!path && !id) {
    yield { type: 'error', message: 'provide a path (e.g. "reports/q1.md") or an id' };
    return;
  }
  try {
    const node = path ? await db.resolvePath(path) : await db.getNode(id);
    if (!node) {
      yield { type: 'error', message: 'file not found' };
      return;
    }
    if (node.kind !== 'file') {
      yield { type: 'error', message: 'not a file' };
      return;
    }
    const read = await readNodeBytes(db, getDrive, ctx, node);
    if (!read) {
      yield { type: 'error', message: 'file content not found (or its storage backend isn’t configured)' };
      return;
    }
    const { mime, bytes } = read;
    // Text files come back as utf8; binary (images, pdf, …) as base64 so any byte survives the wire.
    if (isTextMime(mime, node.name)) {
      yield { type: 'result', value: { ok: true, id: node.id, name: node.name, mime, encoding: 'utf8', content: new TextDecoder().decode(bytes) } };
    } else {
      yield { type: 'result', value: { ok: true, id: node.id, name: node.name, mime, encoding: 'base64', content: Buffer.from(bytes).toString('base64') } };
    }
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

async function* executeMove(db: FsDb, input: unknown): AsyncIterable<ToolEvent> {
  const p = tryCurrentPrincipal();
  if (!p) {
    yield { type: 'error', message: 'not authorized' };
    return;
  }
  const inp = input as Record<string, unknown>;
  const id = String(inp['id'] ?? '').trim();
  const parentId = inp['parent_id'] ? String(inp['parent_id']) : null;
  if (!id) {
    yield { type: 'error', message: 'id is required' };
    return;
  }
  try {
    await db.moveNode(id, parentId);
    yield { type: 'result', value: { ok: true } };
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

async function* executeRename(db: FsDb, input: unknown): AsyncIterable<ToolEvent> {
  const p = tryCurrentPrincipal();
  if (!p) {
    yield { type: 'error', message: 'not authorized' };
    return;
  }
  const inp = input as Record<string, unknown>;
  const id = String(inp['id'] ?? '').trim();
  const name = String(inp['name'] ?? '').trim();
  if (!id || !name) {
    yield { type: 'error', message: 'id and name are required' };
    return;
  }
  try {
    await db.renameNode(id, name);
    yield { type: 'result', value: { ok: true } };
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

async function* executeArchive(db: FsDb, input: unknown): AsyncIterable<ToolEvent> {
  const p = tryCurrentPrincipal();
  if (!p) {
    yield { type: 'error', message: 'not authorized' };
    return;
  }
  const inp = input as Record<string, unknown>;
  const id = String(inp['id'] ?? '').trim();
  if (!id) {
    yield { type: 'error', message: 'id is required' };
    return;
  }
  try {
    await db.archiveNode(id);
    yield { type: 'result', value: { ok: true } };
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

// Link a Google Drive file into the fs as a live reference (storage_kind='gdrive'): only the metadata
// + the Drive file id are stored here; fs_read fetches the bytes from Drive on demand.
async function* executeLinkGdrive(db: FsDb, input: unknown, ctx: ToolContext, getDrive: GetDrive): AsyncIterable<ToolEvent> {
  const p = tryCurrentPrincipal();
  if (!p) { yield { type: 'error', message: 'not authorized' }; return; }
  const drive = getDrive();
  if (!drive) { yield { type: 'error', message: 'Google Drive isn’t connected — connect a Google account with the Drive scope first' }; return; }
  const inp = (input ?? {}) as Record<string, unknown>;
  const fileId = String(inp['drive_file_id'] ?? '').trim();
  if (!fileId) { yield { type: 'error', message: 'drive_file_id is required (from gdrive_search / gdrive_list_recent)' }; return; }
  const path = typeof inp['path'] === 'string' ? (inp['path'] as string).trim() : '';
  const nameOverride = typeof inp['name'] === 'string' ? (inp['name'] as string).trim() : '';
  try {
    const meta = await drive.stat(ctx, fileId);
    let parentId: string | null = null;
    let fileName = nameOverride || meta.name || 'drive-file';
    if (path) {
      const r = await db.ensureParentFolders(path);
      parentId = r.parentId;
      fileName = nameOverride || r.fileName;
    }
    const node = await db.createRef(fileName, parentId, meta.mimeType || 'application/octet-stream', 'gdrive', fileId);
    yield { type: 'result', value: { ok: true, node: { id: node.id, name: node.name, mime: node.mime, storage_kind: node.storage_kind } } };
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export function buildFsTools(db: FsDb, getDrive: GetDrive = () => undefined): Tool[] {
  return [
    {
      name: 'fs_list',
      description: 'List files and folders in a directory. Pass `path` (e.g. "reports") or omit for the root. Each entry returns its `path` for use with fs_read/fs_write.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Folder path to list (e.g. "reports/2026"); omit for the root.' },
          parent_id: { type: 'string', description: 'Alternative to `path`: the parent folder ID.' },
        },
      },
      executor: {
        execute: async function* (input: unknown) {
          yield* executeList(db, input);
        },
      },
    },
    {
      name: 'fs_mkdir',
      description: 'Create a new folder',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Folder name' },
          parent_id: { type: 'string', description: 'Parent folder ID (omit for root)' },
        },
        required: ['name'],
      },
      executor: {
        execute: async function* (input: unknown) {
          yield* executeMkdir(db, input);
        },
      },
    },
    {
      name: 'fs_write',
      description: 'Create or overwrite a file. Prefer `path` (e.g. "reports/q1.md") — missing folders are auto-created. Writes UTF-8 text by default; set encoding="base64" to store binary (images, PDFs, …). Re-writing a path replaces its contents.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'File path, e.g. "reports/q1.md" or "logo.png". Parent folders are created as needed. Preferred over name+parent_id.' },
          name: { type: 'string', description: 'Alternative to `path`: the file name (written under parent_id or the root).' },
          parent_id: { type: 'string', description: 'Parent folder ID when using `name`.' },
          content: { type: 'string', description: 'File content. UTF-8 text, unless encoding="base64".' },
          encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'How `content` is encoded. Use "base64" for binary files.' },
          mime: { type: 'string', description: 'MIME type; omit to infer from the file extension.' },
        },
        required: ['content'],
      },
      executor: {
        execute: async function* (input: unknown, ctx: ToolContext) {
          yield* executeWrite(db, input, ctx);
        },
      },
    },
    {
      name: 'fs_read',
      description: 'Read a file by `path` (e.g. "reports/q1.md") or id. Text files return content as utf8; binary files (images, PDFs) return base64 — the response `encoding` field says which.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'File path to read, e.g. "reports/q1.md". Preferred over id.' },
          id: { type: 'string', description: 'Alternative to `path`: the file node ID.' },
        },
      },
      executor: {
        execute: async function* (input: unknown, ctx: ToolContext) {
          yield* executeRead(db, input, ctx, getDrive);
        },
      },
    },
    {
      name: 'fs_link_gdrive',
      description: 'Link a Google Drive file into the filesystem as a live reference (the bytes stay in Drive; only a pointer is stored). Find the drive_file_id with gdrive_search or gdrive_list_recent. Read it later with fs_read like any other file.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          drive_file_id: { type: 'string', description: 'The Google Drive file id (from gdrive_search / gdrive_list_recent).' },
          path: { type: 'string', description: 'Where to place it, e.g. "drive/spec.pdf"; parent folders are created. Omit for the root.' },
          name: { type: 'string', description: 'Override the file name (defaults to the Drive file’s name).' },
        },
        required: ['drive_file_id'],
      },
      executor: {
        execute: async function* (input: unknown, ctx: ToolContext) {
          yield* executeLinkGdrive(db, input, ctx, getDrive);
        },
      },
    },
    {
      name: 'fs_move',
      description: 'Move or reparent a file or folder',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Node ID to move' },
          parent_id: { type: 'string', description: 'New parent folder ID (omit to move to root)' },
        },
        required: ['id'],
      },
      executor: {
        execute: async function* (input: unknown) {
          yield* executeMove(db, input);
        },
      },
    },
    {
      name: 'fs_rename',
      description: 'Rename a file or folder',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Node ID to rename' },
          name: { type: 'string', description: 'New name' },
        },
        required: ['id', 'name'],
      },
      executor: {
        execute: async function* (input: unknown) {
          yield* executeRename(db, input);
        },
      },
    },
    {
      name: 'fs_archive',
      description: 'Delete (archive) a file or folder and all its contents',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Node ID to archive' },
        },
        required: ['id'],
      },
      executor: {
        execute: async function* (input: unknown) {
          yield* executeArchive(db, input);
        },
      },
    },
  ];
}
