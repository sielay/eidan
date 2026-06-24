// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-call access-token resolution for the agent tools. Lists the caller's connected accounts, picks
// the requested one (or the first), reads its access token from the vault, and — for refresh-capable
// adapters — transparently refreshes + re-seals an expired token. Runs under the ambient Principal
// (RLS), so the re-seal lands in the caller's vault scope. Secrets stay in locals; only the token is
// handed to the platform client, never to the model.
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import type { OAuthAdapter } from './adapter.js';
import type { AccountStore, ConnAccount } from './registry.js';
import { parseClient, slugify } from './keys.js';
import { OAuthError, refreshAccessToken } from './oauth.js';

// No connected accounts at all — the caller may fall back to a legacy single-secret path.
export class NotConnectedError extends Error {}
// Accounts exist but the named one wasn't found, or its secret is missing/unrefreshable.
export class AccountResolveError extends Error {}

export interface SealFn {
  (name: string, value: string): Promise<void>;
}

const REFRESH_SKEW_MS = 60_000;

// Choose the account a call targets: by name/slug when given, else the first (oldest).
export function pickAccount(rows: ConnAccount[], wanted: string | undefined): ConnAccount | undefined {
  if (rows.length === 0) return undefined;
  const want = (wanted ?? '').trim();
  if (!want) return rows[0];
  const slug = slugify(want);
  return rows.find((r) => r.slug === slug || r.name.toLowerCase() === want.toLowerCase()) ?? undefined;
}

async function vaultOpt(ctx: ToolContext, name: string): Promise<string> {
  if (!name) return '';
  try {
    return (await ctx.vault.resolve('${' + name + '}')) ?? '';
  } catch (exc) {
    if (exc instanceof MissingSecretError) return '';
    throw exc;
  }
}

export interface ResolvedToken {
  accessToken: string;
  account: ConnAccount;
}

export interface ResolveOpts {
  accountSelector?: string;
  seal?: SealFn;
}

// Resolve a usable access token for the selected connected account. Throws NotConnectedError when no
// account is registered (so the caller can try a legacy fallback), AccountResolveError otherwise.
export async function resolveAccessToken(
  store: AccountStore,
  adapter: OAuthAdapter,
  ctx: ToolContext,
  opts: ResolveOpts,
): Promise<ResolvedToken> {
  const rows = await store.listAccounts();
  if (rows.length === 0) throw new NotConnectedError('no account connected');
  const account = pickAccount(rows, opts.accountSelector);
  if (!account) {
    const names = rows.map((r) => r.name).join(', ');
    throw new AccountResolveError(`no connected account named "${opts.accountSelector}" — try one of: ${names}`);
  }

  const stored = await vaultOpt(ctx, account.token_vault_key);

  // App-password adapters (bluesky): the "token" IS the app password; the client mints a session.
  if (adapter.flavor === 'app_password') {
    if (!stored) throw new AccountResolveError(`"${account.name}" has no credential in the vault — reconnect it.`);
    return { accessToken: stored, account };
  }

  const expired =
    account.token_expires_at !== null && account.token_expires_at.getTime() - Date.now() < REFRESH_SKEW_MS;

  if (stored && !expired) return { accessToken: stored, account };

  if (adapter.usesRefresh) {
    const refreshToken = await vaultOpt(ctx, account.refresh_vault_key);
    const client = parseClient(await vaultOpt(ctx, account.client_vault_key));
    if (!refreshToken || !client) {
      throw new AccountResolveError(`"${account.name}" can't be refreshed — reconnect it under Connections.`);
    }
    let refreshed;
    try {
      refreshed = await refreshAccessToken({
        adapter,
        refreshToken,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        ...(account.host ? { host: account.host } : {}),
      });
    } catch (exc) {
      throw new AccountResolveError(
        `"${account.name}" token refresh failed — reconnect it. (${exc instanceof OAuthError ? exc.message : String(exc)})`,
      );
    }
    if (opts.seal && adapter.cacheAccessToken !== false) {
      await opts.seal(account.token_vault_key, refreshed.accessToken);
      const expiresAt = refreshed.expiresIn > 0 ? new Date(Date.now() + refreshed.expiresIn * 1000) : null;
      await store.updateExpiry(account.id, expiresAt);
      if (refreshed.refreshToken) await opts.seal(account.refresh_vault_key, refreshed.refreshToken);
    }
    return { accessToken: refreshed.accessToken, account };
  }

  if (stored) return { accessToken: stored, account };
  throw new AccountResolveError(`"${account.name}" has no usable token — reconnect it under Connections.`);
}
