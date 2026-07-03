// SPDX-License-Identifier: AGPL-3.0-or-later

export function sanitizeAgentName(name: string | null | undefined): string {
  if (!name) return 'agent';
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'agent';
}

export function buildAgentTitle(agentName: string | null | undefined, baseTitle: string | null | undefined): string {
  const sanitized = sanitizeAgentName(agentName);
  const suffix = baseTitle || agentName;
  return suffix ? `[${sanitized}] ${suffix}` : `[${sanitized}]`;
}
