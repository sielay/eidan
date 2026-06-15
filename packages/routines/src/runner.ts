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

// Run a routine's prompt as a single agent turn under the owner's identity (so the conversation and
// any memory writes persist as that user), and return the final assistant text. Mirrors the jobs
// plugin's default turn handler — kept local so routines doesn't reach into another plugin's internals.
export async function runRoutineTurn(
  services: MatbotServices,
  userId: string,
  prompt: string,
  provider: string,
): Promise<string> {
  const run = services.run;
  const sessions = services.sessions;
  if (!run || !sessions) throw new Error('routines: runner/sessions unavailable');
  const principal: Principal = { id: userId, type: 'user' };
  return runAs(principal, async () => {
    const session = newSession(userId);
    await sessions.set(session.id, session);
    const ac = new AbortController();
    const view = await run.open({
      sessionId: session.id, signal: ac.signal,
      content: [{ type: 'text', text: prompt }], provider, principal,
    });
    let final: Session | undefined;
    for await (const ev of view.events) {
      if (ev.type === 'done') { final = ev.session; break; }
      if (ev.type === 'error') throw new Error(ev.error);
      if (ev.type === 'aborted') throw new Error(`aborted: ${ev.reason}`);
    }
    return final ? lastAssistantText(final) : '';
  });
}
