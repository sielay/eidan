// SPDX-License-Identifier: AGPL-3.0-or-later
export interface DomainRecord {
  name: string;
  externalId?: string;
  status: string;
  expiresAt: Date | null;
  autoRenew: boolean | null;
  nameservers: string[] | null;
}

export interface RegistrarAdapter {
  listDomains(creds: { key: string; secret: string }): Promise<DomainRecord[]>;
}

const GODADDY_BASE = 'https://api.godaddy.com';

class GoDaddyAdapter implements RegistrarAdapter {
  async listDomains(creds: { key: string; secret: string }): Promise<DomainRecord[]> {
    const domains: DomainRecord[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const url = new URL(`${GODADDY_BASE}/v1/domains`);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('offset', String(offset));

      const res = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `sso-key ${creds.key}:${creds.secret}`,
          'content-type': 'application/json',
        },
      });

      if (!res.ok) {
        throw new Error(`GoDaddy API error: ${res.status} ${res.statusText}`);
      }

      const batch = (await res.json()) as GoDaddyDomain[];
      if (!batch.length) break;

      for (const item of batch) {
        if (item.status === 'ACTIVE') {
          domains.push({
            name: item.domain,
            externalId: item.domain,
            status: 'active',
            expiresAt: item.expires ? new Date(item.expires) : null,
            autoRenew: item.renewAuto ?? null,
            nameservers: item.nameServers ?? null,
          });
        }
      }

      if (batch.length < limit) break;
      offset += limit;
    }

    return domains;
  }
}

interface GoDaddyDomain {
  domain: string;
  status: string;
  expires?: string;
  renewAuto?: boolean;
  nameServers?: string[];
}

class CyberfolksAdapter implements RegistrarAdapter {
  async listDomains(_creds: { key: string; secret: string }): Promise<DomainRecord[]> {
    // cyberfolks API is not publicly documented or accessible as of 2026-06-24.
    // The adapter interface is implemented for future completion, but currently
    // returns an empty list. This should be updated when cyberfolks provides
    // public API documentation or a developer portal.
    console.warn('[charles-domains] cyberfolks adapter: API not yet integrated');
    return [];
  }
}

export const ADAPTERS: Record<string, RegistrarAdapter> = {
  godaddy: new GoDaddyAdapter(),
  cyberfolks: new CyberfolksAdapter(),
};

export function getAdapter(registrar: string): RegistrarAdapter | undefined {
  return ADAPTERS[registrar];
}
