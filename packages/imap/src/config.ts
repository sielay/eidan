// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-account credential resolution for the `imap` plugin. Mirrors iCal's resolve+legacy-fallback:
// the operator's named accounts live in plugin_imap.accounts (non-secret connection fields in plain
// columns; passwords sealed in the vault under each account's pass key). At call time we list the
// caller's accounts, pick the requested one (or the first), and resolve only the password(s) from
// the vault. When no account is registered we fall back to the legacy single env account
// (EIDAN_IMAP_* / EIDAN_SMTP_*) so older single-operator installs keep working.
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { type ImapConfig, ImapError } from './client.js';
import { MailSendError, type SmtpConfig } from './sender.js';
import type { AccountRow, Db } from './db.js';
import { secret, secretOpt } from './vault.js';

// Stable slug → vault-key derivation, shared with the admin data route so registry rows and sealed
// secrets agree. Same shape as iCal's slugify.
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return s || 'account';
}

export function imapPassKey(slug: string): string {
  return `EIDAN_IMAP_PASS_${slug}`;
}

export function smtpPassKey(slug: string): string {
  return `EIDAN_SMTP_PASS_${slug}`;
}

// Choose the account the call targets: by name/slug match when given, else the first (oldest).
export function pickAccount(rows: AccountRow[], wanted: string | undefined): AccountRow | undefined {
  if (rows.length === 0) return undefined;
  const want = (wanted ?? '').trim();
  if (!want) return rows[0];
  const slug = slugify(want);
  return rows.find((r) => r.slug === slug || r.name.toLowerCase() === want.toLowerCase()) ?? undefined;
}

function port(value: string | undefined, fallback: number): number {
  return value && /^\d+$/.test(value) ? Number(value) : fallback;
}

// Resolve the IMAP config for a call: a named/registered account (password from the vault), or the
// legacy env account when none is registered. `account` selects among multiple named accounts.
export async function resolveImapConfig(
  db: Db,
  ctx: ToolContext,
  account: string | undefined,
): Promise<ImapConfig> {
  const rows = await db.listAccounts();
  if (rows.length > 0) {
    const row = pickAccount(rows, account);
    if (!row) {
      throw new ImapError(
        `No mail account named "${account}" — add it under Integrations → Mail, or omit the name.`,
      );
    }
    const pass = await secretOpt(ctx, row.imap_pass_key);
    if (!pass) {
      throw new ImapError(
        `The password for "${row.name}" isn't in the vault — re-add the account under Integrations → Mail.`,
      );
    }
    return { host: row.imap_host, port: row.imap_port, user: row.imap_user, pass };
  }

  // Legacy single-account env fallback (no accounts registered).
  const host = await secretOpt(ctx, 'EIDAN_IMAP_HOST');
  const user = await secretOpt(ctx, 'EIDAN_IMAP_USERNAME');
  const pass = await secretOpt(ctx, 'EIDAN_IMAP_PASSWORD');
  if (!host || !user || !pass) {
    throw new ImapError(
      "No mail account configured — add one under Integrations → Mail (IMAP host, username and " +
        'password), or set EIDAN_IMAP_HOST / EIDAN_IMAP_USERNAME / EIDAN_IMAP_PASSWORD.',
    );
  }
  return { host, port: port(await secretOpt(ctx, 'EIDAN_IMAP_PORT'), 993), user, pass };
}

// Resolve the SMTP config for a call (named/registered account, or the legacy env account).
export async function resolveSmtpConfig(
  db: Db,
  ctx: ToolContext,
  account: string | undefined,
): Promise<SmtpConfig> {
  const rows = await db.listAccounts();
  if (rows.length > 0) {
    const row = pickAccount(rows, account);
    if (!row) {
      throw new MailSendError(
        `No mail account named "${account}" — add it under Integrations → Mail, or omit the name.`,
      );
    }
    if (!row.smtp_host) {
      throw new MailSendError(`"${row.name}" has no SMTP host set — edit it under Integrations → Mail to send mail.`);
    }
    // SMTP password is optional only when it shares the IMAP credentials would be surprising; we
    // seal an explicit SMTP password per account, so require it for send.
    const pass = await secretOpt(ctx, row.smtp_pass_key);
    if (!pass) {
      throw new MailSendError(
        `The SMTP password for "${row.name}" isn't in the vault — re-add the account under Integrations → Mail.`,
      );
    }
    return {
      host: row.smtp_host,
      port: row.smtp_port,
      user: row.smtp_user || row.imap_user,
      pass,
      from: row.smtp_from || row.smtp_user || row.imap_user,
    };
  }

  // Legacy single-account env fallback.
  const host = await secretOpt(ctx, 'EIDAN_SMTP_HOST');
  const user = await secretOpt(ctx, 'EIDAN_SMTP_USERNAME');
  const pass = await secretOpt(ctx, 'EIDAN_SMTP_PASSWORD');
  if (!host || !user || !pass) {
    throw new MailSendError(
      "No mail account configured for sending — add one under Integrations → Mail (with SMTP host, " +
        'username and password), or set EIDAN_SMTP_HOST / EIDAN_SMTP_USERNAME / EIDAN_SMTP_PASSWORD.',
    );
  }
  const from = (await secretOpt(ctx, 'EIDAN_SMTP_FROM')) ?? user;
  return { host, port: port(await secretOpt(ctx, 'EIDAN_SMTP_PORT'), 587), user, pass, from };
}

// Re-exported so callers needn't reach into ./vault directly.
export { secret, secretOpt };
