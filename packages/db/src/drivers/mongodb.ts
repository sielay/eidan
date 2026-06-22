// SPDX-License-Identifier: AGPL-3.0-or-later
// MongoDB driver: a short-lived `MongoClient` per call. Full read/write is expressed the native
// Mongo way — the agent sends a *command document* (e.g. `{ find: "users", filter: {…}, limit: 10 }`,
// `{ aggregate: … }`, `{ insert: … }`, `{ update: … }`, `{ delete: … }`) which we hand to
// `db.command()`. That single entry point covers reads and writes uniformly, so there is no
// per-operation surface to maintain. The non-secret coordinates come from the registry row; the
// password is resolved from the vault by the caller.
import { MongoClient } from 'mongodb';
import type { ConnectionRow } from '../registry.js';
import type { InspectResult } from './index.js';

const CONNECT_TIMEOUT_MS = 10_000;

// Build a connection URI from the registry row + vault password. `options.srv === true` selects the
// mongodb+srv scheme (Atlas-style); any other `options` keys become query parameters (authSource,
// replicaSet, tls, …). user/pass are percent-encoded so passwords with special characters work.
export function mongoUri(row: ConnectionRow, password: string): string {
  const opts = { ...(row.options ?? {}) } as Record<string, unknown>;
  const srv = opts['srv'] === true;
  delete opts['srv'];
  const scheme = srv ? 'mongodb+srv' : 'mongodb';
  const auth = row.username ? `${encodeURIComponent(row.username)}:${encodeURIComponent(password)}@` : '';
  // SRV URIs derive the port from DNS, so omit it; standard URIs carry host:port.
  const host = srv ? row.host : `${row.host}:${row.port}`;
  const db = row.database ? `/${encodeURIComponent(row.database)}` : '/';
  const params = Object.entries(opts)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  const query = params.length ? `?${params.join('&')}` : '';
  return `${scheme}://${auth}${host}${db}${query}`;
}

function defaultDb(row: ConnectionRow): string {
  return row.database || 'test';
}

export async function mongoRunCommand(
  row: ConnectionRow,
  password: string,
  command: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const client = new MongoClient(mongoUri(row, password), { connectTimeoutMS: CONNECT_TIMEOUT_MS });
  const onAbort = (): void => void client.close(true).catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await client.connect();
    return await client.db(defaultDb(row)).command(command);
  } finally {
    signal.removeEventListener('abort', onAbort);
    await client.close().catch(() => undefined);
  }
}

// Liveness/credentials probe: connect + admin `ping`. Throws (with the driver's own message) on any
// failure — unreachable host, bad credentials, auth source — which the test endpoint surfaces.
export async function mongoPing(row: ConnectionRow, password: string, signal: AbortSignal): Promise<void> {
  const client = new MongoClient(mongoUri(row, password), { connectTimeoutMS: CONNECT_TIMEOUT_MS, serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS });
  const onAbort = (): void => void client.close(true).catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await client.connect();
    await client.db(defaultDb(row)).command({ ping: 1 });
  } finally {
    signal.removeEventListener('abort', onAbort);
    await client.close().catch(() => undefined);
  }
}

export async function mongoInspect(row: ConnectionRow, password: string, signal: AbortSignal): Promise<InspectResult> {
  const client = new MongoClient(mongoUri(row, password), { connectTimeoutMS: CONNECT_TIMEOUT_MS });
  const onAbort = (): void => void client.close(true).catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await client.connect();
    const cols = await client.db(defaultDb(row)).listCollections({}, { nameOnly: true }).toArray();
    return {
      driver: 'mongodb',
      containers: cols.map((c) => ({ name: String(c['name']), kind: 'collection' })),
    };
  } finally {
    signal.removeEventListener('abort', onAbort);
    await client.close().catch(() => undefined);
  }
}
