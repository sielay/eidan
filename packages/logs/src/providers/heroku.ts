// SPDX-License-Identifier: AGPL-3.0-or-later
// Heroku log reader — the documented Platform API two-step:
//   POST /apps/{app}/log-sessions   { lines, tail:false, source?, dyno? }  → { logplex_url }
//   GET  {logplex_url}              → text/plain log lines (Logplex format)
// Config: { app (required), source?, dyno?, base_url? (default https://api.heroku.com) }.
// Token: a Heroku API key (Bearer). Each Logplex line is `<ts> <app[dyno]>: <message>`; we split the
// leading RFC3339 timestamp off as `ts` and keep the rest as the message. `query` filters client-side.
import type { FetchOpts, LogLine, ProviderFetch } from './index.js';
import { ProviderError, cfgStr, httpError } from './index.js';

const HEROKU_ACCEPT = 'application/vnd.heroku+json; version=3';

export const fetchHeroku: ProviderFetch = async (config, token, opts: FetchOpts, signal) => {
  const base = cfgStr(config, 'base_url') || 'https://api.heroku.com';
  const app = cfgStr(config, 'app');
  if (!app) throw new ProviderError('heroku: config.app is required');
  if (!token) throw new ProviderError('heroku: an API token is required');
  const source = cfgStr(config, 'source');
  const dyno = cfgStr(config, 'dyno');

  const sessRes = await fetch(`${base}/apps/${encodeURIComponent(app)}/log-sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: HEROKU_ACCEPT, 'content-type': 'application/json' },
    body: JSON.stringify({ lines: opts.limit, tail: false, ...(source ? { source } : {}), ...(dyno ? { dyno } : {}) }),
    signal,
  });
  if (!sessRes.ok) throw await httpError('heroku', sessRes);
  const session = (await sessRes.json()) as { logplex_url?: string };
  if (!session.logplex_url) throw new ProviderError('heroku: log-session returned no logplex_url');

  const logRes = await fetch(session.logplex_url, { signal });
  if (!logRes.ok) throw await httpError('heroku', logRes);
  const text = await logRes.text();
  const q = (opts.query ?? '').toLowerCase();

  const lines: LogLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (q && !line.toLowerCase().includes(q)) continue;
    // Logplex format: "2024-01-01T00:00:00.000000+00:00 app[web.1]: message"
    const m = /^(\S+)\s+(.*)$/.exec(line);
    const ts = m && /^\d{4}-\d{2}-\d{2}T/.test(m[1] ?? '') ? m[1] : undefined;
    const message = ts ? (m?.[2] ?? line) : line;
    lines.push({ ...(ts ? { ts } : {}), message });
  }
  return lines;
};
