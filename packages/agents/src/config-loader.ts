// SPDX-License-Identifier: AGPL-3.0-or-later

// Config file conventions for two-tier static/dynamic sections.
// Operators can mark immutable sections of markdown config files to distinguish them from dynamic content.
// Caching integration happens at the provider adapter layer (e.g., Anthropic adapter sets cache_control
// on tool_result turns per #487), not in the agent config loading path.

export const AGENT_CONFIG_CONVENTIONS = `
# Config file structure conventions

## Static vs dynamic sections

Agent config files (calendars.md, routines.md) may contain both:
- **Static sections** (routing tables, category definitions, templates) — immutable, may be cached by provider adapters
- **Dynamic sections** (current tasks, keywords) — change frequently, always read fresh from the file

## Marking sections in markdown

Mark static sections with HTML comment boundaries:

\`\`\`markdown
<!-- CACHE_STATIC_<NAME>_START -->
## Section Title

Content here (routing table, categories, rules, etc.)
<!-- CACHE_STATIC_<NAME>_END -->

## Dynamic Section

This section has no markers, always read fresh.
\`\`\`

Multiple static sections per file are supported (ROUTING, CATEGORIES, RULES, etc.).

## Agent loading pattern

When an agent reads a config file:
1. Load the file via fs_read() (or equivalent)
2. Parse it manually or with provider-specific utilities
3. Use dynamic sections (no markers) immediately for runtime logic
4. Use static sections for reference or template data

The provider adapter (Claude, DeepSeek, OpenAI) may use the markers to apply caching,
but agents do not need to be aware of caching — it's transparent at the adapter layer.

## Example: calendars.md

\`\`\`markdown
# calendars.md

<!-- CACHE_STATIC_ROUTING_START -->
## 1. CATEGORISE (Routing rules)

| IF calendar / keyword matches | THEN category |
|------|---------|
| Calendar = "Work" | work |
| ... |
<!-- CACHE_STATIC_ROUTING_END -->

## 5. VENTURE ROUTING (Dynamic)

| Keyword(s) | Venture | Board ID |
|---------|---------|----------|
| eidan, matbot | eidan | b5c... |
\`\`\`

Static section (CACHE_STATIC_ROUTING) rarely changes and may be cached.
Dynamic section (VENTURE ROUTING) has no markers and is always fresh.
`;

// Naming conventions for common agent config files
export const CACHE_SECTION_CONVENTIONS = {
  calendars_md: ['ROUTING', 'EFFORT_MODELS', 'ESCALATION'],
  routines_md: ['CATEGORIES', 'EXECUTION_RULES', 'PROMPT_TEMPLATE'],
} as const;
