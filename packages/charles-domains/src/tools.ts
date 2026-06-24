// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotTool, ToolContext } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type { DomainsDb } from './db.js';
import { getAdapter } from './registrars.js';

export function buildDomainsTools(db: DomainsDb): MatbotTool[] {
  return [
    {
      name: 'domains_list',
      description: 'List the user\'s registered domains (status: active)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'archived'],
            description: 'Filter by status (default: active)',
          },
        },
      },
      execute: async (input: unknown) => {
        const domains = await db.listDomains(
          typeof input === 'object' && input !== null && 'status' in input ? String(input.status) : 'active',
        );
        return {
          domains: domains.map((d) => ({
            id: d.id,
            name: d.name,
            registrar: d.registrar,
            status: d.status,
            expires_at: d.expires_at,
            auto_renew: d.auto_renew,
          })),
        };
      },
    },
    {
      name: 'domain_add',
      description: 'Register a new domain manually or add a manual entry',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Domain name (e.g., example.com)' },
          registrar: {
            type: 'string',
            enum: ['manual', 'godaddy', 'cyberfolks'],
            description: 'Registrar (default: manual)',
          },
          expires_at: { type: 'string', description: 'Expiration date (ISO 8601)' },
          auto_renew: { type: 'boolean', description: 'Auto-renew enabled' },
        },
        required: ['name'],
      },
      execute: async (input: unknown) => {
        const inp = input as Record<string, unknown>;
        const name = String(inp['name'] ?? '').trim();
        if (!name) return { error: 'domain name is required' };
        const registrar = String(inp['registrar'] ?? 'manual');
        const expiresAt = inp['expires_at'] ? new Date(String(inp['expires_at'])) : null;
        const autoRenew = inp['auto_renew'] ? Boolean(inp['auto_renew']) : null;

        try {
          const domain = await db.insertDomain({
            registrar,
            name,
            ...(expiresAt ? { expiresAt } : {}),
            ...(autoRenew !== null ? { autoRenew } : {}),
          });
          return { ok: true, domain };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/duplicate key|unique/i.test(msg)) {
            return { error: 'domain already exists' };
          }
          return { error: msg };
        }
      },
    },
    {
      name: 'domain_update',
      description: 'Update a domain record (expiration, auto-renew, status)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Domain ID' },
          expires_at: { type: 'string', description: 'Expiration date (ISO 8601)' },
          auto_renew: { type: 'boolean', description: 'Auto-renew enabled' },
          status: { type: 'string', enum: ['active', 'archived'] },
        },
        required: ['id'],
      },
      execute: async (input: unknown) => {
        const inp = input as Record<string, unknown>;
        const id = String(inp['id'] ?? '').trim();
        if (!id) return { error: 'domain id is required' };

        const updateFields: { expiresAt?: Date | null; autoRenew?: boolean | null; status?: string } = {};
        if (inp['expires_at']) updateFields.expiresAt = new Date(String(inp['expires_at']));
        if (inp['expires_at'] === null) updateFields.expiresAt = null;
        if (inp['auto_renew'] !== undefined) updateFields.autoRenew = Boolean(inp['auto_renew']);
        if (inp['status'] !== undefined) updateFields.status = String(inp['status']);

        await db.updateDomain(id, updateFields);
        return { ok: true };
      },
    },
    {
      name: 'domain_archive',
      description: 'Archive a domain (soft delete)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Domain ID' },
        },
        required: ['id'],
      },
      execute: async (input: unknown) => {
        const inp = input as Record<string, unknown>;
        const id = String(inp['id'] ?? '').trim();
        if (!id) return { error: 'domain id is required' };
        await db.archiveDomain(id);
        return { ok: true };
      },
    },
    {
      name: 'registrar_accounts_list',
      description: 'List connected registrar accounts',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
      execute: async () => {
        const accounts = await db.listRegistrarAccounts();
        return {
          accounts: accounts.map((a) => ({
            id: a.id,
            registrar: a.registrar,
            name: a.name,
          })),
        };
      },
    },
    {
      name: 'registrar_connect',
      description: 'Connect a registrar account (seals credentials in vault)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          registrar: { type: 'string', enum: ['godaddy', 'cyberfolks'] },
          name: { type: 'string', description: 'Account name/label' },
          api_key: { type: 'string', description: 'API key' },
          api_secret: { type: 'string', description: 'API secret' },
        },
        required: ['registrar', 'name', 'api_key', 'api_secret'],
      },
      execute: async (input: unknown, ctx?: ToolContext) => {
        const inp = input as Record<string, unknown>;
        const registrar = String(inp['registrar'] ?? '').trim();
        const name = String(inp['name'] ?? '').trim();
        const apiKey = String(inp['api_key'] ?? '').trim();
        const apiSecret = String(inp['api_secret'] ?? '').trim();

        if (!registrar || !name || !apiKey || !apiSecret) {
          return { error: 'registrar, name, api_key, and api_secret are required' };
        }

        const p = tryCurrentPrincipal();
        if (!p) return { error: 'no principal' };

        const vaultKey = `EIDAN_DOMAINS_${registrar.toUpperCase()}_${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
        const creds = JSON.stringify({ key: apiKey, secret: apiSecret });

        try {
          if (ctx?.vault) {
            await ctx.vault.seal(vaultKey, creds);
          }
          const account = await db.insertRegistrarAccount(registrar, name, vaultKey);
          return { ok: true, account: { id: account.id, registrar: account.registrar, name: account.name } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/duplicate key|unique/i.test(msg)) {
            return { error: 'account name already exists for this registrar' };
          }
          return { error: msg };
        }
      },
    },
    {
      name: 'registrar_test',
      description: 'Test a registrar connection by listing one domain',
      inputSchema: {
        type: 'object' as const,
        properties: {
          account_id: { type: 'string', description: 'Registrar account ID' },
        },
        required: ['account_id'],
      },
      execute: async (input: unknown, ctx?: ToolContext) => {
        const inp = input as Record<string, unknown>;
        const accountId = String(inp['account_id'] ?? '').trim();
        if (!accountId) return { error: 'account_id is required' };

        const account = await db.getRegistrarAccount(accountId);
        if (!account) return { error: 'account not found' };

        if (!ctx?.vault) return { error: 'vault unavailable' };

        let creds: { key: string; secret: string };
        try {
          const sealed = await ctx.vault.resolve('${' + account.key_vault_key + '}');
          creds = JSON.parse(String(sealed ?? '{}'));
          if (!creds.key || !creds.secret) throw new Error('invalid credentials');
        } catch (err) {
          return { error: 'could not retrieve credentials from vault' };
        }

        const adapter = getAdapter(account.registrar);
        if (!adapter) return { error: `no adapter for registrar ${account.registrar}` };

        try {
          const domains = await adapter.listDomains(creds);
          return { ok: true, domain_count: domains.length };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `connection test failed: ${msg}` };
        }
      },
    },
    {
      name: 'domain_import',
      description: 'Import domains from a registrar account and upsert them',
      inputSchema: {
        type: 'object' as const,
        properties: {
          account_id: { type: 'string', description: 'Registrar account ID' },
        },
        required: ['account_id'],
      },
      execute: async (input: unknown, ctx?: ToolContext) => {
        const inp = input as Record<string, unknown>;
        const accountId = String(inp['account_id'] ?? '').trim();
        if (!accountId) return { error: 'account_id is required' };

        const account = await db.getRegistrarAccount(accountId);
        if (!account) return { error: 'account not found' };

        if (!ctx?.vault) return { error: 'vault unavailable' };

        let creds: { key: string; secret: string };
        try {
          const sealed = await ctx.vault.resolve('${' + account.key_vault_key + '}');
          creds = JSON.parse(String(sealed ?? '{}'));
          if (!creds.key || !creds.secret) throw new Error('invalid credentials');
        } catch (err) {
          return { error: 'could not retrieve credentials from vault' };
        }

        const adapter = getAdapter(account.registrar);
        if (!adapter) return { error: `no adapter for registrar ${account.registrar}` };

        let domains: Array<{ name: string; externalId?: string; expiresAt: Date | null; autoRenew: boolean | null; nameservers: string[] | null }>;
        try {
          domains = await adapter.listDomains(creds);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `could not fetch domains: ${msg}` };
        }

        let imported = 0;
        let updated = 0;
        for (const domain of domains) {
          const existing = await db.listDomains('active').then((all) =>
            all.find((d) => d.name.toLowerCase() === domain.name.toLowerCase()),
          );
          try {
            const upsertFields: {
              registrar: string;
              name: string;
              externalId?: string;
              registrarAccountId?: string;
              expiresAt?: Date;
              autoRenew?: boolean;
              nameservers?: string[];
            } = {
              registrar: account.registrar,
              name: domain.name,
            };
            if (domain.externalId) upsertFields.externalId = domain.externalId;
            if (accountId) upsertFields.registrarAccountId = accountId;
            if (domain.expiresAt) upsertFields.expiresAt = domain.expiresAt;
            if (domain.autoRenew !== null) upsertFields.autoRenew = domain.autoRenew;
            if (domain.nameservers) upsertFields.nameservers = domain.nameservers;
            await db.upsertDomain(upsertFields);
            if (existing) updated++;
            else imported++;
          } catch (err) {
            console.error(`failed to upsert domain ${domain.name}:`, err);
          }
        }

        return { ok: true, imported, updated };
      },
    },
  ];
}
