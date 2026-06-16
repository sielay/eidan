// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure builder for the A2A agent card (the /.well-known/agent-card.json document an A2A client
// fetches to discover this agent). No runtime deps, so it is unit-testable. See docs/0014-interop.md.

export interface AgentIdentity {
  name: string;
  description: string;
  url: string;
}

export function agentCard(o: AgentIdentity): Record<string, unknown> {
  return {
    name: o.name,
    description: o.description,
    url: o.url,
    version: '0.1.0',
    protocolVersion: '0.2.5',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [{ id: 'chat', name: 'chat', description: 'Converse with eidan; reads and writes your relational memory.', tags: ['memory', 'chat'] }],
  };
}
