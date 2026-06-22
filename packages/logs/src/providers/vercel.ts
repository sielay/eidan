// SPDX-License-Identifier: AGPL-3.0-or-later
// Vercel log reader. Vercel exposes logs as deployment *events*: resolve the project's latest
// deployment, then pull its build+runtime events. Two documented REST calls, Bearer-authed:
//   GET /v6/deployments?projectId=…&limit=1[&teamId=…]   → newest deployment uid
//   GET /v3/deployments/{uid}/events?direction=backward&limit=N  → event stream (array form)
// Config: { project | project_id (required), team_id?, base_url? (default https://api.vercel.com) }.
// Token: a Vercel API token. `query` is filtered client-side (the events API has no text filter).
import type { FetchOpts, LogLine, ProviderFetch } from './index.js';
import { ProviderError, cfgStr, httpError } from './index.js';

interface VercelDeployment {
  uid?: string;
  id?: string;
}
interface VercelEvent {
  type?: string;
  created?: number;
  date?: number;
  payload?: { text?: string; [k: string]: unknown };
  text?: string;
}

export const fetchVercel: ProviderFetch = async (config, token, opts: FetchOpts, signal) => {
  const base = cfgStr(config, 'base_url') || 'https://api.vercel.com';
  const project = cfgStr(config, 'project_id') || cfgStr(config, 'project');
  const team = cfgStr(config, 'team_id');
  if (!project) throw new ProviderError('vercel: config.project_id (or config.project) is required');
  if (!token) throw new ProviderError('vercel: an API token is required');
  const teamQ = team ? `&teamId=${encodeURIComponent(team)}` : '';
  const headers = { authorization: `Bearer ${token}` };

  // 1) newest deployment for the project
  const depRes = await fetch(
    `${base}/v6/deployments?projectId=${encodeURIComponent(project)}&limit=1${teamQ}`,
    { headers, signal },
  );
  if (!depRes.ok) throw await httpError('vercel', depRes);
  const depJson = (await depRes.json()) as { deployments?: VercelDeployment[] };
  const dep = depJson.deployments?.[0];
  const uid = dep?.uid ?? dep?.id;
  if (!uid) return [];

  // 2) that deployment's events (newest first), then take `limit`
  const evRes = await fetch(
    `${base}/v3/deployments/${encodeURIComponent(uid)}/events?direction=backward&limit=${opts.limit}${teamQ}`,
    { headers, signal },
  );
  if (!evRes.ok) throw await httpError('vercel', evRes);
  const events = (await evRes.json()) as VercelEvent[];
  const q = (opts.query ?? '').toLowerCase();

  const lines: LogLine[] = [];
  for (const e of Array.isArray(events) ? events : []) {
    const message = e.payload?.text ?? e.text ?? '';
    if (!message) continue;
    if (q && !message.toLowerCase().includes(q)) continue;
    const ms = e.created ?? e.date;
    lines.push({
      ...(ms ? { ts: new Date(ms).toISOString() } : {}),
      ...(e.type ? { level: e.type } : {}),
      message,
    });
  }
  return lines;
};
