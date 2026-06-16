// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

// `scope.subkey` namespacing lives in the pure (pg-free) ./secret-key module so it is unit-testable;
// re-exported here since the read path + write tool import it from './db.js'.
export { splitSecretKey } from './secret-key.js';

export type SecretRow = { value_enc: Buffer; user_id: string | null };

// Thin pg wrapper for eidan.secrets_vault. Stamps eidan.current_user_id from the ambient
// Principal so RLS isolates per-user secrets when the connection is a non-superuser app role;
// reads also filter explicitly (user row preferred, instance-wide `user_id IS NULL` fallback)
// so the same query is correct whether or not RLS is in force.
export class Db {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  private principalId(): string | null {
    return tryCurrentPrincipal()?.id ?? null;
  }

  async read(scope: string, subkey: string): Promise<SecretRow | null> {
    const userId = this.principalId();
    const client = await this.pool.connect();
    try {
      if (userId) await client.query("select set_config('eidan.current_user_id', $1, true)", [userId]);
      const res = await client.query<SecretRow>(
        `select value_enc, user_id
           from eidan.secrets_vault
          where scope = $1 and key = $2
            and (user_id = $3 or user_id is null)
            and (expires_at is null or expires_at > now())
          order by (user_id is null) asc
          limit 1`,
        [scope, subkey, userId],
      );
      return res.rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  // Upsert a user-scoped (or, when userId is null, instance-wide) secret. Honours the
  // (user_id, scope, key) uniqueness from the eidan.secrets_vault schema (docs/0009-secrets-vault.md).
  async write(scope: string, subkey: string, valueEnc: Buffer, userId: string | null): Promise<void> {
    const client = await this.pool.connect();
    try {
      if (userId) await client.query("select set_config('eidan.current_user_id', $1, true)", [userId]);
      await client.query(
        `insert into eidan.secrets_vault (scope, key, value_enc, user_id)
              values ($1, $2, $3, $4)
         on conflict (user_id, scope, key)
              do update set value_enc = excluded.value_enc, updated_at = now()`,
        [scope, subkey, valueEnc, userId],
      );
    } finally {
      client.release();
    }
  }

  async delete(scope: string, subkey: string, userId: string | null): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      if (userId) await client.query("select set_config('eidan.current_user_id', $1, true)", [userId]);
      const res = await client.query(
        `delete from eidan.secrets_vault
          where scope = $1 and key = $2 and user_id is not distinct from $3`,
        [scope, subkey, userId],
      );
      return (res.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }

  // Metadata only — never returns value_enc. Backs the write-only self-serve list. Scoped to the
  // ambient principal (the caller's own secrets) plus instance-wide (user_id IS NULL) rows.
  async list(): Promise<{ scope: string; key: string; user_id: string | null; updated_at: Date }[]> {
    const userId = this.principalId();
    const client = await this.pool.connect();
    try {
      if (userId) await client.query("select set_config('eidan.current_user_id', $1, true)", [userId]);
      const res = await client.query<{ scope: string; key: string; user_id: string | null; updated_at: Date }>(
        `select scope, key, user_id, updated_at
           from eidan.secrets_vault
          where user_id is not distinct from $1 or user_id is null
          order by scope, key`,
        [userId],
      );
      return res.rows;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
