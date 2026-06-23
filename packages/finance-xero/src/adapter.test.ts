// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { xeroAdapter, XERO_SCOPES } from './adapter.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('xeroAdapter', () => {
  it('is a refresh-capable oauth2 adapter using HTTP Basic client auth', () => {
    assert.equal(xeroAdapter.provider, 'xero');
    assert.equal(xeroAdapter.flavor, 'oauth2');
    assert.equal(xeroAdapter.usesRefresh, true);
    assert.equal(xeroAdapter.requireRefreshOnConnect, true);
    assert.equal(xeroAdapter.tokenAuthStyle, 'basic');
    assert.ok(XERO_SCOPES.includes('offline_access'));
    assert.ok(XERO_SCOPES.includes('accounting.invoices.read'));
    assert.ok(XERO_SCOPES.includes('accounting.reports.profitandloss.read'));
    // The broad scopes Xero rejects unless toggled on must NOT be requested.
    assert.ok(!XERO_SCOPES.includes('accounting.transactions.read'));
    assert.ok(!XERO_SCOPES.includes('accounting.reports.read'));
  });

  it('points at the Xero identity endpoints', () => {
    const e = xeroAdapter.endpoints();
    assert.match(e.authUrl, /login\.xero\.com/);
    assert.match(e.tokenUrl, /identity\.xero\.com\/connect\/token/);
  });

  it('fetchIdentity adopts the first tenant from /connections', async () => {
    globalThis.fetch = (async () =>
      ({
        status: 200,
        json: async () => [
          { tenantId: 'tid-1', tenantName: 'Acme Ltd', tenantType: 'ORGANISATION' },
          { tenantId: 'tid-2', tenantName: 'Other Co' },
        ],
      }) as Response) as typeof fetch;
    const id = await xeroAdapter.fetchIdentity('access-tok');
    assert.equal(id.id, 'tid-1');
    assert.equal(id.handle, 'Acme Ltd');
  });

  it('fetchIdentity returns blanks when /connections is empty or fails', async () => {
    globalThis.fetch = (async () => ({ status: 200, json: async () => [] }) as Response) as typeof fetch;
    assert.deepEqual(await xeroAdapter.fetchIdentity('t'), { handle: '', id: '' });
  });
});
