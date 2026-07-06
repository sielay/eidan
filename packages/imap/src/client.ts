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

// SearchCriteria matches imapflow's search() input: a single criteria object,
// an array of objects (for OR), or nested AND/OR structures.
type SearchCriteria = Record<string, string | boolean | number | SearchCriteria[] | Record<string, SearchCriteria[]>>;

// ParsedSearchCriteria is the result of parseSearchQuery: either a single object
// or an array of objects for OR conditions.
type ParsedSearchCriteria = SearchCriteria | SearchCriteria[];

// SearchObject is the proper type for imapflow's search() method input.
// This ensures type safety and clarity when building search criteria.
type SearchObject = Record<string, string | boolean | number | SearchObject[] | Record<string, SearchObject[]>>;

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

function parseSearchQuery(query: string): SearchObject | SearchObject[] {
  // Parse query like "to:user@x.com OR subject:test OR body:foo OR plain text"
  // Handles AND operators with higher precedence than OR.
  // Returns a SearchCriteria object or array of SearchCriteria objects
  // suitable for imapflow's search() method.

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return {};
  }

  // Validate and sanitize search term value to prevent resource exhaustion.
  // Returns the raw value (unquoted) — imapflow handles RFC 3501 quoting and escaping.
  const validateValue = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length === 0) return null;
    // Limit search term length to prevent DoS (typical IMAP servers have limits)
    if (trimmed.length > 1000) return null;
    return trimmed;
  };

  // Helper to convert a single search term to a SearchObject.
  // Returns empty object {} for invalid/empty terms.
  const parseTerm = (term: string): Record<string, unknown> => {
    if (term.startsWith('to:')) {
      const value = validateValue(term.slice(3));
      if (value === null) return {};
      return { to: value };
    }
    if (term.startsWith('from:')) {
      const value = validateValue(term.slice(5));
      if (value === null) return {};
      return { from: value };
    }
    if (term.startsWith('subject:')) {
      const value = validateValue(term.slice(8));
      if (value === null) return {};
      return { subject: value };
    }
    if (term.startsWith('cc:')) {
      const value = validateValue(term.slice(3));
      if (value === null) return {};
      return { cc: value };
    }
    if (term.startsWith('bcc:')) {
      const value = validateValue(term.slice(4));
      if (value === null) return {};
      return { bcc: value };
    }
    if (term.startsWith('body:')) {
      const value = validateValue(term.slice(5));
      if (value === null) return {};
      return { body: value };
    }
    // Default: search text in both headers and body for broader matching
    const value = validateValue(term);
    if (value === null) return {};
    return { text: value };
  };

  // Helper to merge AND criteria: multiple criteria on the same field must use `and` array.
  // Different fields can be merged into a single object (implicit AND).
  const mergeAndCriteria = (criteria: Record<string, unknown>[]): Record<string, unknown> => {
    if (criteria.length === 0) return {};
    if (criteria.length === 1) return criteria[0]!;

    // Check for duplicate keys — if the same field appears in multiple criteria,
    // we must use imapflow's `and` array structure to avoid overwriting.
    const keyCount = new Map<string, number>();
    for (const item of criteria) {
      for (const key of Object.keys(item)) {
        keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
      }
    }

    // If any field key appears in multiple criteria, use AND array structure
    const hasDuplicateKeys = Array.from(keyCount.values()).some((count) => count > 1);
    if (hasDuplicateKeys) {
      return { and: criteria };
    }

    // Merge distinct keys into a single object (implicit AND in IMAP)
    const merged: Record<string, unknown> = {};
    for (const item of criteria) {
      Object.assign(merged, item);
    }
    return merged;
  };

  // Split by OR operator (lower precedence) first
  const orClauses = trimmedQuery.split(/\s+OR\s+/i);
  const orCriteria: unknown[] = [];

  for (const clause of orClauses) {
    // Split each OR clause by AND operators (higher precedence)
    const andTerms = clause.split(/\s+AND\s+/i);
    const andCriteria: Record<string, unknown>[] = [];

    for (const term of andTerms) {
      const t = term.trim();
      if (t) {
        const criteria = parseTerm(t);
        if (Object.keys(criteria).length > 0) {
          andCriteria.push(criteria);
        }
      }
    }

    // Combine AND criteria: merge objects with proper AND semantics
    if (andCriteria.length > 0) {
      orCriteria.push(mergeAndCriteria(andCriteria));
    }
  }

  if (orCriteria.length === 0) {
    return {};
  } else if (orCriteria.length === 1) {
    return orCriteria[0]!;
  } else {
    // imapflow expects an array of criteria objects for OR conditions
    return orCriteria;
  }
}

export async function search(cfg: ImapConfig, query: string, mailbox: string, limit: number): Promise<MailSummary[]> {
  return withClient(cfg, async (client) => {
    await client.mailboxOpen(mailbox, { readOnly: true });
    const searchCriteria = parseSearchQuery(query);
    // Empty criteria (invalid/empty search terms) returns no results
    // searchCriteria can be an empty object, a non-empty object, or an array of objects
    if (
      typeof searchCriteria === 'object' &&
      !Array.isArray(searchCriteria) &&
      Object.keys(searchCriteria).length === 0
    ) {
      return [];
    }
    // searchCriteria is a SearchObject or SearchObject[], which imapflow accepts directly
    const uids = await client.search(searchCriteria as SearchObject | SearchObject[]);
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
