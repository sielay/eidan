// SPDX-License-Identifier: AGPL-3.0-or-later
// A shared cross-plugin lookup so Charles (and anything else) can validate that a social handle is
// actually connected, without importing each social plugin's private DB. Each social plugin registers
// its provider's lookup into one accumulating `SocialConnections` service; consumers call
// `lookup(provider, handle)` and get back the canonical { externalId, handle } or null. Only public
// identity is exposed — never a token.
import type { MatbotServices } from '@matatbread/matbot-plugin-api';
import type { AccountStore } from './registry.js';

export interface SocialIdentity {
  externalId: string;
  handle: string;
}

export interface SocialConnectionsService {
  register(provider: string, fn: (handle: string) => Promise<SocialIdentity | null>): void;
  lookup(provider: string, handle: string): Promise<SocialIdentity | null>;
  providers(): string[];
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    SocialConnections?: SocialConnectionsService;
  }
}

class SocialConnectionsImpl implements SocialConnectionsService {
  private readonly fns = new Map<string, (handle: string) => Promise<SocialIdentity | null>>();
  register(provider: string, fn: (handle: string) => Promise<SocialIdentity | null>): void {
    this.fns.set(provider, fn);
  }
  async lookup(provider: string, handle: string): Promise<SocialIdentity | null> {
    const fn = this.fns.get(provider);
    return fn ? fn(handle) : null;
  }
  providers(): string[] {
    return [...this.fns.keys()];
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/^@+/, '');
}

// Register a provider's connected-account lookup into the shared SocialConnections service, creating
// the service on first use. Plugin setup is sequential, so the accumulation is race-free.
export async function registerSocialConnection(
  services: MatbotServices,
  provider: string,
  store: AccountStore,
): Promise<void> {
  let svc = services.SocialConnections;
  if (!svc) {
    svc = new SocialConnectionsImpl();
    await services.register('SocialConnections', svc);
  }
  svc.register(provider, async (handle) => {
    const want = norm(handle);
    for (const a of await store.listAccounts()) {
      const h = norm(a.external_handle);
      const withHost = a.host ? `${h}@${norm(a.host)}` : h;
      if (h === want || withHost === want || a.slug === want || norm(a.name) === want) {
        return { externalId: a.external_id, handle: a.host ? withHost : a.external_handle };
      }
    }
    return null;
  });
}
