// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-connection credential resolution for the `db` plugin. The operator's named connections live
// in plugin_db.connections (non-secret coordinates in plain columns; the password sealed in the
// vault under each connection's `pass_key`). At call time we list the caller's connections, pick the
// requested one (or the single one when only one exists), and resolve the password from the vault.
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import type { ConnectionRow, Registry } from './registry.js';
import { secretOpt } from './vault.js';

export class DbConfigError extends Error {}

// Stable slug → vault-key derivation, shared with the admin data route so registry rows and sealed
// secrets agree. Same shape as the mail bundle's slugify.
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return s || 'connection';
}

export function passKey(slug: string): string {
  return `EIDAN_DB_PASS_${slug}`;
}

// Choose the connection a call targets: by name/slug match when given, else the single connection
// (only when exactly one is registered — never silently guess among several).
export function pickConnection(rows: ConnectionRow[], wanted: string | undefined): ConnectionRow | undefined {
  const want = (wanted ?? '').trim();
  if (!want) return rows.length === 1 ? rows[0] : undefined;
  const slug = slugify(want);
  return rows.find((r) => r.slug === slug || r.name.toLowerCase() === want.toLowerCase()) ?? undefined;
}

export interface ResolvedConnection {
  row: ConnectionRow;
  /** The connection password, resolved from the vault. Empty string when the DB needs no password. */
  password: string;
}

// Resolve the connection a call targets, including its sealed password. Throws a clear, agent-facing
// error when the name is missing/ambiguous or the password isn't in the vault.
export async function resolveConnection(
  registry: Registry,
  ctx: ToolContext,
  connection: string | undefined,
): Promise<ResolvedConnection> {
  const rows = await registry.listConnections();
  if (rows.length === 0) {
    throw new DbConfigError(
      'No database connections configured — add one under Integrations → Databases (driver, host, ' +
        'database, username and password).',
    );
  }
  const row = pickConnection(rows, connection);
  if (!row) {
    const names = rows.map((r) => r.name).join(', ');
    throw new DbConfigError(
      connection
        ? `No database connection named "${connection}". Known connections: ${names}.`
        : `Multiple database connections exist (${names}) — pass \`connection\` to choose one.`,
    );
  }
  const password = row.pass_key ? ((await secretOpt(ctx, row.pass_key)) ?? '') : '';
  if (row.pass_key && !password) {
    throw new DbConfigError(
      `The password for "${row.name}" isn't in the vault — re-add the connection under Integrations → Databases.`,
    );
  }
  return { row, password };
}
