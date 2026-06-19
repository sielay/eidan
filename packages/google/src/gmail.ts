// SPDX-License-Identifier: AGPL-3.0-or-later
// Gmail API read client for the eidan `google` plugin. Lists/reads messages via the Gmail
// REST API with a short-lived access token. Read-only; nothing stored.
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailError extends Error {}

export interface GmailSummary {
  id: string;
  from: string;
  subject: string;
  date: string | null;
  snippet: string;
}

export interface GmailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string | null;
  body: string;
}

interface GmailPayload {
  mimeType?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string };
  parts?: GmailPayload[];
}

function headerMap(payload: GmailPayload): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of payload.headers ?? []) {
    if (h.name) out[h.name.toLowerCase()] = h.value ?? '';
  }
  return out;
}

function b64url(data: string): string {
  try {
    return Buffer.from(data, 'base64url').toString('utf-8');
  } catch {
    return '';
  }
}

function extractBody(payload: GmailPayload): string {
  if (payload.mimeType === 'text/plain') {
    const data = payload.body?.data;
    if (data) return b64url(data);
  }
  for (const part of payload.parts ?? []) {
    const body = extractBody(part);
    if (body) return body;
  }
  const data = payload.body?.data;
  return data ? b64url(data) : '';
}

export class GmailClient {
  private readonly token: string;

  constructor(accessToken: string) {
    this.token = accessToken;
  }

  private async json(url: string): Promise<Record<string, unknown>> {
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (exc) {
      throw new GmailError(`Gmail request failed: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
    if (resp.status === 401) throw new GmailError('Gmail rejected the access token');
    if (resp.status !== 200) throw new GmailError(`Gmail API returned HTTP ${resp.status}`);
    return (await resp.json()) as Record<string, unknown>;
  }

  async listRecent(limit: number, query?: string): Promise<GmailSummary[]> {
    let url = `${GMAIL_API}/messages?maxResults=${limit}`;
    if (query) url += `&q=${encodeURIComponent(query)}`;
    const listing = await this.json(url);
    const refs = (listing['messages'] as { id?: string }[] | undefined) ?? [];
    const out: GmailSummary[] = [];
    for (const ref of refs) {
      const mid = ref.id;
      if (!mid) continue;
      const meta = await this.json(
        `${GMAIL_API}/messages/${mid}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      );
      const h = headerMap((meta['payload'] as GmailPayload | undefined) ?? {});
      out.push({
        id: mid,
        from: h['from'] ?? '',
        subject: h['subject'] ?? '',
        date: h['date'] ?? null,
        snippet: (meta['snippet'] as string | undefined) ?? '',
      });
    }
    return out;
  }

  async read(messageId: string): Promise<GmailMessage> {
    const msg = await this.json(`${GMAIL_API}/messages/${messageId}?format=full`);
    const payload = (msg['payload'] as GmailPayload | undefined) ?? {};
    const h = headerMap(payload);
    return {
      id: messageId,
      from: h['from'] ?? '',
      to: h['to'] ?? '',
      subject: h['subject'] ?? '',
      date: h['date'] ?? null,
      body: extractBody(payload),
    };
  }
}
