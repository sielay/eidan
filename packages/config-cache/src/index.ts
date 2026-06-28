// SPDX-License-Identifier: AGPL-3.0-or-later

export interface CacheSection {
  name: string;
  startMarker: string;
  endMarker: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface ParsedConfig {
  fullContent: string;
  staticSections: CacheSection[];
  dynamicContent: string;
}

export interface CachedBlock {
  text: string;
  isCached: boolean;
  section?: CacheSection;
}

export type Provider = 'claude' | 'deepseek' | 'openai';

// Extract a CACHE_STATIC_<NAME> section from markdown.
// Returns the content between <!-- CACHE_STATIC_<NAME>_START --> and <!-- CACHE_STATIC_<NAME>_END -->
export function extractCacheSection(markdown: string, sectionName: string): CacheSection | null {
  const upperName = sectionName.toUpperCase();
  const startMarker = `<!-- CACHE_STATIC_${upperName}_START -->`;
  const endMarker = `<!-- CACHE_STATIC_${upperName}_END -->`;

  const startIdx = markdown.indexOf(startMarker);
  if (startIdx === -1) return null;

  const endIdx = markdown.indexOf(endMarker, startIdx);
  if (endIdx === -1) return null;

  const contentStart = startIdx + startMarker.length;
  const content = markdown.substring(contentStart, endIdx).trim();

  // Count lines to track positions
  const linesBefore = markdown.substring(0, startIdx).split('\n').length;
  const linesContent = content.split('\n').length;

  return {
    name: sectionName,
    startMarker,
    endMarker,
    content,
    startLine: linesBefore,
    endLine: linesBefore + linesContent,
  };
}

// Extract all CACHE_STATIC sections from markdown
export function extractAllCacheSections(markdown: string): CacheSection[] {
  const sections: CacheSection[] = [];
  const pattern = /<!-- CACHE_STATIC_(\w+)_START -->/g;
  let match;

  while ((match = pattern.exec(markdown)) !== null) {
    const sectionName = match[1]?.toLowerCase() ?? '';
    if (sectionName) {
      const section = extractCacheSection(markdown, sectionName);
      if (section) sections.push(section);
    }
  }

  return sections;
}

// Remove all cache markers but keep the content (for backward compat, or debug views)
export function stripCacheMarkers(markdown: string): string {
  return markdown
    .replace(/<!-- CACHE_STATIC_\w+_START -->\n?/g, '')
    .replace(/\n?<!-- CACHE_STATIC_\w+_END -->/g, '');
}

// Parse a config file, separating static (cached) and dynamic sections.
// Returns: { fullContent, staticSections: [...], dynamicContent: (everything outside cache blocks) }
export function parseConfigMarkdown(markdown: string): ParsedConfig {
  const staticSections = extractAllCacheSections(markdown);

  // Build dynamic content by removing all cache blocks
  let dynamic = markdown;
  for (const section of staticSections) {
    const blockStart = dynamic.indexOf(section.startMarker);
    const blockEnd = dynamic.indexOf(section.endMarker);
    if (blockStart !== -1 && blockEnd !== -1) {
      dynamic = dynamic.substring(0, blockStart) + dynamic.substring(blockEnd + section.endMarker.length);
    }
  }

  return {
    fullContent: markdown,
    staticSections,
    dynamicContent: dynamic.trim(),
  };
}

// Generate cache-control annotation for Claude (X-Custom-Cache-Control).
// Claude expects the text to be wrapped with cache_control markers as metadata on MessageContent.
// This helper generates the format — actual header injection happens at provider level.
export function addCacheControlClaude(text: string, sections: CacheSection[]): { text: string; cacheHints: string } {
  const hints = sections.map((s) => `§${s.name}: lines ${s.startLine}-${s.endLine}`).join(', ');
  const cacheHint = `[cache: ${hints}]`;
  return { text: text, cacheHints: cacheHint };
}

// Generate cache markers for DeepSeek (uses cache_control in request body).
// Returns JSON structure compatible with DeepSeek API.
export function addCacheControlDeepSeek(
  text: string,
  sections: CacheSection[],
): { text: string; cacheControl: Record<string, unknown> } {
  return {
    text,
    cacheControl: {
      type: 'ephemeral',
      sections: sections.map((s) => ({
        name: s.name,
        startLine: s.startLine,
        endLine: s.endLine,
      })),
    },
  };
}

// Generate cache markers for OpenAI (prompt_cache_control).
// OpenAI uses prefix/suffix ephemeral caching.
export function addCacheControlOpenAI(
  text: string,
  sections: CacheSection[],
): { text: string; cacheControl: { type: string; sections: Array<{ name: string; startLine: number; endLine: number }> } } {
  return {
    text,
    cacheControl: {
      type: 'ephemeral',
      sections: sections.map((s) => ({
        name: s.name,
        startLine: s.startLine,
        endLine: s.endLine,
      })),
    },
  };
}

// Provider-agnostic wrapper: given a provider name, apply the appropriate cache control.
export function annotateForCaching(
  provider: Provider,
  sections: CacheSection[],
): { text: string; cacheMetadata: Record<string, unknown> } {
  if (sections.length === 0) {
    return { text: '', cacheMetadata: {} };
  }

  const metadata: Record<string, unknown> = { provider, sections: sections.map((s) => ({ name: s.name, lines: `${s.startLine}-${s.endLine}` })) };

  // Placeholder: actual integration at provider layer. Here we just annotate metadata.
  // At LLM call time, the provider adapter reads this and adds provider-specific headers/markers.
  if (provider === 'claude') {
    metadata.cacheStrategy = 'claude-custom-cache-control';
  } else if (provider === 'deepseek') {
    metadata.cacheStrategy = 'deepseek-ephemeral';
  } else if (provider === 'openai') {
    metadata.cacheStrategy = 'openai-prompt-cache';
  }

  // Reconstruct the static sections content with cache markers
  const text = sections.map((s) => `${s.startMarker}\n${s.content}\n${s.endMarker}`).join('\n\n');

  return { text, cacheMetadata: metadata };
}

// Load and parse a config file, extracting static sections for caching.
// Usage: const { staticSections, dynamicContent } = readAndParseConfig(fileContent);
// Then use dynamicContent for immediate use, staticSections with annotateForCaching() for LLM.
export function readAndParseConfig(fileContent: string): ParsedConfig {
  return parseConfigMarkdown(fileContent);
}

// Utility: compute a hash of the file content for cache invalidation.
// If file hash changes, the cached content is invalid and should be re-read.
export async function computeFileHash(content: string): Promise<string> {
  // Use crypto.subtle if available (modern Node.js + browser), otherwise fallback to createHash
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback for Node.js (import at runtime to avoid bundler issues)
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(content).digest('hex');
}

// Cache metadata: stores file hash + timestamp for cache invalidation logic.
export interface CacheMetadata {
  fileHash: string;
  loadedAt: Date;
  provider: Provider;
}

// In-memory cache for config files (single-instance cache, agent worker scope).
// Real deployments may persist this to Postgres for multi-instance sharing.
const configFileCache = new Map<string, { parsed: ParsedConfig; metadata: CacheMetadata }>();

// Load config file with caching. If fileContent is unchanged, returns cached parse.
// Returns { parsed, cached: boolean }.
export async function loadConfigWithCache(
  filePath: string,
  fileContent: string,
  provider: Provider,
): Promise<{ parsed: ParsedConfig; cached: boolean; metadata: CacheMetadata }> {
  const hash = await computeFileHash(fileContent);
  const cached = configFileCache.get(filePath);

  if (cached && cached.metadata.fileHash === hash && cached.metadata.provider === provider) {
    return { parsed: cached.parsed, cached: true, metadata: cached.metadata };
  }

  const parsed = parseConfigMarkdown(fileContent);
  const metadata: CacheMetadata = { fileHash: hash, loadedAt: new Date(), provider };
  configFileCache.set(filePath, { parsed, metadata });

  return { parsed, cached: false, metadata };
}
