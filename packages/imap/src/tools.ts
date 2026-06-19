// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `imap` plugin — read + send the operator's mail.
//
// Per-user, multi-account: the operator registers named mail accounts in the Integrations → Mail
// screen (IMAP + SMTP host/port/user + password). The non-secret connection fields live in
// plugin_imap.accounts; only the passwords are sealed in the vault. Each tool takes an optional
// `account` name and resolves that account's config per call (falling back to the legacy env
// account when none is registered). Nothing is stored beyond the registry — mail is read live.
import type { Tool } from '@matatbread/matbot-plugin-api';
import { listRecent, read, search } from './client.js';
import { sendMail } from './sender.js';
import { resolveImapConfig, resolveSmtpConfig } from './config.js';
import type { Db } from './db.js';

const ACCOUNT_PROP = {
  account: {
    type: 'string',
    description: 'Which named mail account to use (from Integrations → Mail). Omit to use the first/default.',
  },
};

const LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...ACCOUNT_PROP,
    mailbox: { type: 'string', description: 'Mailbox/folder (default INBOX).' },
    limit: { type: 'integer', description: 'Max messages (default 20).', minimum: 1, maximum: 100 },
  },
};
const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    ...ACCOUNT_PROP,
    query: { type: 'string', description: 'Free text to find in messages.', minLength: 1 },
    mailbox: { type: 'string', description: 'Mailbox/folder (default INBOX).' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
};
const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['uid'],
  properties: {
    ...ACCOUNT_PROP,
    uid: { type: 'string', description: 'Message id from imap_list_recent/imap_search.', minLength: 1 },
    mailbox: { type: 'string', description: 'Mailbox the message is in (default INBOX).' },
  },
};
const SEND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['to', 'subject', 'body'],
  properties: {
    ...ACCOUNT_PROP,
    to: { type: 'array', items: { type: 'string' }, description: 'Recipient email address(es).', minItems: 1 },
    subject: { type: 'string', description: 'Subject line.' },
    body: { type: 'string', description: 'Plain-text body.' },
    cc: { type: 'array', items: { type: 'string' }, description: 'Optional cc address(es).' },
  },
};

function asList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.trim());
  return [];
}

export function makeMailTools(db: Db): Tool[] {
  const imapListRecentTool: Tool = {
    name: 'imap_list_recent',
    description:
      "List the most recent messages in the operator's mailbox (sender, subject, date, id). Use to " +
      "see what's new before reading or searching. Reads via the operator's named IMAP account " +
      '(pass `account` to choose among several).',
    inputSchema: LIST_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { account?: string; mailbox?: string; limit?: number };
        const cfg = await resolveImapConfig(db, ctx, args.account);
        const msgs = await listRecent(cfg, String(args.mailbox || 'INBOX'), Number(args.limit) || 20);
        yield { type: 'result', value: { messages: msgs } };
      },
    },
  };

  const imapSearchTool: Tool = {
    name: 'imap_search',
    description:
      "Search the operator's mailbox for messages whose text contains the query " +
      '(returns sender/subject/date/id). Use to find a specific email before reading it. ' +
      'Pass `account` to choose among several named accounts.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { account?: string; query?: string; mailbox?: string; limit?: number };
        const query = String(args.query ?? '').trim();
        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }
        const cfg = await resolveImapConfig(db, ctx, args.account);
        const msgs = await search(cfg, query, String(args.mailbox || 'INBOX'), Number(args.limit) || 20);
        yield { type: 'result', value: { messages: msgs } };
      },
    },
  };

  const imapReadMessageTool: Tool = {
    name: 'imap_read_message',
    description:
      'Read one message in full (headers + plain-text body) by its id from imap_list_recent / ' +
      'imap_search. Pass `account` to choose among several named accounts.',
    inputSchema: READ_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { account?: string; uid?: string; mailbox?: string };
        const uid = String(args.uid ?? '').trim();
        if (!uid) {
          yield { type: 'error', message: 'uid is required' };
          return;
        }
        const cfg = await resolveImapConfig(db, ctx, args.account);
        const msg = await read(cfg, uid, String(args.mailbox || 'INBOX'));
        yield {
          type: 'result',
          value: {
            uid: msg.uid,
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

  const mailSendTool: Tool = {
    name: 'mail_send',
    description:
      "Send a plain-text email from the operator's account (SMTP). Use when the operator asks to " +
      'send/reply to mail. Requires to, subject, body; cc optional. Pass `account` to choose among ' +
      'several named accounts.',
    inputSchema: SEND_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as {
          account?: string;
          to?: unknown;
          subject?: string;
          body?: string;
          cc?: unknown;
        };
        const to = asList(args.to);
        if (to.length === 0) {
          yield { type: 'error', message: "'to' (at least one recipient) is required" };
          return;
        }
        const cfg = await resolveSmtpConfig(db, ctx, args.account);
        const cc = asList(args.cc);
        await sendMail(cfg, {
          to,
          subject: String(args.subject ?? ''),
          body: String(args.body ?? ''),
          ...(cc.length > 0 ? { cc } : {}),
        });
        yield { type: 'result', value: { sent: true, to, subject: args.subject ?? '' } };
      },
    },
  };

  return [imapListRecentTool, imapSearchTool, imapReadMessageTool, mailSendTool];
}
