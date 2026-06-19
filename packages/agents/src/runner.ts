// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotServices, Session, MessageContent, Principal } from '@matatbread/matbot-plugin-api';
import { runAs } from '@matatbread/matbot-plugin-api';

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

// Run an agent's persona as a single turn under the owner's identity (so the conversation + memory
// writes persist as that user), using the agent's own provider. Returns the final assistant text and
// the conversation id (= the session id) so the caller can link the fire to its turn (agent_runs).
// Mirrors @eidandev/routines' runner, plus per-agent provider + conversation_id capture.
export async function runAgentTurn(
  services: MatbotServices,
  userId: string,
  persona: string,
  provider: string,
  onConversation?: (conversationId: string) => Promise<void>,
  timeoutMs?: number,
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
    const ac = new AbortController();
    // Hard cap: a slow/stuck provider (e.g. a local model grinding on a big prompt) must not run
    // forever — abort the turn so it records a failure instead. The loop detaches fires, but the
    // timeout also bounds resource use per fire.
    const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : undefined;
    try {
      const view = await run.open({
        sessionId: session.id, signal: ac.signal,
        content: [{ type: 'text', text: persona }], provider, principal,
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
    }
  });
}
