// SPDX-License-Identifier: AGPL-3.0-or-later
// @eidandev/connections-kit — shared engine-side machinery for BYO-client OAuth integrations.
// Engine-side only: the React dashboard is shared separately in apps/web (it imports apps/web
// aliases and is copied per-plugin by the deploy assembly).
export type { OAuthAdapter, OAuthFlavor, AdapterEndpoints, AdapterIdentity } from './adapter.js';
export {
  slugify,
  normalizeHost,
  clientKey,
  tokenKey,
  refreshKey,
  hostAppKey,
  packClient,
  parseClient,
} from './keys.js';
export { Registry } from './registry.js';
export type { ConnAccount, RegistryConfig, AccountStore } from './registry.js';
export {
  OAuthError,
  generatePkce,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
} from './oauth.js';
export type { PkcePair, ExchangedTokens, RefreshedTokens } from './oauth.js';
export { startOAuthServer } from './oauth-server.js';
export type { OAuthServerOpts } from './oauth-server.js';
export {
  resolveAccessToken,
  pickAccount,
  NotConnectedError,
  AccountResolveError,
} from './resolve.js';
export type { ResolvedToken, ResolveOpts, SealFn } from './resolve.js';
export { registerSocialConnection } from './social-connections.js';
export type { SocialConnectionsService, SocialIdentity, ConnectableRef } from './social-connections.js';
export { makeAccountsTool } from './accounts-tool.js';
