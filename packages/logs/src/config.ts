// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-source credential resolution for the `logs` plugin. The operator's named sources live in
// plugin_logs.sources (provider + non-secret config in jsonb; the API token sealed in the vault
// under each source's `token_key`). At call time we list the caller's sources, pick the requested
// one (or the single one when only one exists), and resolve the token from the vault.
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import type { SourceRow, Registry } from './registry.js';
import { secretOpt } from './vault.js';

export class LogConfigError extends Error {}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return s || 'source';
}

export function tokenKey(slug: string): string {
  return `EIDAN_LOG_TOKEN_${slug}`;
}

// Choose the source a call targets: by name/slug match when given, else the single source (only when
// exactly one is registered — never silently guess among several).
export function pickSource(rows: SourceRow[], wanted: string | undefined): SourceRow | undefined {
  const want = (wanted ?? '').trim();
  if (!want) return rows.length === 1 ? rows[0] : undefined;
  const slug = slugify(want);
  return rows.find((r) => r.slug === slug || r.name.toLowerCase() === want.toLowerCase()) ?? undefined;
}

export interface ResolvedSource {
  row: SourceRow;
  /** The API token, resolved from the vault. Empty string when the provider needs none. */
  token: string;
}

export async function resolveSource(
  registry: Registry,
  ctx: ToolContext,
  source: string | undefined,
): Promise<ResolvedSource> {
  const rows = await registry.listSources();
  if (rows.length === 0) {
    throw new LogConfigError(
      'No log sources configured — add one under Integrations → Logs (provider + project/app + API token).',
    );
  }
  const row = pickSource(rows, source);
  if (!row) {
    const names = rows.map((r) => r.name).join(', ');
    throw new LogConfigError(
      source
        ? `No log source named "${source}". Known sources: ${names}.`
        : `Multiple log sources exist (${names}) — pass \`source\` to choose one.`,
    );
  }
  const token = row.token_key ? ((await secretOpt(ctx, row.token_key)) ?? '') : '';
  if (row.token_key && !token) {
    throw new LogConfigError(
      `The API token for "${row.name}" isn't in the vault — re-add the source under Integrations → Logs.`,
    );
  }
  return { row, token };
}
