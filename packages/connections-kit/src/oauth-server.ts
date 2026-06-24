// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared server-side connect/reconnect OAuth server, parameterised by an OAuthAdapter. The web is a
// write-only vault client: it can seal a client into the vault but can never read it back, so it
// cannot rebuild the consent URL (reconnect), generate/keep a PKCE verifier, or exchange the auth
// code. The engine can. This small authenticated HTTP server (pattern mirrors @eidandev/secrets-api
// and the original google oauth-server) exposes /start and /finish behind the AG-UI panel-proxy, all
// under the caller's Principal (per-user scoping). One instance per OAuth-capable plugin.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatbotServices, Principal, ToolContext } from '@matatbread/matbot-plugin-api';
import { runAs } from '@matatbread/matbot-plugin-api';
import type { OAuthAdapter } from './adapter.js';
import type { Registry } from './registry.js';
import { hostAppKey, packClient, parseClient } from './keys.js';
import { buildAuthUrl, exchangeCode, generatePkce, OAuthError } from './oauth.js';
import { resolveAccessToken, AccountResolveError, type SealFn } from './resolve.js';

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    PanelProxy?: { register(r: { prefix: string; port: number }): void };
    // Declared with the full eidan shape (declareSection + setSecret) so this augmentation merges
    // identically with the plugins' own EidanSecrets augmentations. The server only uses setSecret.
    EidanSecrets?: {
      declareSection(section: {
        plugin: string;
        title: string;
        fields: { name: string; label: string; secret?: boolean; required?: boolean; help?: string }[];
      }): void;
      setSecret(name: string, value: string): Promise<void>;
    };
    WebPrincipalResolver?: (req: IncomingMessage) => Principal | Promise<Principal>;
  }
}

