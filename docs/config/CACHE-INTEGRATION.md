# Two-Tier Config File Caching

Enable prompt caching for agent config files, reducing token waste on re-reading immutable content.

## The Problem

Agent config files (calendars.md, routines.md, email rules, etc.) contain:
- **Static content**: Routing rules, category tables, escalation policies — change rarely, re-read on every agent run
- **Dynamic content**: Venture keywords, active tasks, focus areas — change frequently, must always be fresh

Currently, agents read the **entire file fresh every run**, even though static sections never change. Result: ~15K tokens/week wasted re-reading the same data, despite LLM providers (Claude, DeepSeek, OpenAI) supporting prompt caching.

## The Solution

### File Format: Cache Markers

Mark immutable sections with HTML comments:

```markdown
# config.md

<!-- CACHE_STATIC_ROUTING_START -->
## Routing Table (immutable)

| Keyword | Category |
|---------|----------|
| ...     | ...      |
<!-- CACHE_STATIC_ROUTING_END -->

## Current Tasks (dynamic, always fresh)

- Task 1 (updated daily)
- Task 2 (varies)
```

### Agent Logic: Parse and Annotate

Agents separate the file into two parts:

```typescript
import { parseConfigMarkdown, annotateForCaching } from '@eidandev/config-cache';

// Load file (via fs_read tool)
const file = await tools.fs_read({ path: 'calendars.md' });

// Parse: separate static from dynamic
const { staticSections, dynamicContent } = parseConfigMarkdown(file.content);

// Use dynamic content fresh (no caching)
// Example: parse venture keywords from dynamicContent

// Annotate static sections for caching
const { text, cacheMetadata } = annotateForCaching('claude', staticSections, file.content);
// cacheMetadata tells the provider to cache these sections
```

### Provider Integration: Cache Control Headers

The framework adds provider-specific cache control metadata. The provider adapter (Claude/DeepSeek/OpenAI) reads this and adds headers:

- **Claude**: X-Custom-Cache-Control header on static text blocks
- **DeepSeek**: `cache_control: { type: "ephemeral" }` in request body
- **OpenAI**: `prompt_cache_control: { type: "ephemeral" }` metadata

(Integration at provider adapter level — `/packages/agents/src/runner.ts` + matbot provider modules.)

## Usage

### 1. Structure Your Config File

Add cache markers around immutable sections:

```markdown
# calendars.md

<!-- CACHE_STATIC_ROUTING_START -->
## Routing Rules (frozen)

| Calendar | Category |
|----------|----------|
| Work     | work     |
| ...      | ...      |
<!-- CACHE_STATIC_ROUTING_END -->

## Dynamic Ventures (updated daily)

| Venture | Keywords |
|---------|----------|
| eidan   | eidan, matbot |
| ...     | ...          |
```

### 2. In Your Agent Persona

```markdown
# My Agent Persona

You are an agent that processes events and classifies them by venture.

When you need to load configuration:

1. Use fs_read to load calendars.md
2. Parse the file:
   - Extract CACHE_STATIC sections (use them for classification logic)
   - Extract dynamic sections (venture keywords)
3. Reference cached rules in your reasoning:
   - "Using the cached routing table from calendars.md §1..."
   - "Current ventures from calendars.md §5 (dynamic, always fresh)..."

[Agent task details...]
```

### 3. Example Integration

Real example from `docs/config/calendars.md`:

```markdown
<!-- CACHE_STATIC_ROUTING_START -->
## 1. CATEGORISE (Routing rules)

| IF calendar / keyword matches | THEN category |
|------|---------|
| Calendar = "Work" | work |
| Calendar = "Personal" | personal |
| ...
<!-- CACHE_STATIC_ROUTING_END -->

## 5. VENTURE ROUTING (Dynamic)

| Keyword(s) | Venture | Board ID |
|---------|---------|----------|
| eidan, matbot | eidan | b5c77609-... |
| charles, venture capital | charles | a1b2c3d4-... |
| ...
```

Agent reads both:
- **§1 (cached)**: Routing rules stable → cache saves tokens
- **§5 (dynamic)**: Venture list updated daily → always read fresh

