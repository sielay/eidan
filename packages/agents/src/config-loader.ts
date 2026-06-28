// SPDX-License-Identifier: AGPL-3.0-or-later

// Config loader documentation and conventions for agent config file caching.

// Agent persona helper: a template that agents can extend.
// This shows the recommended pattern for using cached config files.
export const AGENT_CONFIG_LOADER_TEMPLATE = `
# Loading config files with caching (agent pattern)

If your agent reads markdown config files (calendars.md, routines.md, etc.), use this pattern to enable prompt caching:

\`\`\`typescript
import { parseConfigMarkdown, annotateForCaching } from '@eidandev/config-cache';

// 1. Load the file (agents call fs_read tool)
const fileResult = await tools.fs_read({ path: 'calendars.md' });
const markdown = fileResult.content;

// 2. Parse into static (cached) and dynamic (fresh) sections
const { staticSections, dynamicContent } = parseConfigMarkdown(markdown);

// 3. Use dynamicContent in your logic (always fresh, respects operator intent)
// Example: parse venture routing from dynamicContent

// 4. Annotate static sections for the LLM's caching layer
const provider = 'claude'; // or 'deepseek', 'openai'
const { text: staticText, cacheMetadata } = annotateForCaching(provider, staticSections);

// 5. Pass cacheMetadata to the provider (framework integration point)
// This tells Claude/DeepSeek/OpenAI to cache the static sections
// (actual cache_control headers added at provider adapter level)
\`\`\`

## Cache markers in markdown

Mark static sections with:
\`\`\`markdown
<!-- CACHE_STATIC_<NAME>_START -->
... immutable content ...
<!-- CACHE_STATIC_<NAME>_END -->
\`\`\`

Multiple cache sections per file are OK (e.g., ROUTING, CATEGORIES, ESCALATION).

## Example: calendars.md

See docs/config/calendars.md for a real example:
- CACHE_STATIC_ROUTING_START/END: category routing table (never changes)
- CACHE_STATIC_EFFORT_MODELS_START/END: effort classifications (frozen)
- CACHE_STATIC_ESCALATION_START/END: escalation rules (stable)
- §5 (VENTURE ROUTING): dynamic, no cache markers, always fetches fresh

Agents reference cached rules like: "Use the cached routing table from calendars.md §1..."

## Implementation notes

- File hash tracking: if the file changes, the cache is invalidated (safe, conservative)
- Dynamic content: always read fresh (respects operator's ability to tweak behavior immediately)
- No operator action needed: structure is in the markdown, caching is automatic
- Multi-instance deployments: cache metadata can be stored in Postgres for shared invalidation
`;

// Convenience: document the cache section naming conventions
export const CACHE_SECTION_CONVENTIONS = {
  calendars_md: {
    routing: 'CACHE_STATIC_ROUTING',
    efforts: 'CACHE_STATIC_EFFORT_MODELS',
    escalation: 'CACHE_STATIC_ESCALATION',
  },
  routines_md: {
    categories: 'CACHE_STATIC_CATEGORIES',
    rules: 'CACHE_STATIC_EXECUTION_RULES',
    prompts: 'CACHE_STATIC_PROMPT_TEMPLATE',
  },
} as const;
