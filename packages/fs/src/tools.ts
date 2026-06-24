// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, ToolEvent } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type { FsDb } from './db.js';
import type { AdapterRegistry } from './adapters.js';

async function* executeList(db: FsDb, input: unknown): AsyncIterable<ToolEvent> {
  const parentId = typeof input === 'object' && input !== null && 'parent_id' in input
    ? String((input as Record<string, unknown>)['parent_id'])
    : null;
  try {
    const nodes = await db.listChildren(parentId);
    yield {
      type: 'result',
      value: {
        nodes: nodes.map((n) => ({
          id: n.id,
          name: n.name,
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

async function* executeWrite(db: FsDb, input: unknown): AsyncIterable<ToolEvent> {
  const p = tryCurrentPrincipal();
  if (!p) {
    yield { type: 'error', message: 'not authorized' };
    return;
  }
  const inp = input as Record<string, unknown>;
  const name = String(inp['name'] ?? '').trim();
  const content = String(inp['content'] ?? '');
  const parentId = inp['parent_id'] ? String(inp['parent_id']) : null;
  if (!name) {
    yield { type: 'error', message: 'name is required' };
    return;
  }
  try {
    const bytes = new TextEncoder().encode(content);
    const node = await db.createFile(name, parentId, 'text/plain', bytes.length);
    await db.storeBlob(node.id, bytes);
    yield { type: 'result', value: { ok: true, node: { id: node.id, name: node.name, size_bytes: node.size_bytes } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique|duplicate/i.test(msg)) {
      yield { type: 'error', message: 'file already exists' };
    } else {
      yield { type: 'error', message: msg };
    }
  }
}

async function* executeRead(db: FsDb, input: unknown): AsyncIterable<ToolEvent> {
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
    const node = await db.getNode(id);
    if (!node) {
      yield { type: 'error', message: 'file not found' };
      return;
    }
    if (node.kind !== 'file') {
      yield { type: 'error', message: 'not a file' };
      return;
    }
    if (node.storage_kind !== 'local') {
      yield { type: 'error', message: `adapter '${node.storage_kind}' not yet wired` };
      return;
    }
    const bytes = await db.getBlob(id);
    if (!bytes) {
      yield { type: 'error', message: 'file content not found' };
      return;
    }
    const content = new TextDecoder().decode(bytes);
    yield { type: 'result', value: { ok: true, content } };
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

export function buildFsTools(db: FsDb): Tool[] {
  return [
    {
      name: 'fs_list',
      description: 'List files and folders in a directory',
      inputSchema: {
        type: 'object' as const,
        properties: {
          parent_id: {
            type: 'string',
            description: 'Parent folder ID (omit for root)',
          },
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
      description: 'Create or update a text file',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'File name' },
          parent_id: { type: 'string', description: 'Parent folder ID (omit for root)' },
          content: { type: 'string', description: 'File content (UTF-8 text)' },
        },
        required: ['name', 'content'],
      },
      executor: {
        execute: async function* (input: unknown) {
          yield* executeWrite(db, input);
        },
      },
    },
    {
      name: 'fs_read',
      description: 'Read the content of a text file',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'File node ID' },
        },
        required: ['id'],
      },
      executor: {
        execute: async function* (input: unknown) {
          yield* executeRead(db, input);
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
