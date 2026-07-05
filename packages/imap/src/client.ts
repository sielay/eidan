// SPDX-License-Identifier: AGPL-3.0-or-later
// IMAP mail access for the eidan `imap` plugin.
//
// A thin wrapper over imapflow (async IMAP). Credentials are NOT held here; the tool layer
// resolves them per-call from the vault and constructs a config per call. Mailboxes are opened
// read-only — this plugin never mutates the operator's mail.
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';

export class ImapError extends Error {}

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface MailSummary {
  uid: string;
  from: string;
  subject: string;
  date: string | null;
}

export interface MailMessage {
  uid: string;
  from: string;
  to: string;
  subject: string;
  date: string | null;
  body: string;
}

function fmtAddr(a: { name?: string; address?: string }): string {
  const address = a.address ?? '';
  return a.name ? `${a.name} <${address}>` : address;
}

function summary(msg: FetchMessageObject): MailSummary {
  const env = msg.envelope;
  return {
    uid: String(msg.uid),
    from: (env?.from ?? []).map(fmtAddr).join(', '),
    subject: env?.subject ?? '',
    date: env?.date ? env.date.toISOString() : null,
  };
}

function addressText(addr: AddressObject | AddressObject[] | undefined): string {
  if (!addr) return '';
  return Array.isArray(addr) ? addr.map((a) => a.text).join(', ') : addr.text;
}

async function withClient<T>(cfg: ImapConfig, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // best-effort close
    }
  }
}

export async function listRecent(cfg: ImapConfig, mailbox: string, limit: number): Promise<MailSummary[]> {
  return withClient(cfg, async (client) => {
    const mbox = await client.mailboxOpen(mailbox, { readOnly: true });
    const total = mbox.exists;
    if (!total) return [];
    const start = Math.max(1, total - limit + 1);
    const out: MailSummary[] = [];
    for await (const msg of client.fetch(`${start}:*`, { envelope: true, uid: true })) {
      out.push(summary(msg));
    }
    return out.reverse(); // newest first
  });
}

function parseSearchQuery(query: string): Record<string, unknown> {
  // Parse query like "to:user@x.com OR subject:test OR body:foo OR plain text"
  // Returns an object suitable for imapflow's search() method

  // Split by OR operator (case-insensitive)
  const orTerms = query.split(/\s+OR\s+/i);

  // Parse each term into search criteria
  const orCriteria: Array<Record<string, string>> = [];

  for (const term of orTerms) {
    const trimmed = term.trim();
    if (!trimmed) continue;

    const criteria: Record<string, string> = {};

    // Check for field prefixes
    if (trimmed.startsWith('to:')) {
      criteria.to = trimmed.slice(3).trim();
    } else if (trimmed.startsWith('from:')) {
      criteria.from = trimmed.slice(5).trim();
    } else if (trimmed.startsWith('subject:')) {
      criteria.subject = trimmed.slice(8).trim();
    } else if (trimmed.startsWith('cc:')) {
      criteria.cc = trimmed.slice(3).trim();
    } else if (trimmed.startsWith('bcc:')) {
      criteria.bcc = trimmed.slice(4).trim();
    } else if (trimmed.startsWith('body:')) {
      criteria.body = trimmed.slice(5).trim();
    } else {
      // Default: search in all text
      criteria.text = trimmed;
    }

    orCriteria.push(criteria);
  }

  // If we have multiple OR terms, use the 'or' array syntax
  if (orCriteria.length > 1) {
    return { or: orCriteria };
  }

  // Single term: return it directly
  if (orCriteria.length === 1) {
    return orCriteria[0];
  }

  // Empty query: search all
  return { text: '' };
}

export async function search(cfg: ImapConfig, query: string, mailbox: string, limit: number): Promise<MailSummary[]> {
  return withClient(cfg, async (client) => {
    await client.mailboxOpen(mailbox, { readOnly: true });
    const searchCriteria = parseSearchQuery(query);
    const uids = await client.search(searchCriteria, { uid: true });
    if (!uids || uids.length === 0) return [];
    const newest = [...uids].sort((a, b) => b - a).slice(0, limit);
    const out: MailSummary[] = [];
    for await (const msg of client.fetch(newest, { envelope: true, uid: true }, { uid: true })) {
      out.push(summary(msg));
    }
    return out.sort((a, b) => Number(b.uid) - Number(a.uid));
  });
}

export async function read(cfg: ImapConfig, uid: string, mailbox: string): Promise<MailMessage> {
  return withClient(cfg, async (client) => {
    await client.mailboxOpen(mailbox, { readOnly: true });
    const msg = await client.fetchOne(uid, { source: true }, { uid: true });
    if (!msg || !msg.source) throw new ImapError(`no message ${uid} in ${mailbox}`);
    const parsed = await simpleParser(msg.source);
    return {
      uid: String(uid),
      from: parsed.from?.text ?? '',
      to: addressText(parsed.to),
      subject: parsed.subject ?? '',
      date: parsed.date ? parsed.date.toISOString() : null,
      body: parsed.text ?? '',
    };
  });
}
