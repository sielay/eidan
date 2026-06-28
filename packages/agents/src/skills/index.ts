// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Agent Skills: cached foundation documents for prompt efficiency and consistency.
 *
 * Skills are reusable, provider-agnostic knowledge bases that agents reference in their personas.
 * The runner expands skill references (e.g., "[skill: Agent Foundation]") before execution,
 * allowing providers to cache the expanded content via prompt caching headers.
 *
 * Design:
 * - Skills are versioned and immutable (new versions as needed).
 * - Personas reference skills declaratively ("[skill: NAME]"); the runner resolves at fire time.
 * - Backward-compatible: personas without skill references work as before.
 * - Cache-aware: providers that support caching (Claude, DeepSeek, OpenAI) mark expanded skills.
 */

import { AGENT_FOUNDATION, AGENT_FOUNDATION_ID } from './agent-foundation.js';
import { FUNCTION_CALL_HARDENING, FUNCTION_CALL_HARDENING_ID } from './function-call-hardening.js';

export { AGENT_FOUNDATION, AGENT_FOUNDATION_ID } from './agent-foundation.js';
export { FUNCTION_CALL_HARDENING, FUNCTION_CALL_HARDENING_ID } from './function-call-hardening.js';

export interface Skill {
  id: string;
  name: string;
  version: string;
  content: string;
  cacheable: boolean; // true if this skill should be wrapped in cache_control markers
  description: string;
}

export const BUILTIN_SKILLS: Record<string, Skill> = {
  'agent-foundation': {
    id: 'agent-foundation',
    name: 'Agent Foundation',
    version: '1.0',
    cacheable: true,
    description: 'Core rules, hard constraints, and behavioral patterns for all agents.',
    content: AGENT_FOUNDATION,
  },
  'function-call-hardening': {
    id: 'function-call-hardening',
    name: 'Function Call Hardening',
    version: '1.0',
    cacheable: true,
    description: 'Provider-specific function call formatting and error recovery patterns.',
    content: FUNCTION_CALL_HARDENING,
  },
};

/**
 * Expand skill references in a persona string.
 * Replaces "[skill: NAME]" with the full skill content.
 *
 * Example:
 *   "You are a daily digest agent. [skill: Agent Foundation] Your task: summarize emails."
 *   ↓
 *   "You are a daily digest agent. <full content of Agent Foundation skill> Your task: summarize emails."
 *
 * Supports both hyphenated and space-separated skill names:
 *   "[skill: Agent Foundation]" → agent-foundation
 *   "[skill: agent-foundation]" → agent-foundation
 *
 * Deduplicates: if the same skill is referenced multiple times, its content appears only once (first reference).
 */
export function expandSkillReferences(persona: string): string {
  let expanded = persona;
  const skillRefPattern = /\[skill:\s*([^\]]+)\]/gi;
  const expandedSkills = new Set<string>();

  for (const match of persona.matchAll(skillRefPattern)) {
    const skillName = (match[1] ?? '').trim();
    // Normalize: spaces → hyphens, lowercase
    const normalized = skillName.replace(/\s+/g, '-').toLowerCase();
    const skill = BUILTIN_SKILLS[normalized];

    if (skill && !expandedSkills.has(normalized)) {
      // First occurrence: replace with content and mark as expanded
      expanded = expanded.replace(match[0], skill.content);
      expandedSkills.add(normalized);
    } else if (skill && expandedSkills.has(normalized)) {
      // Duplicate: replace with newline to maintain prompt structure (not empty string, which can cause formatting issues)
      expanded = expanded.replace(match[0], '\n');
    }
  }

  return expanded;
}

/**
 * Detect which skills a persona references.
 * Useful for logging, analytics, and understanding cache potential.
 * Returns a deduplicated list of normalized skill IDs.
 */
export function detectSkillReferences(persona: string): string[] {
  const skillRefPattern = /\[skill:\s*([^\]]+)\]/gi;
  const refs = new Set<string>();
  for (const match of persona.matchAll(skillRefPattern)) {
    const skillName = (match[1] ?? '').trim();
    // Normalize: spaces → hyphens, lowercase
    const normalized = skillName.replace(/\s+/g, '-').toLowerCase();
    if (BUILTIN_SKILLS[normalized]) {
      refs.add(normalized);
    }
  }
  return Array.from(refs);
}

/**
 * Wrap skill content for prompt caching.
 * Different providers use different markers; this centralizes the pattern.
 *
 * Claude: Uses X-Custom header (handled by the provider adapter).
 * DeepSeek: Includes special comments or tags (provider-specific).
 * OpenAI: Uses system prompt structure (handled by the provider adapter).
 *
 * For now, we just mark content; the provider-specific wrapping happens in runner.
 */
export function wrapForCaching(content: string, skillId: string): string {
  return `<!-- cached skill: ${skillId} -->\n${content}\n<!-- end cached skill: ${skillId} -->`;
}
