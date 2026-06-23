// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `logs` plugin — read deployment/app logs from the operator's named sources.
//
// Per-user, multi-source: the operator registers named sources in the Integrations → Logs screen
// (provider + project/app/team or query endpoint + API token). The non-secret config lives in
// plugin_logs.sources; only the token is sealed in the vault. Each tool takes an optional `source`
// name and resolves that source's config + token per call.
//   logs_list_sources — discover what's reachable (name, provider; no secrets)
//   logs_read         — pull recent log lines from a source (limit / since / query)
import type { Tool } from '@matatbread/matbot-plugin-api';
import type { Registry } from './registry.js';
import { LogConfigError, resolveSource } from './config.js';
import { type FetchOpts, providerFetch } from './providers/index.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const SOURCE_PROP = {
  source: {
    type: 'string',
    description:
      'Which named log source to read (from Integrations → Logs). Omit only when a single source ' +
      'is registered. Call logs_list_sources first if unsure.',
  },
};

const LIST_SCHEMA = { type: 'object', additionalProperties: false, properties: {} };

const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SOURCE_PROP,
    limit: { type: 'integer', description: `Max lines (default ${DEFAULT_LIMIT}).`, minimum: 1, maximum: MAX_LIMIT },
    since: { type: 'string', description: 'Optional time window/ISO timestamp; honoured where the provider supports it.' },
    query: { type: 'string', description: 'Optional free-text filter applied to log lines.' },
  },
};

function errorMessage(e: unknown): string {
  if (e instanceof LogConfigError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function makeLogTools(registry: Registry): Tool[] {
  const logsListSourcesTool: Tool = {
    name: 'logs_list_sources',
    description:
      "List the operator's registered log sources (name, provider). No tokens. Call this first to " +
      'learn which `source` names are available (Vercel / Fly / Heroku / Better Stack).',
    inputSchema: LIST_SCHEMA,
    executor: {
      async *execute() {
        const rows = await registry.listSources();
        yield {
          type: 'result',
          value: { sources: rows.map((r) => ({ name: r.name, provider: r.provider })) },
        };
      },
    },
  };

  const logsReadTool: Tool = {
    name: 'logs_read',
    description:
      'Read the most recent log lines from a source (Vercel deployment events, Heroku app logs, ' +
      'Better Stack query, or a Fly drain). Returns lines newest-first with timestamps where ' +
      'available. Use `query` to filter and `limit` to bound the volume. Pass `source` to choose ' +
      'among several.',
    inputSchema: READ_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { source?: string; limit?: number; since?: string; query?: string };
        const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args.limit) || DEFAULT_LIMIT));
        try {
          const { row, token } = await resolveSource(registry, ctx, args.source);
          const opts: FetchOpts = {
            limit,
            ...(args.since ? { since: String(args.since) } : {}),
            ...(args.query ? { query: String(args.query) } : {}),
          };
          const lines = await providerFetch(row.provider)(row.config ?? {}, token, opts, ctx.signal);
          yield { type: 'result', value: { source: row.name, provider: row.provider, count: lines.length, lines } };
        } catch (e) {
          yield { type: 'error', message: errorMessage(e) };
        }
      },
    },
  };

  return [logsListSourcesTool, logsReadTool];
}
