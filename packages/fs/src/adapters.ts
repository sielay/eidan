// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FsDb } from './db.js';

export interface StorageAdapter {
  kind: string;
  list(mountRef: string): Promise<Array<{ name: string; ref: string; kind: 'file' | 'folder'; mime?: string; size?: number }>>;
  read(ref: string): Promise<{ bytes: Uint8Array; mime: string }>;
  write(ref: string, bytes: Uint8Array, mime: string): Promise<void>;
  remove(ref: string): Promise<void>;
}

class LocalAdapter implements StorageAdapter {
  kind = 'local';

  constructor(private db: FsDb) {}

  async list(): Promise<Array<{ name: string; ref: string; kind: 'file' | 'folder'; mime?: string; size?: number }>> {
    return [];
  }

  async read(ref: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const bytes = await this.db.getBlob(ref);
    if (!bytes) throw new Error('blob not found');
    const node = await this.db.getNode(ref);
    if (!node) throw new Error('node not found');
    return { bytes, mime: node.mime ?? 'application/octet-stream' };
  }

  async write(ref: string, bytes: Uint8Array, mime: string): Promise<void> {
    await this.db.storeBlob(ref, bytes);
  }

  async remove(): Promise<void> {
    throw new Error('local adapter: remove not implemented');
  }
}

export class AdapterRegistry {
  private adapters: Map<string, StorageAdapter>;

  constructor(db: FsDb) {
    this.adapters = new Map();
    this.adapters.set('local', new LocalAdapter(db));
  }

  getAdapter(kind: string): StorageAdapter {
    const adapter = this.adapters.get(kind);
    if (adapter) return adapter;

    if (['s3', 'supabase', 'gdrive'].includes(kind)) {
      throw new Error(`adapter '${kind}' not yet wired — external storage adapters are added separately`);
    }
    throw new Error(`unknown adapter '${kind}'`);
  }
}

export function createAdapterRegistry(db: FsDb): AdapterRegistry {
  return new AdapterRegistry(db);
}
