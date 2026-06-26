// SPDX-License-Identifier: AGPL-3.0-or-later
// Resolve fs storage-backend config from the matbot vault (NOT process.env): operator config — even
// non-secret URLs/bucket names — lives in the vault so it reaches every node with no per-node env
// (the eidan doctrine). The vault-postgres backend still falls back to process.env for a key that
// isn't sealed, so seeding via env keeps working, but the vault is canonical.
import type { ToolContext } from '@matatbread/matbot-plugin-api';

export type Resolve = (name: string) => Promise<string | undefined>;

// Build a name→value resolver over a ctx/engine vault. A missing key resolves to undefined (the
// vault throws MissingSecretError; we swallow it) so callers can treat backends as "unconfigured".
export function vaultResolve(vault: ToolContext['vault']): Resolve {
  return async (name: string): Promise<string | undefined> => {
    try {
      const v = await vault.resolve(`\${${name}}`);
      return v && v.length ? v : undefined;
    } catch {
      return undefined;
    }
  };
}

// Files at or above this size are offloaded to an external backend (Supabase Storage / S3) when one
// is configured; smaller files stay in Postgres bytea. ~512KB keeps the DB lean.
export const OFFLOAD_BYTES = 512 * 1024;
