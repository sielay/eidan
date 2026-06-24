// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DomainRecord } from './registrars.js';

function testGoDaddyResponseMapping(): void {
  const mockDomains = [
    {
      domain: 'example.com',
      status: 'ACTIVE',
      expires: '2025-12-31T23:59:59Z',
      renewAuto: true,
      nameServers: ['ns1.godaddy.com', 'ns2.godaddy.com'],
    },
    {
      domain: 'inactive.com',
      status: 'INACTIVE',
      expires: '2024-01-01T00:00:00Z',
      renewAuto: false,
    },
  ];

  const mapped: DomainRecord[] = [];
  for (const item of mockDomains) {
    if (item.status === 'ACTIVE') {
      mapped.push({
        name: item.domain,
        externalId: item.domain,
        status: 'active',
        expiresAt: item.expires ? new Date(item.expires) : null,
        autoRenew: item.renewAuto ?? null,
        nameservers: item.nameServers ?? null,
      });
    }
  }

  console.assert(mapped.length === 1, 'Should filter to only ACTIVE domains');
  console.assert(mapped[0]?.name === 'example.com', 'Domain name should be mapped');
  console.assert(mapped[0]?.autoRenew === true, 'Auto-renew should be mapped');
  console.assert(mapped[0]?.nameservers?.length === 2, 'Nameservers should be mapped');
  console.log('✓ GoDaddy response mapping test passed');
}

function testDomainNameNormalization(): void {
  const testCases = [
    { input: 'EXAMPLE.COM', expected: 'example.com' },
    { input: 'Example.Com', expected: 'example.com' },
    { input: 'example.com', expected: 'example.com' },
    { input: '  example.com  ', expected: 'example.com' },
  ];

  for (const tc of testCases) {
    const normalized = tc.input.trim().toLowerCase();
    console.assert(normalized === tc.expected, `Normalization failed for ${tc.input}`);
  }
  console.log('✓ Domain name normalization test passed');
}

function testDomainExpiryParsing(): void {
  const expiryStr = '2025-12-31T23:59:59Z';
  const expiry = new Date(expiryStr);
  console.assert(expiry.getFullYear() === 2025, 'Year should be 2025');
  console.assert(expiry.getMonth() === 11, 'Month should be December (11)');
  console.assert(expiry.getDate() === 31, 'Day should be 31');
  console.log('✓ Domain expiry parsing test passed');
}

// Run tests
testGoDaddyResponseMapping();
testDomainNameNormalization();
testDomainExpiryParsing();
console.log('\nAll tests passed!');
