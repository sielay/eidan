// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotServices, Session, MessageContent, Principal } from '@matatbread/matbot-plugin-api';
import { runAs } from '@matatbread/matbot-plugin-api';
import type { AgentsStore } from './store.js';
import { expandSkillReferences, detectSkillReferences } from './skills/index.js';
import { AGENT_FOUNDATION } from './skills/agent-foundation.js';

interface ProviderCfg {
  name: string;
  module: string;
  model: string;
  endpoint?: string;
  credentials?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
}

// Per-turn model selection. The host exposes the live provider map as `services.providers`. When an
// agent specifies a `model`, clone its base provider profile (module/endpoint/credentials) with the
// model overridden and register it under a synthetic name — letting an agent run ANY model (e.g. any
// OpenRouter slug) without a restart or a hand-authored profile. No model ⇒ use the base provider.
export function effectiveProvider(services: MatbotServices, baseProvider: string, model: string | null): string {
  if (!model) return baseProvider;
  const providers = (services as unknown as { providers?: Map<string, ProviderCfg> }).providers;
  if (!providers) return baseProvider;
  const synthName = `${baseProvider}::${model}`;
  if (!providers.has(synthName)) {
    const base = providers.get(baseProvider);
    if (!base) return baseProvider; // unknown base — let it fail loudly at resolve time
    providers.set(synthName, { ...base, name: synthName, model });
  }
  return synthName;
}

function newSession(ownerId: string): Session {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), version: '0', ownerPrincipalId: ownerId, status: 'active',
    contexts: [], messages: [], createdAt: now, updatedAt: now,
  };
}

function lastAssistantText(s: Session): string {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m && m.role === 'assistant') {
      return m.content
        .filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    }
  }
  return '';
}

// Note: Core agent framing and role definitions are now part of AGENT_FOUNDATION skill (see
// packages/agents/src/skills/agent-foundation.ts). The foundation is either explicitly referenced
// via "[skill: Agent Foundation]" in the persona, or automatically prepended for backward
// compatibility with existing agents. The separator "— Your role and task —" is part of AGENT_FOUNDATION
// and appears consistently before the task-specific persona content.

