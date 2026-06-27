// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotServices } from '@matatbread/matbot-plugin-api';
import { AgentsStore, type DueScheduleRow, type FireableRow } from './store.js';
import { dueWindow } from './schedule.js';
import { runAgentTurn, effectiveProvider } from './runner.js';

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
    user_id: string | null;
    to_agent: string | null;
    trigger_prompt: string | null;
    response: { feedback?: string } | null;
    responded_at: string | null;
    agent_response_processed_at: string | null;
  }>>;
  markResponseProcessed(id: string): Promise<void>;
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    Notify?: NotifyLike;
    Escalations?: EscalationsLike;
  }
}

export interface AgentsLoopOpts {
  defaultProvider: string;
  pollMs?: number;
  responsePollMs?: number;
  graceMinutes?: number;
  /** Hard cap per fire; a turn that exceeds it is aborted and recorded as failed. */
  turnTimeoutMs?: number;
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
  const responsePollMs = opts.responsePollMs ?? 5_000;
  const grace = opts.graceMinutes ?? 30;
  // This node's id. An agent pinned to a target_node is only fired by that node (e.g. an ollama agent
  // must run on the node that has ollama). Unpinned agents may be fired by any node.
  const nodeId = process.env['EIDAN_NODE_ID'] ?? null;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const fire = async (row: FireableRow, fireKey: string, overridePersona?: string): Promise<void> => {
    const provider = effectiveProvider(services, row.provider ?? opts.defaultProvider, row.model);
    const persona = overridePersona ?? row.persona;
    try {
      const { text, conversationId } = await runAgentTurn(
        services, row.user_id, persona, provider,
        (cid) => store.markAgentConversation(cid, row.agent_id, row.name),
        opts.turnTimeoutMs,
      );
      const body = text.trim() ? text.trim() : '(agent produced no text)';
      await services.Notify?.emit('agent', `🤖 ${row.name}\n\n${body}`, 'info');
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
          await services.Escalations?.raise({
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

  const handleResponses = async (esc: EscalationsLike): Promise<void> => {
    let totalProcessed = 0;
    const maxPerTick = 20; // Limit responses processed per tick to prevent DB thrashing

    try {
      const agents = await store.responseTriggeredAgents();

      // Batch-fetch all responses for all agents in parallel to reduce DB queries
      const agentResponses = await Promise.all(
        agents
          .filter(a => !a.target_node || a.target_node === nodeId)
          .map(a =>
            esc.list({
              userId: a.user_id,
              toAgent: a.agent_id,
              status: 'responded',
              limit: 10,
            }).then(responses => ({ agent: a, responses }))
          )
      );

      for (const { agent: a, responses } of agentResponses) {
        for (const resp of responses) {
          if (totalProcessed >= maxPerTick) break;
          // Skip if already processed by agent system (checked via agent_response_processed_at)
          if (resp.agent_response_processed_at) continue;
          if (!resp.responded_at) continue; // shouldn't happen but safety check

          // Blend the trigger prompt into the persona
          const feedback = resp.response?.feedback ?? '';
          const triggerPrompt = resp.trigger_prompt;

          // Use trigger_prompt if available (prepared at raise time), else fall back to operator feedback
          const promptSuffix = triggerPrompt || (feedback ? `[Response feedback] ${feedback}` : '');
          const blendedPersona = promptSuffix ? `${a.persona}\n\n${promptSuffix}` : a.persona;
          const fireKey = `response:${resp.id}`;

          const won = await store.claimRun(a.trigger_id, a.agent_id, a.user_id, fireKey);
          if (!won) continue; // another node is handling this fire

          // Non-blocking fire: allows concurrent processing of responses across agents while
          // claimRun ensures only one node processes each response. Responses are marked
          // processed after fire completes (fire handles both success and failure).
          void fire(a, fireKey, blendedPersona);
          totalProcessed++;

          // Mark response as processed after fire (whether succeeded or failed—fire handles both)
          await esc.markResponseProcessed(resp.id).catch(() => {
            /* best-effort; don't fail loop for escalation metadata */
          });
        }
        if (totalProcessed >= maxPerTick) break;
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
  };

  // Separate response handling loop: decoupled from schedule scanning for better latency and resilience.
  // Runs independently every responsePollMs, fetching responses for agents with response triggers.
  const responseLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        if (services.Escalations) {
          await handleResponses(services.Escalations);
        }
      } catch (e) {
        console.warn('[agents] response handler error:', e instanceof Error ? e.message : e);
      }
      await sleep(responsePollMs);
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await tick();
      } catch (e) {
        console.warn('[agents] schedule scan error:', e instanceof Error ? e.message : e);
      }
      await sleep(pollMs);
    }
  };
  void loop();
  void responseLoop();
  return async () => { stopped = true; };
}
