// SPDX-License-Identifier: AGPL-3.0-or-later
// Xero OAuth2 adapter for the connections kit. Standard authorization-code grant with `offline_access`
// in the scope set, so Xero issues a durable (rotating) refresh token the kit uses to mint short-lived
// (30-minute) access tokens per call. Xero's token endpoint requires HTTP Basic client auth, hence
// `tokenAuthStyle: 'basic'`.
//
// One Xero consent can grant access to several organisations ("tenants"); we connect the FIRST tenant
// returned by /connections (most operators connect a single org — to use another, connect it as a
// separate account). The tenant id is stored as the account's `external_id` and replayed as the
// `Xero-tenant-id` header on every API call (see client.ts / tools.ts).
import type { OAuthAdapter } from '@eidandev/connections-kit';

export const XERO_PROVIDER = 'xero';

export const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
export const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';

// Read-only scope set, using Xero's GRANULAR scopes (the broad `accounting.transactions.read` /
// `accounting.reports.read` are rejected unless toggled on; the granular ones below are what a Xero app
// enables by default). `offline_access` (required for refresh tokens) is a standard scope and isn't in
// the portal's togglable list. Covers: contacts, settings (chart of accounts + organisation), invoices,
// bank transactions, and the P&L / balance-sheet / aged reports the tools read.
export const XERO_SCOPES = [
  'offline_access',
  'accounting.contacts.read',
  'accounting.settings.read',
  'accounting.invoices.read',
  'accounting.banktransactions.read',
  'accounting.reports.profitandloss.read',
  'accounting.reports.balancesheet.read',
  'accounting.reports.aged.read',
];

interface XeroConnection {
  tenantId: string;
  tenantType?: string;
  tenantName?: string;
}

export const xeroAdapter: OAuthAdapter = {
  provider: XERO_PROVIDER,
  flavor: 'oauth2',
  scopes: XERO_SCOPES,
  usesRefresh: true,
  // offline_access guarantees a refresh token on first consent; fail loudly if it's somehow absent.
  requireRefreshOnConnect: true,
  // Cache the 30-minute access token in the vault between calls — Xero refresh tokens are single-use
  // and rotate on every refresh, so minimising refreshes keeps the rotation chain short and robust.
  cacheAccessToken: true,
  // Xero's token endpoint wants client_id/client_secret as an HTTP Basic Authorization header.
  tokenAuthStyle: 'basic',
  endpoints: () => ({ authUrl: XERO_AUTHORIZE_URL, tokenUrl: XERO_TOKEN_URL }),
  async fetchIdentity(accessToken: string) {
    // Discover which organisation(s) this consent granted. We adopt the first tenant; its id is the
    // Xero-tenant-id every subsequent API call must carry.
    let resp: Response;
    try {
      resp = await fetch(XERO_CONNECTIONS_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { handle: '', id: '' };
    }
    if (resp.status !== 200) return { handle: '', id: '' };
    const conns = (await resp.json().catch(() => [])) as XeroConnection[];
    const first = Array.isArray(conns) ? conns[0] : undefined;
    if (!first) return { handle: '', id: '' };
    return { handle: first.tenantName ?? '', id: first.tenantId ?? '' };
  },
};
