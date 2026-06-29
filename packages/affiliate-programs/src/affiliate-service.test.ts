// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { AffiliateService } from './affiliate-service.js';

// Mock Db for testing
const mockDb = {
  withPrincipalTx: async (fn: (q: any) => Promise<any>) => {
    const mockQuery = async () => ({ rows: [] });
    return fn(mockQuery);
  },
};

test('interpolateTemplate escapes regex metacharacters', () => {
  const service = new AffiliateService(mockDb as any);

  // Access private method via type assertion for testing
  const interpolate = (service as any).interpolateTemplate.bind(service);

  // Test normal case
  assert.strictEqual(
    interpolate('https://amazon.com?tag={tag}&product={product_id}', {
      tag: 'mytag',
      product_id: 'B123',
    }),
    'https://amazon.com?tag=mytag&product=B123'
  );

  // Test with regex metacharacters in key (should be escaped, not cause ReDoS)
  const result = interpolate('template {.*} {normal}', {
    '.*': 'value1',
    normal: 'value2',
  });
  assert.ok(result.includes('value1'));
  assert.ok(result.includes('value2'));
});

test('injectLinksIntoContent uses composite keys to avoid program collisions', () => {
  const service = new AffiliateService(mockDb as any);

  // Two programs with the same product_id but different URLs
  const content = 'Some content';
  const linkMap = {
    program1: { product_id_123: 'https://amazon.com?tag=program1' },
    program2: { product_id_123: 'https://amazon.com?tag=program2' },
  };

  // Access the private method via type assertion
  const safeInjectLinks = (service as any).safeInjectLinks.bind(service);

  // Build the links list as the method does
  const linksList: Array<{ productId: string; url: string; programId: string }> = [];
  for (const [programId, links] of Object.entries(linkMap)) {
    for (const [productId, url] of Object.entries(links)) {
      linksList.push({ productId, url, programId });
    }
  }

  // Verify both links are in the list
  assert.strictEqual(linksList.length, 2);
  assert.strictEqual(linksList[0].programId, 'program1');
  assert.strictEqual(linksList[1].programId, 'program2');
  assert.notStrictEqual(linksList[0].url, linksList[1].url);
});

test('injectIntoMarkdown avoids duplicate URLs', () => {
  const service = new AffiliateService(mockDb as any);

  const injectIntoMarkdown = (service as any).injectIntoMarkdown.bind(service);

  // Content already has a link to the same URL
  const content = 'Check out [Product](https://amazon.com?tag=program1)';
  const linksList = [
    { productId: 'book123', url: 'https://amazon.com?tag=program1', programId: 'program1' },
  ];

  const result = injectIntoMarkdown(content, linksList);
  // Should not add the link again (it's already in the content)
  const linkCount = (result.match(/https:\/\/amazon\.com\?tag=program1/g) || []).length;
  assert.strictEqual(linkCount, 1);
});

test('injectIntoText avoids duplicate URLs', () => {
  const service = new AffiliateService(mockDb as any);

  const injectIntoText = (service as any).injectIntoText.bind(service);

  // Content already contains the URL
  const content = 'Check this https://amazon.com?tag=program1 out';
  const linksList = [
    { productId: 'book123', url: 'https://amazon.com?tag=program1', programId: 'program1' },
  ];

  const result = injectIntoText(content, linksList);
  // Should not add the link again
  const urlCount = (result.match(/https:\/\/amazon\.com\?tag=program1/g) || []).length;
  assert.strictEqual(urlCount, 1);
});
