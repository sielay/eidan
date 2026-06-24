// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine-side import server for charles-domains. The web's vault client is write-only — it can SEAL a
// registrar's API key but never read it back — yet the registrar API calls need the decrypted key. So
// import runs HERE, on the engine, behind PanelProxy, under the caller's principal (RLS-scoped). This
// mirrors the @eidandev/connections-kit oauth-server pattern.
//   POST <prefix>/import  { account_id }  → { imported, updated } | { error }
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { runAs, type MatbotServices, type Principal } from '@matatbread/matbot-plugin-api';

import type { DomainsDb } from './db.js';
import { getAdapter } from './registrars.js';

export interface ImportServerOpts {
  port: number;
  prefix: string; // e.g. '/api/me/charles-domains'
}

// The slice of MatbotServices this server needs. Cast locally (rather than a global module
// augmentation) so the package stays self-contained.
interface ImportServices {
  vault?: { resolve(ref: string): Promise<string | null | undefined> };
  WebPrincipalResolver?: (req: IncomingMessage) => Principal | Promise<Principal>;
  PanelProxy?: { register(r: { prefix: string; port: number }): void };
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

// Read the sealed key, call the registrar adapter, upsert each domain. Runs inside runAs(principal),
// so the DomainsDb methods (tryCurrentPrincipal) are scoped to the caller.
async function runImport(
  svc: ImportServices,
  db: DomainsDb,
  accountId: string,
): Promise<{ imported: number; updated: number } | { error: string }> {
  const account = await db.getRegistrarAccount(accountId);
  if (!account) return { error: 'account not found' };
  if (!svc.vault) return { error: 'vault unavailable' };

  let creds: { key: string; secret: string };
  try {
    const sealed = await svc.vault.resolve('${' + account.key_vault_key + '}');
    creds = JSON.parse(String(sealed ?? '{}')) as { key: string; secret: string };
    if (!creds.key || !creds.secret) throw new Error('invalid credentials');
  } catch {
    return { error: 'could not retrieve credentials from vault' };
  }

  const adapter = getAdapter(account.registrar);
  if (!adapter) return { error: `no adapter for registrar ${account.registrar}` };

  let records;
  try {
    records = await adapter.listDomains(creds);
  } catch (e) {
    return { error: `could not fetch domains: ${e instanceof Error ? e.message : String(e)}` };
  }

  const existing = new Set((await db.listDomains('active')).map((d) => d.name.toLowerCase()));
  let imported = 0;
  let updated = 0;
  for (const rec of records) {
    const isNew = !existing.has(rec.name.toLowerCase());
    await db.upsertDomain({
      registrar: account.registrar,
      name: rec.name,
      externalId: rec.externalId,
      registrarAccountId: account.id,
      expiresAt: rec.expiresAt ?? undefined,
      autoRenew: rec.autoRenew ?? undefined,
      nameservers: rec.nameservers ?? undefined,
    });
    if (isNew) imported++;
    else updated++;
  }
  return { imported, updated };
}

export function startImportServer(services: MatbotServices, db: DomainsDb, opts: ImportServerOpts): () => void {
  const svc = services as unknown as ImportServices;
  const route = opts.prefix + '/import';

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.method ?? 'GET') !== 'POST' || ((req.url ?? '').split('?')[0] ?? '') !== route) {
      send(res, 404, { error: 'not found' });
      return;
    }
    const resolver = svc.WebPrincipalResolver;
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
    const body = await readBody(req);
    let accountId = '';
    try {
      accountId = String((JSON.parse(body || '{}') as Record<string, unknown>)['account_id'] ?? '').trim();
    } catch {
      /* empty/invalid body → handled below */
    }
    if (!accountId) {
      send(res, 400, { error: 'account_id is required' });
      return;
    }
    await runAs(principal, async () => {
      const result = await runImport(svc, db, accountId);
      send(res, 'error' in result ? 400 : 200, result);
    });
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  });
  server.listen(opts.port);
  svc.PanelProxy?.register({ prefix: opts.prefix, port: opts.port });
  return () => server.close();
}
