# @eidandev/config-cache

Two-tier config file caching for agents: static sections use LLM prompt cache, dynamic sections read fresh.

## Problem

Agent config files (calendars.md, routines.md) contain both:
- **Static content** (routing tables, categories) — changes rarely, re-read on every run
- **Dynamic content** (current tasks, venture keywords) — changes frequently, must be fresh

Result: ~15K tokens/week wasted re-reading immutable content, despite LLM providers supporting prompt caching.

## Solution

Mark immutable sections with cache markers; the framework separates them and annotates for caching.

```markdown
<!-- CACHE_STATIC_ROUTING_START -->
## Routing Table (immutable)
...
<!-- CACHE_STATIC_ROUTING_END -->

## Current Tasks (dynamic, always fresh)
...
```

```typescript
import { parseConfigMarkdown, annotateForCaching } from '@eidandev/config-cache';

const { staticSections, dynamicContent } = parseConfigMarkdown(markdown);
const { text, cacheMetadata } = annotateForCaching('claude', staticSections, markdown);
// Pass cacheMetadata to provider; use dynamicContent fresh in your logic
```

## API

### Parse

```typescript
parseConfigMarkdown(markdown: string): ParsedConfig
// Returns: { fullContent, staticSections: CacheSection[], dynamicContent: string }

extractCacheSection(markdown: string, name: string): CacheSection | null
// Extract one named cache section

extractAllCacheSections(markdown: string): CacheSection[]
// Extract all cache sections
```

### Annotate

```typescript
annotateForCaching(provider: Provider, sections: CacheSection[], markdown: string): { text: string; cacheMetadata }
// Generate provider-specific cache annotations (Claude, DeepSeek, OpenAI)

addCacheControlClaude(text: string, sections: CacheSection[]): { text, cacheHints }
addCacheControlDeepSeek(text: string, sections: CacheSection[]): { text, cacheControl }
addCacheControlOpenAI(text: string, sections: CacheSection[]): { text, cacheControl }
```

### Cache Management

```typescript
computeFileHash(content: string): Promise<string>
// Hash file for invalidation detection

loadConfigWithCache(filePath: string, fileContent: string, provider: Provider): Promise<{ parsed, cached, metadata }>
// Load with built-in caching (file hash based)
```

### Utilities

```typescript
stripCacheMarkers(markdown: string): string
// Remove markers, keep content (for backward compat or debug views)

readAndParseConfig(fileContent: string): ParsedConfig
// Convenience wrapper for parsing
```

## Types

```typescript
type Provider = 'claude' | 'deepseek' | 'openai';

interface CacheSection {
  name: string;
  content: string;
  startLine: number;
  endLine: number;
  startMarker: string;
  endMarker: string;
}

interface ParsedConfig {
  fullContent: string;
  staticSections: CacheSection[];
  dynamicContent: string;
}

interface CacheMetadata {
  fileHash: string;
  loadedAt: Date;
  provider: Provider;
}
```

## Usage

### 1. Structure Your Config File

```markdown
# config.md

<!-- CACHE_STATIC_RULES_START -->
## Routing Rules (immutable)
...
<!-- CACHE_STATIC_RULES_END -->

<!-- CACHE_STATIC_CATEGORIES_START -->
## Categories (immutable)
...
<!-- CACHE_STATIC_CATEGORIES_END -->

## Current Tasks (dynamic)
... (no cache markers; always fresh)
```

### 2. In Your Agent

```typescript
import { parseConfigMarkdown, annotateForCaching } from '@eidandev/config-cache';

// Load file (via fs_read or similar)
const fileResult = await tools.fs_read({ path: 'config.md' });

// Parse: separate static from dynamic
const { staticSections, dynamicContent } = parseConfigMarkdown(fileResult.content);

// Use dynamicContent in your logic (always fresh)

// Annotate static sections for caching
const provider = 'claude'; // or 'deepseek', 'openai'
const { text, cacheMetadata } = annotateForCaching(provider, staticSections, fileResult.content);

// Pass cacheMetadata to LLM provider (framework integration point)
// This tells Claude/DeepSeek/OpenAI to cache the static sections
```

### 3. Cache Invalidation

File hash is computed automatically:
- If file changes (any section) → cache drops (safe, conservative)
- No manual invalidation needed
- Multi-instance cache sharing: TODO (Postgres-backed invalidation)

## Example Files

- `docs/config/calendars.md` — Calendar event routing
- `docs/config/routines.md` — Task definitions
- `docs/config/example-agent-persona.md` — Agent using cached config

## Integration Points

### Provider Adapters

The framework generates `cacheMetadata` but provider-specific headers are added at adapter level:

- **Claude**: Adapter reads `cacheStrategy: 'claude-custom-cache-control'` and adds X-Custom-Cache-Control header
- **DeepSeek**: Adapter reads `cacheStrategy: 'deepseek-ephemeral'` and adds cache_control JSON
- **OpenAI**: Adapter reads `cacheStrategy: 'openai-prompt-cache'` and adds prompt_cache_control metadata

(Currently TODO — define integration in provider adapters under `/packages/agents/`)

### Agent Personas

Agents reference cached sections:
```
"Using the cached routing table from calendars.md §1..."
```

This tells the LLM which cached content it's referencing (for transparency + debugging).

## Backward Compatibility

- Files without cache markers: treated as entirely dynamic (no caching)
- Mixed cached + non-cached config: fully supported
- No breaking changes to agent APIs

## Performance

### Expected savings
- ~15K tokens/week per agent reading config files
- Scales with config file size and agent frequency

### Cache hit conditions
All three must be true:
1. Same file path
2. File hash unchanged
3. Same provider

## Known Limitations

1. **File-level caching only** — no per-line fine-tuning
2. **Hash-based invalidation** — any change drops entire cache (conservative)
3. **Provider integration TODO** — cache_control headers manual per adapter
4. **Single-instance cache** — multi-instance sharing TODO (Postgres-backed)

## References

- Eidan CLAUDE.md: `/CLAUDE.md` (config-cache not mentioned yet; add TODO)
- Integration guide: `docs/config/CACHE-INTEGRATION.md`
- Example files: `docs/config/calendars.md`, `routines.md`
- Agent integration: `/packages/agents/src/config-loader.ts`