// Run an agent's persona as a single turn under the owner's identity (so the conversation + memory
// writes persist as that user), using the agent's own provider. Returns the final assistant text and
// the conversation id (= the session id) so the caller can link the fire to its turn (agent_runs).
// Mirrors @eidandev/routines' runner, plus per-agent provider + conversation_id capture.
//
// Skill expansion: if persona references [skill: NAME], those expand before execution.
// If persona doesn't reference [skill: Agent Foundation], we prepend it for backward compatibility.
export async function runAgentTurn(
  services: MatbotServices,
  userId: string,
  persona: string,
  provider: string,
  onConversation?: (conversationId: string) => Promise<void>,
  timeoutMs?: number,
  // External abort (graceful shutdown). Composed with the per-turn timeout below: whichever fires
  // first aborts the turn. matbot's runner persists the partial session before yielding `aborted`.
  extSignal?: AbortSignal,
): Promise<{ text: string; conversationId: string }> {
  const run = services.run;
  const sessions = services.sessions;
  if (!run || !sessions) throw new Error('agents: runner/sessions unavailable');
  const principal: Principal = { id: userId, type: 'user' };
  return runAs(principal, async () => {
    const session = newSession(userId);
    await sessions.set(session.id, session);
    // Tag the conversation as agent-origin before the turn runs (keeps it out of the human sidebar).
    if (onConversation) await onConversation(session.id);

    // Build final persona first (with auto-prepended foundation reference if needed), then expand.
    // This ensures deduplication works correctly across both prepended and original skill references.
    // If persona doesn't reference [skill: Agent Foundation], prepend it for backward compatibility.
    // AGENT_FOUNDATION now contains the role separator ("— Your role and task —") and must always
    // be at the start of the expanded prompt. Strip any existing separator from the persona to avoid duplication.
    const referencedSkills = detectSkillReferences(persona);
    let finalPersona = persona;
    if (!referencedSkills.includes('agent-foundation')) {
      // Remove any existing "— Your role and task —" section to avoid duplication with AGENT_FOUNDATION's separator
      finalPersona = persona.replace(/^[\s\S]*?## — Your role and task —\s*/m, '');
      finalPersona = '[skill: Agent Foundation]\n\n' + finalPersona;
    }
    const expandedPersona = expandSkillReferences(finalPersona);

    const ac = new AbortController();
    const onExt = (): void => ac.abort(extSignal?.reason ?? 'shutdown');
    if (extSignal) {
      if (extSignal.aborted) ac.abort(extSignal.reason ?? 'shutdown');
      else extSignal.addEventListener('abort', onExt, { once: true });
    }
    // Hard cap: a slow/stuck provider (e.g. a local model grinding on a big prompt) must not run
    // forever — abort the turn so it records a failure instead. The loop detaches fires, but the
    // timeout also bounds resource use per fire.
    const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : undefined;
    try {
      const view = await run.open({
        sessionId: session.id, signal: ac.signal,
        content: [{ type: 'text', text: expandedPersona }], provider, principal,
      });
      let final: Session | undefined;
      for await (const ev of view.events) {
        if (ev.type === 'done') { final = ev.session; break; }
        if (ev.type === 'error') throw new Error(ev.error);
        if (ev.type === 'aborted') throw new Error(`aborted: ${ev.reason ?? 'timeout'}`);
      }
      return { text: final ? lastAssistantText(final) : '', conversationId: session.id };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (extSignal) extSignal.removeEventListener('abort', onExt);
    }
  });
}

// Preamble prepended to an agent's persona when re-firing it after a node restart interrupted its run.
// References the interrupted conversation so the agent can pick up where it left off (the partial turn
// was persisted before the abort) rather than starting blind.
export function continuationPreamble(conversationId: string | null): string {
  const ref = conversationId
    ? `Your previous run was interrupted mid-task; that conversation is \`${conversationId}\` (recall it for what you'd done so far). `
    : 'Your previous run was interrupted mid-task. ';
  return (
    `⏩ Resuming after a node restart (a deployment cut your last run short). ${ref}` +
    'Continue the task below from where you left off; avoid repeating work you had already completed.\n\n---\n\n'
  );
}

// Manual "run now" (test affordance, surfaced via POST /api/agents/:id/run). Starts the agent's turn
// under its OWN provider (+ model synthesis), tags the conversation as agent-origin, and returns the
// conversation id AS SOON AS it's created — the turn itself runs detached so the HTTP request doesn't
// block on a long agent run (and can't hit a proxy/gateway timeout). No agent_runs row is written: the
// run ledger is keyed by a trigger, and a manual test has none. Returns null if the agent is gone.
export async function fireAgentNow(
  services: MatbotServices,
  store: AgentsStore,
  agentId: string,
  userId: string,
  opts: { defaultProvider: string; turnTimeoutMs?: number },
): Promise<{ conversationId: string } | null> {
  const agent = await store.getAgent(agentId, userId);
  if (!agent) return null;
  const provider = effectiveProvider(services, agent.provider ?? opts.defaultProvider, agent.model);
  let resolveId: (id: string) => void;
  const idReady = new Promise<string>((r) => { resolveId = r; });
  void runAgentTurn(
    services, userId, agent.persona, provider,
    async (cid) => { await store.markAgentConversation(cid, agentId, agent.name); resolveId(cid); },
    opts.turnTimeoutMs,
  ).catch((e) => console.warn(`[agents] run-now "${agent.name}" failed:`, e instanceof Error ? e.message : e));
  return { conversationId: await idReady };
}

// Autonomous agent→agent delegation (the `agent_to_agent` relationship's runtime). Fire the target
// agent NOW with a delegated task prepended to its persona, under the same owner. Detached like
// fireAgentNow — returns the new conversation id as soon as it exists. A delegation chain is bounded
// by `depth` (a hard runaway backstop) + the caller's per-window rate cap; nothing here blocks on a
// human. Returns null if the target is gone or the depth cap is hit.
const MAX_DELEGATION_DEPTH = 6;
export async function fireAgentDelegate(
  services: MatbotServices,
  store: AgentsStore,
  toAgentId: string,
  task: string,
  userId: string,
  opts: { defaultProvider: string; turnTimeoutMs?: number | undefined; fromName?: string | undefined; depth?: number | undefined },
): Promise<{ conversationId: string } | null> {
  const depth = opts.depth ?? 1;
  if (depth > MAX_DELEGATION_DEPTH) {
    console.warn(`[agents] delegation depth cap (${MAX_DELEGATION_DEPTH}) hit — refusing to fire ${toAgentId}`);
    return null;
  }
  const agent = await store.getAgent(toAgentId, userId);
  if (!agent) return null;
  const provider = effectiveProvider(services, agent.provider ?? opts.defaultProvider, agent.model);
  const from = opts.fromName ? `from agent "${opts.fromName}" ` : '';
  const content =
    `## Delegated task ${from}(autonomous agent-to-agent hand-off, depth ${depth}/${MAX_DELEGATION_DEPTH})\n\n` +
    `${task}\n\n---\n\n${agent.persona}`;
  let resolveId: (id: string) => void;
  const idReady = new Promise<string>((r) => { resolveId = r; });
  void runAgentTurn(
    services, userId, content, provider,
    async (cid) => { await store.markAgentConversation(cid, toAgentId, agent.name); resolveId(cid); },
    opts.turnTimeoutMs,
  ).catch((e) => console.warn(`[agents] delegate to "${agent.name}" failed:`, e instanceof Error ? e.message : e));
  return { conversationId: await idReady };
}
