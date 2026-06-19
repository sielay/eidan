// SPDX-License-Identifier: AGPL-3.0-or-later
// Server-side Google OAuth reconnect helper for the eidan `google` plugin. The web is a
// write-only vault client: it can seal an OAuth client into the vault but can never read it back, so
// it cannot rebuild the consent URL or exchange the auth code on a reconnect. The ENGINE can read the
// vault. This small authenticated HTTP server (pattern mirrors core's @eidandev/secrets-api) exposes
// two endpoints behind the AG-UI panel-proxy so the web can reconnect a Gmail account WITHOUT the
// operator re-entering their client id/secret. Every request runs under the caller's Principal
// (per-user scoping) resolved from the request — the vault read, the account lookup, and the secret
// write are all owner-scoped.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatbotServices, Principal } from '@matatbread/matbot-plugin-api';
import { runAs } from '@matatbread/matbot-plugin-api';
import type { Db } from './db.js';
import { buildAuthUrl, exchangeCode, fetchEmail, GMAIL_SCOPES, OAuthError } from './oauth.js';

// The matbot decoupling idiom (string keys match at runtime): re-declare only the services this file
// consumes, so the bundle needs no hard dep on core's concrete implementations.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    PanelProxy?: { register(r: { prefix: string; port: number }): void };
    EidanSecrets?: {
      declareSection(section: { plugin: string; title: string; fields: { name: string; label: string; secret?: boolean; required?: boolean; help?: string }[] }): void;
      setSecret(name: string, value: string): Promise<void>;
    };
    WebPrincipalResolver?: (req: IncomingMessage) => Principal | Promise<Principal>;
  }
}

export interface GoogleOAuthOpts {
  port: number;
}

const PREFIX = '/api/me/google/oauth';

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

// Parse the JSON-packed { client_id, client_secret } sealed under an account's client_vault_key.
function parseClient(raw: string): { clientId: string; clientSecret: string } | null {
  try {
    const j = JSON.parse(raw) as { client_id?: string; client_secret?: string };
    if (j.client_id && j.client_secret) return { clientId: j.client_id, clientSecret: j.client_secret };
  } catch {
    // not JSON
  }
  return null;
}

interface StartBody {
  account_id?: unknown;
  redirect_uri?: unknown;
}
interface FinishBody {
  code?: unknown;
  state?: unknown;
  redirect_uri?: unknown;
}

async function handleStart(req: IncomingMessage, res: ServerResponse, services: MatbotServices, db: Db): Promise<void> {
  let body: StartBody;
  try {
    body = JSON.parse(await readBody(req)) as StartBody;
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

  const row = await db.getAccountById(accountId);
  if (!row) {
    send(res, 404, { error: 'account not found' });
    return;
  }

  const vault = services.vault;
  let client: { clientId: string; clientSecret: string } | null;
  try {
    const raw = await vault.resolve('${' + row.client_vault_key + '}');
    client = parseClient(String(raw ?? ''));
  } catch {
    client = null;
  }
  if (!client) {
    send(res, 502, { error: 'could not read the sealed OAuth client for this account' });
    return;
  }

  await db.setPending(accountId);

  const authUrl = buildAuthUrl({
    clientId: client.clientId,
    redirectUri: redirectUri,
    scopes: GMAIL_SCOPES,
    state: accountId,
  });
  send(res, 200, { auth_url: authUrl });
}

async function handleFinish(req: IncomingMessage, res: ServerResponse, services: MatbotServices, db: Db): Promise<void> {
  let body: FinishBody;
  try {
    body = JSON.parse(await readBody(req)) as FinishBody;
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

  const row = await db.getAccountById(state);
  if (!row) {
    send(res, 404, { error: 'account not found' });
    return;
  }

  const vault = services.vault;
  let client: { clientId: string; clientSecret: string } | null;
  try {
    const raw = await vault.resolve('${' + row.client_vault_key + '}');
    client = parseClient(String(raw ?? ''));
  } catch {
    client = null;
  }
  if (!client) {
    send(res, 502, { error: 'could not read the sealed OAuth client for this account' });
    return;
  }

  let tok: { refreshToken: string; accessToken: string };
  try {
    tok = await exchangeCode({
      code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: redirectUri,
    });
  } catch (exc) {
    send(res, 502, { error: exc instanceof OAuthError ? exc.message : 'code exchange failed' });
    return;
  }
  if (!tok.refreshToken) {
    send(res, 502, {
      error:
        'Google returned no refresh_token — revoke the app under your Google account and reconnect ' +
        '(a refresh token is only issued on first consent).',
    });
    return;
  }

  const secrets = services.EidanSecrets;
  if (!secrets) {
    send(res, 503, { error: 'secrets service unavailable' });
    return;
  }
  await secrets.setSecret(row.refresh_vault_key, tok.refreshToken);

  const email = await fetchEmail(tok.accessToken);
  await db.setActive(row.id, email);
  send(res, 200, { ok: true, email });
}

async function handle(req: IncomingMessage, res: ServerResponse, services: MatbotServices, db: Db): Promise<void> {
  const method = req.method ?? 'GET';
  const path = (req.url ?? '').split('?')[0] ?? '';

  if (method !== 'POST' || (path !== PREFIX + '/start' && path !== PREFIX + '/finish')) {
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
    if (path === PREFIX + '/start') return handleStart(req, res, services, db);
    return handleFinish(req, res, services, db);
  });
}

export function startGoogleOAuthServer(services: MatbotServices, db: Db, opts: GoogleOAuthOpts): () => void {
  const server = createServer((req, res) => {
    void handle(req, res, services, db).catch((e: unknown) => {
      if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  });
  server.listen(opts.port);
  services.PanelProxy?.register({ prefix: PREFIX, port: opts.port });
  return () => server.close();
}
