// SPDX-License-Identifier: AGPL-3.0-or-later
// Provider abstraction for the `logs` plugin. Each provider knows how to pull recent log lines from
// one platform given the source's non-secret config + its vault token. The tool layer dispatches on
// `source.provider`; adding a platform is a new module here plus a case in the dispatch map — the
// registry/tool layer never changes. Vercel, Fly, Heroku and Better Stack ship first (the operator's
// brief).
import type { Provider } from '../registry.js';
import { fetchVercel } from './vercel.js';
import { fetchFly } from './fly.js';
import { fetchHeroku } from './heroku.js';
import { fetchBetterstack } from './betterstack.js';

// One normalised log line across every provider.
export interface LogLine {
  ts?: string;
  level?: string;
  message: string;
}

export interface FetchOpts {
  limit: number;
  /** ISO timestamp / relative window understood by the provider; passed through where supported. */
  since?: string;
  /** Free-text filter; applied provider-side where the API allows, else ignored (documented per provider). */
  query?: string;
}

export type ProviderFetch = (
  config: Record<string, unknown>,
  token: string,
  opts: FetchOpts,
  signal: AbortSignal,
) => Promise<LogLine[]>;

const PROVIDERS: Record<Provider, ProviderFetch> = {
  vercel: fetchVercel,
  fly: fetchFly,
  heroku: fetchHeroku,
  betterstack: fetchBetterstack,
};

export function providerFetch(provider: Provider): ProviderFetch {
  return PROVIDERS[provider];
}

// ── Shared helpers ──────────────────────────────────────────────────────────

export class ProviderError extends Error {}

export function cfgStr(config: Record<string, unknown>, key: string): string {
  const v = config[key];
  return typeof v === 'string' ? v.trim() : '';
}

// A consistent HTTP error with a short body snippet so the agent sees *why* a provider rejected it.
export async function httpError(provider: string, res: Response): Promise<ProviderError> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  return new ProviderError(`${provider}: HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
}
