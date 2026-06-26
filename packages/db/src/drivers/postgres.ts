// SPDX-License-Identifier: AGPL-3.0-or-later
// Postgres driver: a short-lived `pg.Client` per call (mirrors the mail bundle opening IMAP per
// call — no long-lived pools fanned across arbitrary operator databases). Full read/write: whatever
// SQL the agent sends runs as-is, under a per-call statement timeout. The connection's non-secret
// coordinates come from the registry row; the password is resolved from the vault by the caller.
import pg from 'pg';
import type { ConnectionRow } from '../registry.js';
import type { InspectResult } from './index.js';

const MAX_ROWS = 1000;
const STATEMENT_TIMEOUT_MS = 30_000;

function clientConfig(row: ConnectionRow, password: string): pg.ClientConfig {
  const opts = row.options ?? {};
  const ssl =
    opts['ssl'] === true || opts['sslmode'] === 'require'
      ? { rejectUnauthorized: opts['sslRejectUnauthorized'] !== false }
      : undefined;
  const cfg: pg.ClientConfig = {
    host: row.host,
    port: row.port,
    database: row.database || undefined,
    user: row.username || undefined,
    password: password || undefined,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    connectionTimeoutMillis: 10_000,
  };
  if (ssl) cfg.ssl = ssl;
  return cfg;
}

export interface PgRunResult {
  // One entry per statement in the submitted SQL (pg returns an array for multi-statement strings).
  results: Array<{ command: string; rowCount: number | null; fields: string[]; rows: unknown[]; truncated: boolean }>;
}

export async function pgRunSql(
  row: ConnectionRow,
  password: string,
  sql: string,
  params: unknown[],
  signal: AbortSignal,
  schema?: string,
): Promise<PgRunResult> {
  const client = new pg.Client(clientConfig(row, password));
  const onAbort = (): void => {
    // Best-effort cancel: end the socket so a long query doesn't outlive the turn.
    void client.end().catch(() => undefined);
  };
  await client.connect();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    // Scope unqualified names to the requested schema for this connection (still falls back to public,
    // and fully-qualified names keep working). Identifier is quote-escaped — SET can't bind a param.
    const want = schema?.trim();
    if (want) await client.query(`SET search_path TO ${quoteIdent(want)}, public`);
    const raw = await client.query({ text: sql, values: params });
    const list: pg.QueryResult[] = Array.isArray(raw) ? (raw as pg.QueryResult[]) : [raw];
    return {
      results: list.map((r) => {
        const rows = r.rows ?? [];
        return {
          command: r.command ?? '',
          rowCount: r.rowCount ?? null,
          fields: (r.fields ?? []).map((f: pg.FieldDef) => f.name),
          rows: rows.slice(0, MAX_ROWS),
          truncated: rows.length > MAX_ROWS,
        };
      }),
    };
  } finally {
    signal.removeEventListener('abort', onAbort);
    await client.end().catch(() => undefined);
  }
}

// Liveness/credentials probe: connect + `select 1`. Throws (with the driver's own message) on any
// failure — unreachable host, bad credentials, wrong database — which the test endpoint surfaces.
export async function pgPing(row: ConnectionRow, password: string, signal: AbortSignal): Promise<void> {
  const client = new pg.Client(clientConfig(row, password));
  const onAbort = (): void => void client.end().catch(() => undefined);
  await client.connect();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await client.query('select 1');
  } finally {
    signal.removeEventListener('abort', onAbort);
    await client.end().catch(() => undefined);
  }
}

export async function pgInspect(row: ConnectionRow, password: string, signal: AbortSignal, schema?: string): Promise<InspectResult> {
  const client = new pg.Client(clientConfig(row, password));
  const onAbort = (): void => void client.end().catch(() => undefined);
  await client.connect();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    // Always list the non-system schemas so the agent can discover them (and pick one to scope to).
    const s = await client.query(
      `select schema_name
         from information_schema.schemata
        where schema_name not in ('pg_catalog', 'information_schema')
          and schema_name not like 'pg_%'
        order by schema_name`,
    );
    const schemas = s.rows.map((x: { schema_name: string }) => x.schema_name);
    // Tables/views — scoped to one schema when asked, else across all non-system schemas.
    const want = schema?.trim();
    const r = await client.query(
      `select table_schema, table_name, table_type
         from information_schema.tables
        where table_schema not in ('pg_catalog', 'information_schema')
          and ($1::text is null or table_schema = $1)
        order by table_schema, table_name
        limit 2000`,
      [want || null],
    );
    return {
      driver: 'postgres',
      schemas,
      containers: r.rows.map((t: { table_schema: string; table_name: string; table_type: string }) => ({
        schema: t.table_schema,
        name: t.table_name,
        kind: t.table_type === 'VIEW' ? 'view' : 'table',
      })),
    };
  } finally {
    signal.removeEventListener('abort', onAbort);
    await client.end().catch(() => undefined);
  }
}

// Quote a Postgres identifier (schema name) for use in a SET — doubling embedded quotes, the standard
// identifier escape. Used because SET search_path can't take a bind parameter.
function quoteIdent(ident: string): string {
  return '"' + ident.replace(/"/g, '""') + '"';
}