export interface OAuthServerOpts {
  port: number;
  prefix: string; // e.g. '/api/me/social-x/oauth'
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Resolve the OAuth client for an account, registering a per-host app on demand (dynamic_app).
async function resolveClient(
  services: MatbotServices,
  registry: Registry,
  adapter: OAuthAdapter,
  account: { client_vault_key: string; host: string },
  redirectUri: string,
): Promise<{ clientId: string; clientSecret: string; scopes?: string[] } | null> {
  let raw = '';
  try {
    raw = String((await services.vault.resolve('${' + account.client_vault_key + '}')) ?? '');
  } catch {
    raw = '';
  }
  let client = parseClient(raw);
  if (!client && adapter.flavor === 'dynamic_app' && adapter.registerApp && account.host) {
    const reg = await adapter.registerApp(account.host, redirectUri);
    const key = hostAppKey(adapter.provider, account.host);
    await services.EidanSecrets?.setSecret(key, packClient(reg));
    await registry.putHostApp(account.host, key);
    client = reg;
  }
  return client;
}

async function handleStart(
  req: IncomingMessage,
  res: ServerResponse,
  services: MatbotServices,
  registry: Registry,
  adapter: OAuthAdapter,
): Promise<void> {
  let body: { account_id?: unknown; redirect_uri?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as typeof body;
  } catch {
    send(res, 400, { error: 'body must be JSON { account_id, redirect_uri }' });
    return;
  }
  const accountId = typeof body.account_id === 'string' ? body.account_id : '';
  const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
  if (!accountId || !redirectUri) {
    send(res, 400, { error: 'account_id and redirect_uri are required' });
    return;
  }

  const account = await registry.getAccountById(accountId);
  if (!account) {
    send(res, 404, { error: 'account not found' });
    return;
  }

  const client = await resolveClient(services, registry, adapter, account, redirectUri);
  if (!client) {
    send(res, 502, { error: 'could not read or register the OAuth client for this account' });
    return;
  }

  const pkce = adapter.flavor === 'oauth2_pkce' ? generatePkce() : undefined;
  await registry.setPending(accountId, {
    metadata: { redirect_uri: redirectUri, ...(pkce ? { pkce_verifier: pkce.verifier } : {}) },
  });

  const authUrl = buildAuthUrl({
    adapter,
    clientId: client.clientId,
    redirectUri,
    state: accountId,
    ...(account.host ? { host: account.host } : {}),
    ...(pkce ? { codeChallenge: pkce.challenge } : {}),
    ...(client.scopes ? { scopes: client.scopes } : {}),
  });
  send(res, 200, { auth_url: authUrl });
}

async function handleFinish(
  req: IncomingMessage,
  res: ServerResponse,
  services: MatbotServices,
  registry: Registry,
  adapter: OAuthAdapter,
): Promise<void> {
  let body: { code?: unknown; state?: unknown; redirect_uri?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as typeof body;
  } catch {
    send(res, 400, { error: 'body must be JSON { code, state, redirect_uri }' });
    return;
  }
  const code = typeof body.code === 'string' ? body.code : '';
  const state = typeof body.state === 'string' ? body.state : '';
  const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
  if (!code || !state || !redirectUri) {
    send(res, 400, { error: 'code, state and redirect_uri are required' });
    return;
  }

  const account = await registry.getAccountById(state);
  if (!account) {
    send(res, 404, { error: 'account not found' });
    return;
  }
  const client = await resolveClient(services, registry, adapter, account, redirectUri);
  if (!client) {
    send(res, 502, { error: 'could not read the OAuth client for this account' });
    return;
  }

  const verifier = typeof account.metadata['pkce_verifier'] === 'string' ? account.metadata['pkce_verifier'] : '';
  let tok;
  try {
    tok = await exchangeCode({
      adapter,
      code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri,
      ...(account.host ? { host: account.host } : {}),
      ...(verifier ? { codeVerifier: verifier } : {}),
    });
  } catch (exc) {
    // A revoked per-host app surfaces here; drop the cache so the next connect re-registers.
    if (adapter.flavor === 'dynamic_app' && account.host) await registry.deleteHostApp(account.host).catch(() => {});
    send(res, 502, { error: exc instanceof OAuthError ? exc.message : 'code exchange failed' });
    return;
  }

  if (adapter.usesRefresh && adapter.requireRefreshOnConnect && !tok.refreshToken) {
    send(res, 502, {
      error:
        'the provider returned no refresh_token — revoke the app under your provider account and ' +
        'reconnect (a refresh token is only issued on first consent).',
    });
    return;
  }

  const secrets = services.EidanSecrets;
  if (!secrets) {
    send(res, 503, { error: 'secrets service unavailable' });
    return;
  }
  if (tok.accessToken) await secrets.setSecret(account.token_vault_key, tok.accessToken);
  if (tok.refreshToken) await secrets.setSecret(account.refresh_vault_key, tok.refreshToken);

  let identity = { handle: '', id: '' };
  try {
    identity = await adapter.fetchIdentity(tok.accessToken, {
      ...(account.host ? { host: account.host } : {}),
      ...(typeof account.metadata['type'] === 'string' ? { type: account.metadata['type'] } : {}),
      ...(typeof account.metadata['target'] === 'string' ? { target: account.metadata['target'] } : {}),
    });
  } catch {
    // identity probe is best-effort; the account still connects
  }
  const expiresAt = tok.expiresIn > 0 ? new Date(Date.now() + tok.expiresIn * 1000) : null;
  await registry.setActive(account.id, {
    external_handle: identity.handle,
    external_id: identity.id,
    token_expires_at: expiresAt,
  });
  send(res, 200, { ok: true, handle: identity.handle });
}

// Live "test this connection" probe: resolve a fresh access token for the account (refreshing if
// needed) and confirm it works — via the adapter's testConnection override, else fetchIdentity.
async function handleTest(
  req: IncomingMessage,
  res: ServerResponse,
  services: MatbotServices,
  registry: Registry,
  adapter: OAuthAdapter,
): Promise<void> {
  let body: { account_id?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as typeof body;
  } catch {
    send(res, 400, { error: 'body must be JSON { account_id }' });
    return;
  }
  const accountId = typeof body.account_id === 'string' ? body.account_id : '';
  if (!accountId) {
    send(res, 400, { error: 'account_id is required' });
    return;
  }
  const account = await registry.getAccountById(accountId);
  if (!account) {
    send(res, 404, { error: 'account not found' });
    return;
  }
  const seal: SealFn | undefined = services.EidanSecrets
    ? (n, v) => services.EidanSecrets!.setSecret(n, v)
    : undefined;
  const ctx = { vault: services.vault } as unknown as ToolContext;
  try {
    const { accessToken } = await resolveAccessToken(registry, adapter, ctx, {
      accountSelector: account.slug,
      ...(seal ? { seal } : {}),
    });
    if (adapter.testConnection) {
      send(res, 200, await adapter.testConnection({ accessToken, account }));
      return;
    }
    const id = await adapter.fetchIdentity(accessToken, {
      ...(account.host ? { host: account.host } : {}),
      ...(typeof account.metadata['type'] === 'string' ? { type: account.metadata['type'] } : {}),
      ...(typeof account.metadata['target'] === 'string' ? { target: account.metadata['target'] } : {}),
    });
    if (id.handle || id.id) send(res, 200, { ok: true, handle: id.handle });
    else send(res, 200, { ok: false, error: 'the token returned no profile — it may be invalid or expired' });
  } catch (exc) {
    const msg =
      exc instanceof AccountResolveError ? exc.message : exc instanceof Error ? exc.message : 'connection test failed';
    send(res, 200, { ok: false, error: msg });
  }
}

// Enumerate the sub-targets this connection's token can act as (e.g. LinkedIn Pages) for a post-connect
// picker. No-op ([]) when the adapter doesn't support targets.
async function handleTargets(
  req: IncomingMessage,
  res: ServerResponse,
  services: MatbotServices,
  registry: Registry,
  adapter: OAuthAdapter,
): Promise<void> {
  let body: { account_id?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as typeof body;
  } catch {
    send(res, 400, { error: 'body must be JSON { account_id }' });
    return;
  }
  const accountId = typeof body.account_id === 'string' ? body.account_id : '';
  if (!accountId) {
    send(res, 400, { error: 'account_id is required' });
    return;
  }
  const account = await registry.getAccountById(accountId);
  if (!account) {
    send(res, 404, { error: 'account not found' });
    return;
  }
  if (!adapter.listTargets) {
    send(res, 200, { targets: [] });
    return;
  }
  const seal: SealFn | undefined = services.EidanSecrets
    ? (n, v) => services.EidanSecrets!.setSecret(n, v)
    : undefined;
  const ctx = { vault: services.vault } as unknown as ToolContext;
  try {
    const { accessToken } = await resolveAccessToken(registry, adapter, ctx, {
      accountSelector: account.slug,
      ...(seal ? { seal } : {}),
    });
    send(res, 200, { targets: await adapter.listTargets(accessToken) });
  } catch (exc) {
    send(res, 200, {
      targets: [],
      error: exc instanceof AccountResolveError ? exc.message : exc instanceof Error ? exc.message : 'failed',
    });
  }
}

export function startOAuthServer(
  services: MatbotServices,
  registry: Registry,
  adapter: OAuthAdapter,
  opts: OAuthServerOpts,
): () => void {
  const routes = new Set([
    opts.prefix + '/start',
    opts.prefix + '/finish',
    opts.prefix + '/test',
    opts.prefix + '/targets',
  ]);
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (method !== 'POST' || !routes.has(path)) {
      send(res, 404, { error: 'not found' });
      return;
    }
    const resolver = services.WebPrincipalResolver;
    if (!resolver) {
      send(res, 503, { error: 'no principal resolver configured' });
      return;
    }
    let principal: Principal;
    try {
      principal = await resolver(req);
    } catch {
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    await runAs(principal, async () => {
      if (path === opts.prefix + '/start') return handleStart(req, res, services, registry, adapter);
      if (path === opts.prefix + '/test') return handleTest(req, res, services, registry, adapter);
      if (path === opts.prefix + '/targets') return handleTargets(req, res, services, registry, adapter);
      return handleFinish(req, res, services, registry, adapter);
    });
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  });
  server.listen(opts.port);
  services.PanelProxy?.register({ prefix: opts.prefix, port: opts.port });
  return () => server.close();
}
