// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotServices } from '@matatbread/matbot-plugin-api';
import { AgentsStore, type DueScheduleRow } from './store.js';
import { dueWindow } from './schedule.js';
import { runAgentTurn, effectiveProvider } from './runner.js';

export interface AgentsLoopOpts {
  defaultProvider: string;
  pollMs?: number;
  graceMinutes?: number;
  /** Hard cap per fire; a turn that exceeds it is aborted and recorded as failed. */
  turnTimeoutMs?: number;
}

// @eidandev/notify augments MatbotServices with `Notify`; agents does not depend on it — we narrow to
// the one method we call. Missing service / unrouted topic ⇒ the call is a no-op.
interface NotifyLike {
  emit(topic: string, text: string, severity?: string): Promise<void>;
}

// @eidandev/escalations registers `Escalations`; narrowed here so agents has no hard dependency on it.
interface EscalationsLike {
  raise(args: {
    userId?: string;
    severity: string;
    reasonClass: string;
    suggestedAction?: string;
    evidence?: unknown[];
    agentId?: string;
  }): Promise<{ id: string } | null>;
  list(args: {
    userId?: string;
    fromAgent?: string;
    toAgent?: string;
    status?: string;
    limit?: number;
  }): Promise<Array<{
    id: string;
    to_agent: string | null;
    trigger_prompt: string | null;
    response: { feedback?: string } | null;
    responded_at: string | null;
  }>>;
}

// Escalate an agent to the operator's Inbox after this many consecutive failed fires (deduped per
// agent by the Escalations service, so it raises once per failure streak, not every tick).
const FAIL_STREAK_TO_ESCALATE = 3;

// Detached dispatch loop. Every pollMs it scans all enabled schedule triggers (joined with their
// enabled agent); for each one due in the current window (owner timezone) it claims the fire
// (cross-node unique guard), runs the agent's persona as a turn under the agent's OWN provider, links
// the produced conversation, and delivers on the `agent` notify topic. The schedule trigger is slice 1
// of the agents/triggers model; sensor + webhook triggers will add their own dispatch paths.
export function startAgentsLoop(services: MatbotServices, store: AgentsStore, opts: AgentsLoopOpts): () => Promise<void> {
  let stopped = false;
  const pollMs = opts.pollMs ?? 60_000;
  const grace = opts.graceMinutes ?? 30;
  // This node's id. An agent pinned to a target_node is only fired by that node (e.g. an ollama agent
  // must run on the node that has ollama). Unpinned agents may be fired by any node.
  const nodeId = process.env['EIDAN_NODE_ID'] ?? null;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  // escalation ids and their seen timestamps (for pruning); prune entries >1h old
  const trackedResponses = new Map<string, number>();
  const maxAgeMs = 60 * 60 * 1000; // 1 hour

  const fire = async (row: DueScheduleRow, fireKey: string, overridePersona?: string): Promise<void> => {
    const provider = effectiveProvider(services, row.provider ?? opts.defaultProvider, row.model);
    const persona = overridePersona ?? row.persona;
    try {
      const { text, conversationId } = await runAgentTurn(
        services, row.user_id, persona, provider,
        (cid) => store.markAgentConversation(cid, row.agent_id, row.name),
        opts.turnTimeoutMs,
      );
      const body = text.trim() ? text.trim() : '(agent produced no text)';
      const notify = (services as { Notify?: NotifyLike }).Notify;
      await notify?.emit('agent', `🤖 ${row.name}\n\n${body}`, 'info');
      await store.finishRun(row.trigger_id, fireKey, 'delivered', body, conversationId);
      console.log(`[agents] fired "${row.name}" (agent ${row.agent_id}, provider=${provider}) for ${fireKey}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await store.finishRun(row.trigger_id, fireKey, 'failed', msg, null).catch(() => undefined);
      console.warn(`[agents] "${row.name}" (agent ${row.agent_id}) failed for ${fireKey}: ${msg}`);
      // After a run of consecutive failures, raise it to the operator's Inbox (best-effort; the
      // Escalations service dedupes per agent so this fires once per streak, not every tick).
      try {
        const streak = await store.recentFailureStreak(row.agent_id);
        if (streak >= FAIL_STREAK_TO_ESCALATE) {
          const esc = (services as { Escalations?: EscalationsLike }).Escalations;
          await esc?.raise({
            userId: row.user_id,
            severity: 'medium',
            reasonClass: 'external_failure',
            suggestedAction: `Agent "${row.name}" has failed ${streak} runs in a row (last error: ${msg}). Check its provider/config, or pause it.`,
            evidence: [`error: ${msg}`, `fire_key: ${fireKey}`],
            agentId: row.agent_id,
          });
        }
      } catch {
        /* escalation is best-effort — never break the loop on it */
      }
    }
  };

  const handleResponses = async (): Promise<void> => {
    try {
      // Prune old tracked responses to prevent memory leak
      const now = Date.now();
      for (const [id, ts] of trackedResponses.entries()) {
        if (now - ts > maxAgeMs) {
          trackedResponses.delete(id);
        }
      }

      const agents = await store.responseTriggeredAgents();
      const esc = (services as { Escalations?: EscalationsLike }).Escalations;
      if (!esc) return; // escalations service not available

      for (const a of agents) {
        if (a.target_node && a.target_node !== nodeId) continue; // pinned to another node
        const responses = await esc.list({
          userId: a.user_id,
          toAgent: a.name,
          status: 'responded',
          limit: 10,
        });
        for (const resp of responses) {
          if (trackedResponses.has(resp.id)) continue; // already handled
          if (!resp.responded_at) continue; // shouldn't happen but safety check
          trackedResponses.set(resp.id, Date.now());

          // Blend the trigger prompt into the persona
          const feedback = resp.response?.feedback ?? '';
          const prompt = resp.trigger_prompt ?? feedback;
          const blendedPersona = `${a.persona}\n\n[Escalation response] ${prompt}`;
          const fireKey = `response:${resp.id}`;

          const won = await store.claimRun(a.trigger_id, a.agent_id, a.user_id, fireKey);
          if (!won) continue; // another node is handling this fire
          void fire(a as DueScheduleRow, fireKey, blendedPersona);
        }
      }
    } catch (e) {
      console.warn('[agents] response scan error:', e instanceof Error ? e.message : e);
    }
  };

  const tick = async (): Promise<void> => {
    const rows = await store.dueScheduleScan();
    for (const r of rows) {
      if (!r.schedule) continue;
      if (r.target_node && r.target_node !== nodeId) continue; // pinned to another node
      const tz = await store.userTimeZone(r.user_id);
      const fireKey = dueWindow(r.schedule, new Date(), tz, grace);
      if (!fireKey) continue;
      const won = await store.claimRun(r.trigger_id, r.agent_id, r.user_id, fireKey);
      if (!won) continue; // another node is handling this fire
      // Detached: a slow/stuck fire must not block the other due agents or the next scan. fire()
      // owns its full lifecycle (finish/escalate in its own try/catch); the per-fire timeout bounds it.
      void fire(r, fireKey);
    }
    // Response-triggered fires: scan and handle with proper error handling
    await handleResponses();
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await tick();
      } catch (e) {
        console.warn('[agents] scan error:', e instanceof Error ? e.message : e);
      }
      await sleep(pollMs);
    }
  };
  void loop();
  return async () => { stopped = true; };
}
