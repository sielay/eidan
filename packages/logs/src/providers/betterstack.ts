// SPDX-License-Identifier: AGPL-3.0-or-later
// Better Stack (Telemetry / Logs) reader. Better Stack exposes logs through a ClickHouse-compatible
// HTTP query endpoint, so a source is queried with SQL. We keep the endpoint and column names in the
// source config (Better Stack assigns a per-team query host + a source table), which keeps this
// honest across plan/region differences instead of hard-coding a host that may not be yours.
//   POST {query_url}   body: "SELECT … FORMAT JSON"   → { data: [ { <ts_column>, <message_column> } ] }
// Config: { query_url (required), table (required), ts_column? (default dt), message_column? (default raw),
//           username? (Basic-auth user; else the token is sent as Bearer), base_url? }.
// Token: the Better Stack query password / API token.
import type { FetchOpts, LogLine, ProviderFetch } from './index.js';
import { ProviderError, cfgStr, httpError } from './index.js';

// Single-quote escape for inlining a filter into ClickHouse SQL (params aren't available over the
// plain HTTP interface). Backslash-escape both quote and backslash.
function sqlLiteral(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export const fetchBetterstack: ProviderFetch = async (config, token, opts: FetchOpts, signal) => {
  const url = cfgStr(config, 'query_url');
  const table = cfgStr(config, 'table');
  if (!url) throw new ProviderError('betterstack: config.query_url is required (your team query endpoint)');
  if (!table) throw new ProviderError('betterstack: config.table is required (the source table to read)');
  if (!token) throw new ProviderError('betterstack: an API token is required');
  const tsCol = cfgStr(config, 'ts_column') || 'dt';
  const msgCol = cfgStr(config, 'message_column') || 'raw';
  const username = cfgStr(config, 'username');

  const where = opts.query ? ` WHERE ${msgCol} ILIKE ${sqlLiteral(`%${opts.query}%`)}` : '';
  const sql =
    `SELECT ${tsCol} AS ts, ${msgCol} AS message FROM ${table}${where} ` +
    `ORDER BY ${tsCol} DESC LIMIT ${Math.max(1, Math.floor(opts.limit))} FORMAT JSON`;

  const auth = username
    ? `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`
    : `Bearer ${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'text/plain' },
    body: sql,
    signal,
  });
  if (!res.ok) throw await httpError('betterstack', res);
  const json = (await res.json()) as { data?: Array<{ ts?: unknown; message?: unknown }> };

  return (json.data ?? []).map((r) => ({
    ...(r.ts !== undefined && r.ts !== null ? { ts: String(r.ts) } : {}),
    message: typeof r.message === 'string' ? r.message : JSON.stringify(r.message),
  }));
};
