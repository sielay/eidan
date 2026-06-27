// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotServices } from '@matatbread/matbot-plugin-api';
import { AgentsStore, type DueScheduleRow, type RestartRow } from './store.js';
import { dueWindow } from './schedule.js';
import { runAgentTurn, effectiveProvider, continuationPreamble } from './runner.js';

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
  // Set the instant a graceful shutdown begins, so an in-flight fire that gets aborted by the shutdown
  // handler doesn't ALSO record itself 'failed' / escalate — the handler owns its 'interrupted' record.
  let shuttingDown = false;
  const pollMs = opts.pollMs ?? 60_000;
  const grace = opts.graceMinutes ?? 30;
  // This node's id. An agent pinned to a target_node is only fired by that node (e.g. an ollama agent
  // must run on the node that has ollama). Unpinned agents may be fired by any node.
  const nodeId = process.env['EIDAN_NODE_ID'] ?? null;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  // In-flight scheduled fires, keyed by fireKey, so the shutdown handler can abort each turn and queue
  // it for resume. `conversationId` is filled once the turn creates its session (markAgentConversation).
  interface InFlight { row: DueScheduleRow; fireKey: string; ac: AbortController; conversationId: string | null }
  const inFlight = new Map<string, InFlight>();

  const fire = async (row: DueScheduleRow, fireKey: string): Promise<void> => {
    const provider = effectiveProvider(services, row.provider ?? opts.defaultProvider, row.model);
    const entry: InFlight = { row, fireKey, ac: new AbortController(), conversationId: null };
    inFlight.set(fireKey, entry);
    try {
      const { text, conversationId } = await runAgentTurn(
        services, row.user_id, row.persona, provider,
        async (cid) => { entry.conversationId = cid; await store.markAgentConversation(cid, row.agent_id, row.name); },
        opts.turnTimeoutMs,
        entry.ac.signal,
      );
      const body = text.trim() ? text.trim() : '(agent produced no text)';
      const notify = (services as { Notify?: NotifyLike }).Notify;
      await notify?.emit('agent', `🤖 ${row.name}\n\n${body}`, 'info');
      await store.finishRun(row.trigger_id, fireKey, 'delivered', body, conversationId);
      console.log(`[agents] fired "${row.name}" (agent ${row.agent_id}, provider=${provider}) for ${fireKey}`);
    } catch (e) {
      // A graceful-shutdown abort is not a failure: the shutdown handler records it 'interrupted' and
      // queues the resume. Bail out here so it doesn't pollute the failure streak or escalate.
      if (shuttingDown || entry.ac.signal.aborted) return;
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
    } finally {
      inFlight.delete(fireKey);
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

  // Graceful shutdown (matbot calls this via the plugin's teardown() on SIGTERM/SIGINT). Stop the
  // scan, then for every in-flight turn: abort it (matbot persists the partial session), queue a
  // continuation row, record the run 'interrupted' (not 'failed' → no escalation), and tell the user
  // it will resume after restart. The host awaits this before exiting, so the writes complete; we cap
  // the wait so a slow turn can't wedge the deploy.
  return async (): Promise<void> => {
    stopped = true;
    shuttingDown = true;
    const entries = [...inFlight.values()];
    if (entries.length === 0) return;
    const notify = (services as { Notify?: NotifyLike }).Notify;
    console.log(`[agents] shutdown: interrupting + queuing ${entries.length} in-flight run(s) for resume`);
    const reason = 'node restart (deploy) — interrupted mid-run, queued for resume';
    await Promise.allSettled(entries.map(async (e) => {
      e.ac.abort('shutdown');
      try {
        await store.enqueueRestart({
          agentId: e.row.agent_id, triggerId: e.row.trigger_id, userId: e.row.user_id,
          conversationId: e.conversationId, fireKey: e.fireKey, nodeId, reason,
          state: { persona: e.row.persona, provider: e.row.provider, model: e.row.model, name: e.row.name },
        });
        await store.finishRun(e.row.trigger_id, e.fireKey, 'interrupted', reason, e.conversationId);
        await notify?.emit(
          'agent',
          `🤖 ${e.row.name}\n\n⏸️ Interrupted by a node restart (deploy).` +
            `${e.conversationId ? ` I saved my place (conversation ${e.conversationId}).` : ''}` +
            ' I will pick this up again as soon as the node is back.',
          'warning',
        );
      } catch (err) {
        console.warn('[agents] shutdown queue failed:', err instanceof Error ? err.message : err);
      }
    }));
    // Brief grace so the just-aborted turns can flush their partial session (matbot persists at the
    // abort checkpoint) before the host exits — gives the resume something to reference. Bounded so it
    // never wedges a deploy.
    await sleep(1_500);
  };
}

// Re-fire the continuations queued by a prior graceful shutdown. Called once at boot (after the loop
// starts). Atomically claims this node's pending rows, then runs each as a detached continuation turn
// (persona prefixed with a note referencing the interrupted conversation). Best-effort: a deploy that
// cut a run short is not the agent's fault, so failures here are logged, never escalated.
export async function resumePendingRestarts(services: MatbotServices, store: AgentsStore, opts: AgentsLoopOpts): Promise<void> {
  const nodeId = process.env['EIDAN_NODE_ID'] ?? null;
  let rows: RestartRow[];
  try {
    rows = await store.claimPendingRestarts(nodeId);
  } catch (e) {
    console.warn('[agents] resume scan failed:', e instanceof Error ? e.message : e);
    return;
  }
  if (rows.length === 0) return;
  const notify = (services as { Notify?: NotifyLike }).Notify;
  console.log(`[agents] resuming ${rows.length} interrupted run(s) from the restart queue`);
  for (const row of rows) {
    const persona = row.state?.persona;
    if (!persona) continue; // nothing to re-fire (malformed/legacy row)
    const name = row.state.name ?? 'agent';
    const provider = effectiveProvider(services, row.state.provider ?? opts.defaultProvider, row.state.model ?? null);
    const content = continuationPreamble(row.conversation_id) + persona;
    void runAgentTurn(
      services, row.user_id, content, provider,
      (cid) => store.markAgentConversation(cid, row.agent_id, name),
      opts.turnTimeoutMs,
    )
      .then(async ({ text }) => {
        const body = text.trim() || '(agent produced no text)';
        await notify?.emit('agent', `🤖 ${name} (resumed)\n\n${body}`, 'info');
      })
      .catch((e) => console.warn(`[agents] resume "${name}" failed:`, e instanceof Error ? e.message : e));
  }
}
