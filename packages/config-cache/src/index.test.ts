// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import {
  extractCacheSection,
  extractAllCacheSections,
  parseConfigMarkdown,
  stripCacheMarkers,
  annotateForCaching,
  type CacheSection,
} from './index.js';

test('extractCacheSection finds marked sections', () => {
  const markdown = `
# Config

<!-- CACHE_STATIC_ROUTING_START -->
## Routing

| A | B |
|---|---|
| x | y |
<!-- CACHE_STATIC_ROUTING_END -->

Some dynamic content
`;

  const section = extractCacheSection(markdown, 'routing');
  assert(section !== null, 'section should be found');
  assert.equal(section.name, 'routing');
  assert(section.content.includes('Routing'), 'content should include section header');
  assert(section.content.includes('| x | y |'), 'content should include table row');
  assert(!section.content.includes('dynamic'), 'content should not include dynamic part');
});

test('extractAllCacheSections finds multiple sections', () => {
  const markdown = `
<!-- CACHE_STATIC_ROUTING_START -->
routing content
<!-- CACHE_STATIC_ROUTING_END -->

<!-- CACHE_STATIC_CATEGORIES_START -->
categories content
<!-- CACHE_STATIC_CATEGORIES_END -->

<!-- CACHE_STATIC_RULES_START -->
rules content
<!-- CACHE_STATIC_RULES_END -->
`;

  const sections = extractAllCacheSections(markdown);
  assert.equal(sections.length, 3, 'should find 3 sections');
  assert.deepEqual(
    sections.map((s) => s.name),
    ['routing', 'categories', 'rules'],
    'sections should be in order'
  );
});

test('extractCacheSection returns null for missing section', () => {
  const markdown = 'no cache markers here';
  const section = extractCacheSection(markdown, 'missing');
  assert.strictEqual(section, null);
});

test('parseConfigMarkdown separates static and dynamic', () => {
  const markdown = `# Config

<!-- CACHE_STATIC_ROUTING_START -->
## Routing Table
| A | B |
<!-- CACHE_STATIC_ROUTING_END -->

## Dynamic Content
Updates daily
`;

  const { staticSections, dynamicContent } = parseConfigMarkdown(markdown);

  assert.equal(staticSections.length, 1);
  assert.equal(staticSections[0].name, 'routing');
  assert(dynamicContent.includes('Dynamic Content'), 'dynamic should have header');
  assert(dynamicContent.includes('Updates daily'), 'dynamic should have content');
  assert(!dynamicContent.includes('Routing Table'), 'dynamic should not have cached section');
});

test('stripCacheMarkers removes markers but keeps content', () => {
  const markdown = `
<!-- CACHE_STATIC_ROUTING_START -->
Routing content here
<!-- CACHE_STATIC_ROUTING_END -->

Dynamic here
`;

  const stripped = stripCacheMarkers(markdown);
  assert(stripped.includes('Routing content here'), 'content should remain');
  assert(!stripped.includes('CACHE_STATIC_ROUTING_START'), 'markers should be removed');
});

test('annotateForCaching adds provider-specific metadata', () => {
  const markdown = `
<!-- CACHE_STATIC_ROUTING_START -->
table
<!-- CACHE_STATIC_ROUTING_END -->
`;
  const sections: CacheSection[] = [
    { name: 'routing', content: 'table', startLine: 10, endLine: 20, startMarker: '<!-- CACHE_STATIC_ROUTING_START -->', endMarker: '<!-- CACHE_STATIC_ROUTING_END -->' },
  ];

  const result = annotateForCaching('claude', sections, markdown);
  assert(result.cacheMetadata, 'should have cacheMetadata');
  const meta = result.cacheMetadata as Record<string, unknown>;
  assert.equal(meta.provider, 'claude');
  assert.equal(meta.cacheStrategy, 'claude-custom-cache-control');

  const deepseekResult = annotateForCaching('deepseek', sections, markdown);
  const deepMeta = deepseekResult.cacheMetadata as Record<string, unknown>;
  assert.equal(deepMeta.cacheStrategy, 'deepseek-ephemeral');

  const openaiResult = annotateForCaching('openai', sections, markdown);
  const openMeta = openaiResult.cacheMetadata as Record<string, unknown>;
  assert.equal(openMeta.cacheStrategy, 'openai-prompt-cache');
});

test('annotateForCaching with empty sections returns empty metadata', () => {
  const result = annotateForCaching('claude', [], '');
  assert.deepEqual(result.cacheMetadata, {});
});
