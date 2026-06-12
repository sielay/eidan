// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Vault } from '@matatbread/matbot-plugin-api';
import { MissingSecretError, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { Db, splitSecretKey } from './db.js';
import { encryptValue, decryptValue } from './crypto.js';

const REF_RE = /\$\{([^}]+)\}/g;

// A matbot Vault backend over eidan.secrets_vault. Resolution order per name:
//   1. the encrypted vault — user-scoped row (ambient Principal) preferred, instance-wide
//      (user_id IS NULL) fallback; decrypted with the master KEK,
//   2. process.env — the static tier that still carries operator/provider keys
//      (ANTHROPIC_API_KEY, EIDAN_AUTH_MASTER_KEY, EIDAN_DATABASE_URL, …).
// Self-serve writes (chat / Connections UI) land in tier 1, user-scoped, so a user-set secret
// wins over an env default. Misses throw MissingSecretError (matbot contract); optional readers
// (the pro plugins' secretOpt) catch it and degrade.
export class PostgresVault implements Vault {
  private readonly db: Db;
  // Capture-safe redaction + dedup index: every value we resolve or write is remembered so
  // scrub() can strip it from model-facing text and findByValue()/hasKey() answer synchronously
  // (the interface is sync; a DB round-trip per call isn't an option). Best-effort, like the
  // default VaultImpl's in-memory store.
  private readonly cache = new Map<string, string>();

  constructor(db: Db) {
    this.db = db;
  }

  private async lookup(name: string): Promise<string | undefined> {
    const { scope, subkey } = splitSecretKey(name);
    try {
      const row = await this.db.read(scope, subkey);
      if (row) {
        const plain = decryptValue(row.value_enc).toString('utf8');
        this.cache.set(name, plain);
        return plain;
      }
    } catch {
      // DB hiccup or a value that won't decrypt (stale master key): never block the loop —
      // fall through to env. A decrypt failure is the operator's signal to check the KEK.
    }
    const env = process.env[name];
    if (env !== undefined && env !== '') {
      this.cache.set(name, env);
      return env;
    }
    return undefined;
  }

  async resolve(ref: string): Promise<string> {
    const names = [...ref.matchAll(REF_RE)].map(m => m[1] as string);
    if (names.length === 0) return ref;

    const missing: string[] = [];
    const resolved = new Map<string, string>();
    for (const name of names) {
      const value = await this.lookup(name);
      if (value === undefined) missing.push(name);
      else resolved.set(name, value);
    }
    if (missing.length > 0) throw new MissingSecretError(missing);

    return ref.replace(REF_RE, (_full, name: string) => resolved.get(name) ?? '');
  }

  scrub(text: string): string {
    let result = text;
    for (const value of this.cache.values()) {
      if (value.length >= 4) result = result.split(value).join('[redacted]');
    }
    return result;
  }

  async writeSecret(name: string, value: string): Promise<void> {
    const { scope, subkey } = splitSecretKey(name);
    const userId = tryCurrentPrincipal()?.id ?? null;
    await this.db.write(scope, subkey, encryptValue(Buffer.from(value, 'utf8')), userId);
    this.cache.set(name, value);
  }

  async deleteSecret(name: string): Promise<boolean> {
    const { scope, subkey } = splitSecretKey(name);
    const userId = tryCurrentPrincipal()?.id ?? null;
    this.cache.delete(name);
    return this.db.delete(scope, subkey, userId);
  }

  hasKey(name: string): boolean {
    return this.cache.has(name) || (process.env[name] !== undefined && process.env[name] !== '');
  }

  findByValue(value: string): string | undefined {
    for (const [k, v] of this.cache) if (v === value) return k;
    return undefined;
  }

  // Store a secret arriving (often) from a user via the LLM, returning the key name callers must
  // reference — which may differ from `name` (it was a reference, or a dedup hit). Mirrors the
  // default Vault.createSecret policy without importing matbot-security internals.
  async createSecret(name: string, value: string): Promise<string> {
    if (this.hasKey(value)) return value;            // `value` is itself a known key name
    const existing = this.findByValue(value);
    if (existing !== undefined) return existing;     // already stored under another name (dedup)
    await this.writeSecret(name, value);
    return name;
  }
}
