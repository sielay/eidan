// SPDX-License-Identifier: AGPL-3.0-or-later
// Stable slug + vault-key derivation shared by the engine OAuth server, the per-account token
// resolver, and the web admin route — so a value sealed under a key is always found by the same key.
// Pure (no pg / no fetch), so it is unit-testable in isolation. Mirrors imap/iCal's slugify.
//
// Vault keys are deliberately keyed only by (provider, slug), NOT by user_id: the vault is already
// user-scoped by storage (eidan.secrets_vault stamps the ambient principal), so a future move to a
// venture-scoped or shared connection is an RLS/policy change, never a key rename. See README.

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return s || 'account';
}

// Normalise a host (mastodon instance) for keying: drop scheme, path and trailing slash, lowercase.
// 'https://Mastodon.Social/' -> 'mastodon.social'. Returns '' for a blank input.
export function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\/+$/, '');
  return h;
}

function prov(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

// Per-account vault key names. The client id/secret are packed as one JSON value; the access token
// and (optional) durable refresh token each get their own key.
export function clientKey(provider: string, slug: string): string {
  return `EIDAN_${prov(provider)}_CLIENT_${slug}`;
}
export function tokenKey(provider: string, slug: string): string {
  return `EIDAN_${prov(provider)}_TOKEN_${slug}`;
}
export function refreshKey(provider: string, slug: string): string {
  return `EIDAN_${prov(provider)}_REFRESH_${slug}`;
}

// A per-host app credential key (mastodon dynamic app registration), shared by every account on the
// same instance so we register the app with the instance only once.
export function hostAppKey(provider: string, host: string): string {
  return `EIDAN_${prov(provider)}_HOSTAPP_${slugify(normalizeHost(host))}`;
}

export function packClient(c: { clientId: string; clientSecret: string }): string {
  return JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret });
}

// An app's sealed client may also carry a per-app `scopes` override (space/comma separated) — needed
// because some providers (e.g. LinkedIn) gate scopes by the app's enabled products, so different apps
// legitimately need different scope sets. Absent => the adapter's default scopes apply.
export function parseClient(raw: string): { clientId: string; clientSecret: string; scopes?: string[] } | null {
  try {
    const j = JSON.parse(raw) as { client_id?: string; client_secret?: string; scopes?: string };
    if (j.client_id && j.client_secret) {
      const scopes = (j.scopes ?? '').split(/[\s,]+/).filter(Boolean);
      return { clientId: j.client_id, clientSecret: j.client_secret, ...(scopes.length ? { scopes } : {}) };
    }
  } catch {
    // not JSON
  }
  return null;
}
