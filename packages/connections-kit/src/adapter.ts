// SPDX-License-Identifier: AGPL-3.0-or-later
// The per-platform surface. Everything else in the kit is provider-agnostic; an integration ships
// one OAuthAdapter describing how its platform's OAuth (or app-password) flow works, and the kit's
// shared server + resolver drive it.

import type { ConnAccount } from './registry.js';

// oauth2          standard authorization-code grant (LinkedIn, Facebook, Instagram, Threads).
// oauth2_pkce     authorization-code + PKCE S256 (X / Twitter).
// dynamic_app     no operator-supplied client; the kit registers an app per host (Mastodon).
// app_password    no OAuth at all; the user pastes a handle + app password (Bluesky). These plugins
//                 do not run the kit OAuth server; the resolver returns the stored password.
export type OAuthFlavor = 'oauth2' | 'oauth2_pkce' | 'dynamic_app' | 'app_password';

export interface AdapterEndpoints {
  authUrl: string;
  tokenUrl: string;
}

export interface AdapterIdentity {
  handle: string; // public handle/username — surfaced to the UI + Charles; never a secret
  id: string; // stable provider account id (used as Charles external_ref when present)
}

export interface OAuthAdapter {
  provider: string; // 'x' | 'mastodon' | 'linkedin' | …
  flavor: OAuthFlavor;
  scopes: string[];
  usesRefresh: boolean; // true => a durable refresh token is stored and used to mint access tokens
  // Cache the minted access token (+ expiry) in the vault between calls. Default true.
  cacheAccessToken?: boolean;
  // Fail the connect when the platform returns no refresh_token (Google issues one only on first
  // consent — better to error than to silently connect an account that can't refresh).
  requireRefreshOnConnect?: boolean;
  // How the client credentials are presented to the token endpoint. 'body' (default) sends
  // client_id/client_secret as form fields; 'basic' sends an HTTP Basic Authorization header
  // (X / Twitter confidential clients require this).
  tokenAuthStyle?: 'body' | 'basic';
  // Resolve the platform endpoints. `host` is set only for per-host (dynamic_app) providers.
  endpoints(host?: string): AdapterEndpoints;
  // Who did we just connect? Probe the platform with a fresh access token. `opts.host` is the instance
  // (dynamic_app); `opts.type` is the per-connection type (e.g. LinkedIn 'member' vs 'organization'),
  // so a provider can probe the right endpoint for that connection kind.
  fetchIdentity(accessToken: string, opts?: { host?: string; type?: string; target?: string }): Promise<AdapterIdentity>;
  // Connection types this provider offers (rendered as a picker on connect; stored in metadata.type).
  // Absent => a single default connection kind.
  connectionTypes?: Array<{ value: string; label: string }>;
  // Optional: after connecting, enumerate the sub-targets this token can act as (e.g. the LinkedIn
  // Pages/organizations the member administers) so the operator can pick one per connection — instead
  // of typing an id. Returns [{ id, label }] where id is the canonical target (e.g. an org URN).
  listTargets?(accessToken: string): Promise<Array<{ id: string; label: string }>>;
  // dynamic_app only: register (or look up) an app on the given instance and return its client.
  registerApp?(host: string, redirectUri: string): Promise<{ clientId: string; clientSecret: string }>;
  // Optional: a live "test this connection" probe (the kit's /test endpoint calls it). Given a freshly
  // resolved access token + the account, confirm the credential actually works and report the handle.
  // When absent, the kit falls back to fetchIdentity (ok if it returns a handle/id). app_password
  // adapters (bluesky) override this to mint a session, since fetchIdentity can't.
  testConnection?(args: { accessToken: string; account: ConnAccount }): Promise<{ ok: boolean; handle?: string; error?: string }>;
  // Extra params to append to the authorize URL (e.g. Google's access_type/prompt). Optional.
  extraAuthParams?: Record<string, string>;
}