## Cache Markers Reference

| Marker | Purpose | Change frequency | Caching |
|--------|---------|------------------|---------|
| CACHE_STATIC_ROUTING | Category routing table | Rarely (per deploy) | ✓ Cached |
| CACHE_STATIC_CATEGORIES | Task category taxonomy | Rarely | ✓ Cached |
| CACHE_STATIC_RULES | Execution rules | Rarely | ✓ Cached |
| CACHE_STATIC_ESCALATION | Escalation thresholds | Rarely | ✓ Cached |
| CACHE_STATIC_EFFORT | Effort models | Rarely | ✓ Cached |
| Dynamic sections (no marker) | Current tasks, ventures, focus | Frequently | ✗ Always fresh |

## Implementation Details

### Cache Invalidation

- File hash is computed on load
- If file content changes → hash changes → cache drops (safe, conservative)
- No manual cache management needed

### In-Memory Cache

- Single instance: config parsed once per file per load
- Multi-instance (Postgres): cache metadata can be stored in `eidan.config_cache` for shared invalidation
- No operator action needed

### Provider Capability Detection

The framework detects provider capabilities:
- Claude: X-Custom-Cache-Control support ✓
- DeepSeek: Ephemeral cache support ✓
- OpenAI: Prompt cache control support ✓
- Other providers: Falls back to no caching (no error)

## Utilities Available

### Extract cache sections

```typescript
import { extractCacheSection, extractAllCacheSections } from '@eidandev/config-cache';

const section = extractCacheSection(markdown, 'routing');
// { name: 'routing', content: '...', startLine: 10, endLine: 25, ... }

const allSections = extractAllCacheSections(markdown);
// [{ name: 'routing', ... }, { name: 'escalation', ... }, ...]
```

### Parse with awareness

```typescript
import { parseConfigMarkdown } from '@eidandev/config-cache';

const { staticSections, dynamicContent } = parseConfigMarkdown(markdown);
// staticSections: CacheSection[]
// dynamicContent: string (everything outside cache blocks)
```

### Annotate for provider

```typescript
import { annotateForCaching } from '@eidandev/config-cache';

const { text, cacheMetadata } = annotateForCaching('claude', staticSections, markdown);
// cacheMetadata: { provider, sections, cacheStrategy, ... }
// Pass metadata to provider adapter
```

### Load with built-in caching

```typescript
import { loadConfigWithCache } from '@eidandev/config-cache';

const { parsed, cached, metadata } = await loadConfigWithCache(
  'calendars.md',
  fileContent,
  'claude'
);
// cached: true if file hash unchanged
// metadata: { fileHash, loadedAt, provider }
```

## Backward Compatibility

- Files without cache markers work as before (entire file treated as dynamic)
- Agents can mix cached + non-cached config files
- No breaking changes to fs_read or agent APIs

## Performance Impact

### Expected token savings

- ~15K tokens/week per agent reading config files
- Compounds across multiple agents + multiple config files
- Example: 5 agents × 2 config files = 150K tokens/week saved

### Cache hit conditions

1. Same file (by path)
2. File hash unchanged (same content)
3. Same provider (cache metadata is provider-specific)

All three must be true for cache hit.

## Next Steps for Operators

1. **Identify config files** used by your agents (calendars.md, routines.md, etc.)
2. **Add cache markers** around immutable sections
3. **Test with one agent** — run it several times, measure token usage
4. **Verify cache hits** — check provider-specific logs (optional, for debugging)
5. **Roll out to all agents** — update agent personas to reference cached sections

## Known Limitations

- Cache markers are file-level only (no per-line fine-tuning)
- File hash invalidation is conservative (any change drops cache)
- Multi-instance cache sharing requires Postgres implementation (TODO)
- Provider-level integration (cache_control headers) is manual per provider (TODO)

## References

- `@eidandev/config-cache`: Core library — `/packages/config-cache/src/index.ts`
- `@eidandev/agents`: Integration — `/packages/agents/src/config-loader.ts`
- Example files:
  - `/docs/config/calendars.md` — calendar event routing
  - `/docs/config/routines.md` — task definitions
