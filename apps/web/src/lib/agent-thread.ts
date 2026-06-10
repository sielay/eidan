// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Parse the agent-name prefix from a conversation title (#154 /
 * docs/014). Agent-spawned threads use a `[<agent_name>] ...`
 * convention — for instance the git plugin's poller titles
 * conversations `[git] sielay/eidan-sage#8 (sage)`, the sentry
 * tick titles its escalation thread `[sentry] hot_pattern`, etc.
 *
 * Returns the agent name (lowercased, allowed chars per the
 * plugin-id pattern) when the title matches, otherwise null.
 * Human-started chats have a free-form or absent title and fall
 * through to null.
 */
const AGENT_PREFIX = /^\[([a-z0-9][a-z0-9-]*)\](?:\s|$)/;

export function parseAgentName(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;
  const match = AGENT_PREFIX.exec(trimmed);
  return match ? match[1] : null;
}

export type ThreadKindFilter = "all" | "agents" | "chats";

export const THREAD_KIND_FILTERS: readonly ThreadKindFilter[] = [
  "all",
  "agents",
  "chats",
];

export function filterMatches(
  filter: ThreadKindFilter,
  agentName: string | null,
): boolean {
  if (filter === "all") return true;
  if (filter === "agents") return agentName !== null;
  return agentName === null;
}
