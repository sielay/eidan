// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `google` plugin — read the operator's Gmail.
//
// Per-account OAuth (on the shared connections kit): the operator connects one or more Gmail accounts
// in the Connections screen. Each account's OAuth client id/secret (sealed as JSON under
// `client_vault_key`) and durable refresh token (under `refresh_vault_key`) live in the vault; the
// registry rows live in plugin_google.accounts. At call time the tools pick the requested account (or
// the first), mint/refresh a short-lived access token via the kit, then call the Gmail API. Falls back
// to the legacy single EIDAN_GOOGLE_* env/secret keys when no account is registered, so older setups
// keep working. Read-only; nothing stored beyond the registry.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import {
  type AccountStore,
  type SealFn,
  AccountResolveError,
  NotConnectedError,
  parseClient,
  resolveAccessToken,
} from '@eidandev/connections-kit';
import { GmailClient } from './gmail.js';
import { OAuthError, refreshAccessToken } from './oauth.js';
import { secretOpt } from './vault.js';
import { googleAdapter } from './adapter.js';

const ACCOUNT_PROP = {
  account: {
    type: 'string',
    description: 'Which connected Gmail account (name or slug). Omit to use the first connected account.',
  },
} as const;

const LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max messages (default 20).' },
    query: { type: 'string', description: "Gmail search query, e.g. 'from:alice is:unread'." },
    ...ACCOUNT_PROP,
  },
};
const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message_id'],
  properties: {
    message_id: { type: 'string', minLength: 1, description: 'Gmail message id from gmail_list_recent.' },
    ...ACCOUNT_PROP,
  },
};

export interface OAuthCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

// Resolve the first connected account's vaulted client + refresh token from the kit registry, or null
// when none resolves. No legacy fallback, no throw — this is the shape exposed to other plugins
// (e.g. gdrive) as the GoogleConnection service so a single connected account serves them all.
export async function resolveFromRegistry(store: AccountStore, ctx: ToolContext): Promise<OAuthCreds | null> {
  for (const row of await store.listAccounts()) {
    try {
      const clientRaw = await ctx.vault.resolve('${' + row.client_vault_key + '}');
      const refreshToken = await ctx.vault.resolve('${' + row.refresh_vault_key + '}');
      const client = parseClient(String(clientRaw ?? ''));
      if (client && refreshToken && refreshToken.trim()) {
        return { ...client, refreshToken: refreshToken.trim() };
      }
    } catch {
      // An account whose secret was removed out-of-band — try the next rather than fail the call.
    }
  }
  return null;
}

// Resolve a usable Gmail access token for the selected account: kit registry first (transparent
// refresh + re-seal of the short-lived access token), then the legacy single EIDAN_GOOGLE_* keys.
// Returns an error string when nothing usable resolves.
async function resolveAccessTokenFor(
  ctx: ToolContext,
  store: AccountStore | null,
  seal: SealFn | undefined,
  account: string | undefined,
): Promise<{ token?: string; error?: string }> {
  if (store) {
    try {
      const { accessToken } = await resolveAccessToken(store, googleAdapter, ctx, {
        ...(account ? { accountSelector: account } : {}),
        ...(seal ? { seal } : {}),
      });
      return { token: accessToken };
    } catch (exc) {
      if (exc instanceof AccountResolveError) return { error: exc.message };
      if (!(exc instanceof NotConnectedError)) {
        return { error: exc instanceof Error ? exc.message : 'failed to resolve Google account' };
      }
      // NotConnectedError → fall through to the legacy single-secret path.
    }
  }
  const clientId = await secretOpt(ctx, 'EIDAN_GOOGLE_CLIENT_ID');
  const clientSecret = await secretOpt(ctx, 'EIDAN_GOOGLE_CLIENT_SECRET');
  const refreshToken = await secretOpt(ctx, 'EIDAN_GOOGLE_REFRESH_TOKEN');
  if (clientId && clientSecret && refreshToken) {
    try {
      return { token: await refreshAccessToken({ clientId, clientSecret, refreshToken }) };
    } catch (exc) {
      return { error: `Google token refresh failed: ${exc instanceof Error ? exc.message : String(exc)}` };
    }
  }
  return {
    error:
      "Google isn't connected — add a Gmail account under Connections (or set EIDAN_GOOGLE_CLIENT_ID, " +
      'EIDAN_GOOGLE_CLIENT_SECRET and EIDAN_GOOGLE_REFRESH_TOKEN).',
  };
}

export function makeGmailTools(store: AccountStore | null, seal?: SealFn): Tool[] {
  const gmailListRecentTool: Tool = {
    name: 'gmail_list_recent',
    description:
      'List recent Gmail messages (id, from, subject, date, snippet), optionally filtered by a ' +
      "Gmail search query. Use to see the operator's mail before reading. Use `account` to pick which connected Gmail account.",
    inputSchema: LIST_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { limit?: number; query?: string; account?: string };
        const { token, error } = await resolveAccessTokenFor(ctx, store, seal, args.account);
        if (!token) {
          yield { type: 'error', message: error ?? 'Failed to resolve Google access token' };
          return;
        }
        const client = new GmailClient(token);
        const query = args.query ? String(args.query).trim() : '';
        const msgs = await client.listRecent(Number(args.limit) || 20, query || undefined);
        yield { type: 'result', value: { messages: msgs } };
      },
    },
  };

  const gmailReadTool: Tool = {
    name: 'gmail_read',
    description: 'Read one Gmail message in full (headers + plain-text body) by id. Use `account` to pick which connected Gmail account.',
    inputSchema: READ_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { message_id?: string; account?: string };
        const messageId = String(args.message_id ?? '').trim();
        if (!messageId) {
          yield { type: 'error', message: 'message_id is required' };
          return;
        }
        const { token, error } = await resolveAccessTokenFor(ctx, store, seal, args.account);
        if (!token) {
          yield { type: 'error', message: error ?? 'Failed to resolve Google access token' };
          return;
        }
        const msg = await new GmailClient(token).read(messageId);
        yield {
          type: 'result',
          value: {
            id: msg.id,
            from: msg.from,
            to: msg.to,
            subject: msg.subject,
            date: msg.date,
            body: msg.body.slice(0, 8000),
          },
        };
      },
    },
  };

  return [gmailListRecentTool, gmailReadTool];
}
