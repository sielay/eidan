// SPDX-License-Identifier: AGPL-3.0-or-later
// Fly.io log reader. Fly has no first-party HTTP "pull recent logs" endpoint — live logs stream over
// NATS (what `fly logs` consumes), and history is meant to leave the platform via a *log shipper*
// (Fly's recommended pattern) into an aggregator. So a Fly source here reads from an operator-set
// `base_url`: either a Fly log drain / aggregator HTTP endpoint, or any service exposing recent Fly
// lines. (If you ship Fly logs to Better Stack, add a `betterstack` source instead — it has a real
// query API.) We GET `base_url` (optionally Bearer-authed), forwarding app/limit/since/query as
// query params, and parse JSON array, NDJSON, or plain text leniently.
// Config: { base_url (required), app?, base_url query params are provider-defined }.
import type { FetchOpts, LogLine, ProviderFetch } from './index.js';
import { ProviderError, cfgStr, httpError } from './index.js';

interface RawLine {
  ts?: unknown;
  timestamp?: unknown;
  time?: unknown;
  level?: unknown;
  message?: unknown;
  msg?: unknown;
  text?: unknown;
}

function toLine(o: RawLine): LogLine {
  const ts = o.ts ?? o.timestamp ?? o.time;
  const level = o.level;
  const message = o.message ?? o.msg ?? o.text ?? '';
  return {
    ...(ts !== undefined && ts !== null ? { ts: String(ts) } : {}),
    ...(typeof level === 'string' && level ? { level } : {}),
    message: typeof message === 'string' ? message : JSON.stringify(message),
  };
}

export const fetchFly: ProviderFetch = async (config, token, opts: FetchOpts, signal) => {
  const base = cfgStr(config, 'base_url');
  if (!base) {
    throw new ProviderError(
      'fly: config.base_url is required — Fly has no first-party log-pull API. Point it at a Fly log ' +
        'drain/aggregator, or route Fly logs to Better Stack and add a betterstack source instead.',
    );
  }
  const app = cfgStr(config, 'app');
  const u = new URL(base);
  if (app) u.searchParams.set('app', app);
  u.searchParams.set('limit', String(opts.limit));
  if (opts.since) u.searchParams.set('since', opts.since);
  if (opts.query) u.searchParams.set('query', opts.query);

  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(u, { headers, signal });
  if (!res.ok) throw await httpError('fly', res);

  const body = (await res.text()).trim();
  if (!body) return [];

  // Try a JSON array first, then NDJSON, then fall back to plain text lines.
  try {
    const parsed = JSON.parse(body) as unknown;
    if (Array.isArray(parsed)) return parsed.map((o) => toLine(o as RawLine));
  } catch {
    /* not a single JSON document — try NDJSON / text below */
  }
  const rows = body.split('\n').filter((l) => l.trim());
  const ndjson: LogLine[] = [];
  let allJson = true;
  for (const row of rows) {
    try {
      ndjson.push(toLine(JSON.parse(row) as RawLine));
    } catch {
      allJson = false;
      break;
    }
  }
  if (allJson && ndjson.length) return ndjson;
  return rows.map((message) => ({ message }));
};
