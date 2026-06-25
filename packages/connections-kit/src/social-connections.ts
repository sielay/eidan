// SPDX-License-Identifier: AGPL-3.0-or-later
// A shared cross-plugin directory so Charles (and anything else) can attach a venture resource to a
// REAL connected account — not free text — without importing each social plugin's private DB. Each
// social plugin registers, per provider: a `lookup(handle)` (resolve+validate a typed ref) and a
// `list()` (enumerate the connected accounts for a picker). Consumers see only public identity
// ({ id, handle, label }) — never a token. The same pattern generalises to other plugins later
// (e.g. Glue projects, mailboxes, domains) by registering their own directory entries.
import type { MatbotServices } from '@matatbread/matbot-plugin-api';
import type { AccountStore } from './registry.js';

export interface SocialIdentity {
  externalId: string;
  handle: string;
}

// A connectable instance the operator can attach (e.g. a specific connected account).
export interface ConnectableRef {
  id: string; // stable connection id (the account's external_id, else its slug)
  handle: string; // public handle (e.g. @me or me@host)
  label: string; // human label for a picker (the account's name)
}

export interface SocialConnectionsService {
  register(
    provider: string,
    fns: { lookup: (handle: string) => Promise<SocialIdentity | null>; list: () => Promise<ConnectableRef[]> },
  ): void;
  lookup(provider: string, handle: string): Promise<SocialIdentity | null>;
  list(provider: string): Promise<ConnectableRef[]>;
  providers(): string[];
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    SocialConnections?: SocialConnectionsService;
  }
}

class SocialConnectionsImpl implements SocialConnectionsService {
  private readonly lookups = new Map<string, (handle: string) => Promise<SocialIdentity | null>>();
  private readonly lists = new Map<string, () => Promise<ConnectableRef[]>>();
  register(
    provider: string,
    fns: { lookup: (handle: string) => Promise<SocialIdentity | null>; list: () => Promise<ConnectableRef[]> },
  ): void {
    this.lookups.set(provider, fns.lookup);
    this.lists.set(provider, fns.list);
  }
  async lookup(provider: string, handle: string): Promise<SocialIdentity | null> {
    const fn = this.lookups.get(provider);
    return fn ? fn(handle) : null;
  }
  async list(provider: string): Promise<ConnectableRef[]> {
    const fn = this.lists.get(provider);
    return fn ? fn() : [];
  }
  providers(): string[] {
    return [...this.lookups.keys()];
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/^@+/, '');
}

// Register a provider's connected accounts into the shared SocialConnections directory, creating the
// service on first use. Plugin setup is sequential, so the accumulation is race-free.
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
  const refOf = (a: { external_id: string; external_handle: string; host: string; name: string; slug: string }): ConnectableRef => {
    const handle = a.host && a.external_handle ? `${a.external_handle}@${a.host}` : a.external_handle;
    return { id: a.external_id || a.slug, handle, label: a.name };
  };
  svc.register(provider, {
    lookup: async (handle) => {
      const want = norm(handle);
      for (const a of await store.listAccounts()) {
        const h = norm(a.external_handle);
        const withHost = a.host ? `${h}@${norm(a.host)}` : h;
        if (h === want || withHost === want || a.slug === want || norm(a.name) === want) {
          return { externalId: a.external_id, handle: a.host ? withHost : a.external_handle };
        }
      }
      return null;
    },
    list: async () => (await store.listAccounts()).map(refOf),
  });
}
