// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store, FileStore, StorageBackend, FileHandle, FileEvent } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { PgSessionStore, PgKvStore } from './session-store.js';

const notImplemented = (): never => {
  throw new Error(
    'FileStore not yet implemented by @eidan/storage-postgres — Phase: back with eidan.artifacts + artifact_blobs (bytea).',
  );
};

class UnsupportedFileStore implements FileStore {
  put(): Promise<FileHandle> { return notImplemented(); }
  get(): Promise<FileHandle | null> { return notImplemented(); }
  getByName(): Promise<FileHandle | null> { return notImplemented(); }
  delete(): Promise<void> { return notImplemented(); }
  // eslint-disable-next-line require-yield
  async *list(): AsyncIterable<FileHandle> { notImplemented(); }
  putTemp(): Promise<FileHandle> { return notImplemented(); }
  // eslint-disable-next-line require-yield
  async *watch(): AsyncIterable<FileEvent> { notImplemented(); }
}

export class EidanStorageBackend implements StorageBackend {
  readonly fileStore: FileStore = new UnsupportedFileStore();
  private readonly stores = new Map<string, unknown>();

  constructor(private readonly db: Db) {}

  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    let s = this.stores.get(namespace);
    if (!s) {
      s = namespace === 'sessions' ? new PgSessionStore(this.db) : new PgKvStore<T>(this.db, namespace);
      this.stores.set(namespace, s);
    }
    return s as Store<T>;
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  // The eidan DB connection string is static infra config → env (eidan secrets doctrine:
  // static app config lives in env; only per-user creds go through the vault). This is a
  // node-only plugin (matbotRuntime: ["node"]), so reading env here is allowed.
  static open(_dotData: string): Promise<EidanStorageBackend> {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) {
      return Promise.reject(new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidan/storage-postgres'));
    }
    return Promise.resolve(new EidanStorageBackend(new Db(url)));
  }
}
