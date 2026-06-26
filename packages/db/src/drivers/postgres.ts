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

// Quote a Postgres identifier (schema/table name) for use in SQL. Uses PostgreSQL's standard
// identifier-escaping method (RFC 5050): doubling embedded double-quotes. This is robust against
// SQL injection for all identifier characters, including those from system catalogs like
// information_schema.tables. Mirrors the behavior of PostgreSQL's format('%I', ...) function.
function quoteIdent(ident: string): string {
  return '"' + ident.replace(/"/g, '""') + '"';
}

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

export interface TableSchema {
  columns: Array<{ name: string; type: string }>;
  row_count: number;
  indexes: string[];
  foreign_keys: Array<{ column: string; referenced_table: string; referenced_column: string }>;
}

export interface IntrospectResult {
  tables: string[];
  table_schemas: Record<string, TableSchema>;
}

export async function pgIntrospect(
  row: ConnectionRow,
  password: string,
  signal: AbortSignal,
  tableFilter?: string[],
): Promise<IntrospectResult> {
  const client = new pg.Client(clientConfig(row, password));
  const onAbort = (): void => void client.end().catch(() => undefined);
  await client.connect();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    // Get all accessible tables (respecting RLS via has_table_privilege)
    let query = `
      select t.table_schema, t.table_name
        from information_schema.tables t
       where t.table_schema not in ('pg_catalog', 'information_schema')
         and t.table_schema not like 'pg_%'
         and has_table_privilege(format('%I.%I', t.table_schema, t.table_name)::regclass, 'SELECT')
       order by t.table_schema, t.table_name
       limit 2000
    `;
    const params: unknown[] = [];

    // If table filter provided, add pattern matching (shell-style wildcards: * and ?)
    if (tableFilter && tableFilter.length > 0) {
      const patterns = tableFilter.map(f => wildcardToSqlPattern(f));
      const whereClauses = patterns.map((_, i) => `t.table_name LIKE $${i + 1} ESCAPE '\\'`).join(' OR ');
      query += ` AND (${whereClauses})`;
      params.push(...patterns);
    }

    const tableResult = await client.query(query, params);
    const tables: Array<{ schema: string; name: string }> = tableResult.rows;

    // Build table_schemas with columns, types, row counts, and relationships
    const table_schemas: Record<string, TableSchema> = {};

    for (const table of tables) {
      const fullName = `${table.schema}.${table.name}`;

      // Get columns and their types
      const colResult = await client.query(
        `select column_name, data_type, udt_name
           from information_schema.columns
          where table_schema = $1 and table_name = $2
          order by ordinal_position`,
        [table.schema, table.name],
      );
      const columns = colResult.rows.map((c: { column_name: string; data_type: string; udt_name: string }) => ({
        name: c.column_name,
        type: c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type,
      }));

      // Get row count (use estimate from pg_class if available, otherwise accurate count)
      let rowCount = 0;
      try {
        const countResult = await client.query(
          `select n_live_tup as count from pg_stat_user_tables where schemaname = $1 and relname = $2`,
          [table.schema, table.name],
        );
        if (countResult.rows.length > 0) {
          rowCount = countResult.rows[0].count ?? 0;
        }
      } catch {
        // If pg_stat_user_tables fails, fall back to COUNT (slower but accurate)
        try {
          const countResult = await client.query(
            `SELECT COUNT(*) as count FROM ${quoteIdent(table.schema)}.${quoteIdent(table.name)}`,
          );
          rowCount = countResult.rows[0]?.count ?? 0;
        } catch {
          // If COUNT fails (maybe insufficient permissions), just set to 0
          rowCount = 0;
        }
      }

      // Get indexes
      const idxResult = await client.query(
        `select indexname from pg_indexes where schemaname = $1 and tablename = $2`,
        [table.schema, table.name],
      );
      const indexes = idxResult.rows.map((i: { indexname: string }) => i.indexname);

      // Get foreign keys
      const fkResult = await client.query(
        `select kcu.column_name, ccu.table_name as referenced_table, ccu.column_name as referenced_column
           from information_schema.table_constraints tc
           join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
           join information_schema.constraint_column_usage ccu on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
          where tc.constraint_type = 'FOREIGN KEY'
            and tc.table_schema = $1 and tc.table_name = $2`,
        [table.schema, table.name],
      );
      const foreign_keys = fkResult.rows;

      table_schemas[fullName] = {
        columns,
        row_count: rowCount,
        indexes,
        foreign_keys,
      };
    }

    const tableNames = tables.map(t => `${t.schema}.${t.name}`);

    return {
      tables: tableNames,
      table_schemas,
    };
  } finally {
    signal.removeEventListener('abort', onAbort);
    await client.end().catch(() => undefined);
  }
}

// Convert shell-style wildcards to SQL LIKE patterns. Escapes SQL metacharacters (% and _) that are
// literals in the pattern, then converts shell wildcards (* and ?) to SQL equivalents.
export function wildcardToSqlPattern(pattern: string): string {
  return pattern.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/\*/g, '%').replace(/\?/g, '_');
}
