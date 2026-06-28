// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotServices, Session, Principal } from '@matatbread/matbot-plugin-api';
import { runAs } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { lastAssistantText } from './session-text.js';

interface LlmCall {
  userId: string; conversationId?: string; messageId?: string; provider: string; model: string;
  inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number;
  costUsd?: number; requestId?: string; role?: string;
}
interface LlmCalls { record(call: LlmCall): Promise<void> }
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    LlmCalls?: LlmCalls;
  }
}

export interface Job {
  id: string;
  kind: string;
  goal: string;
  payload: Record<string, unknown>;
  surface: string | null;
  user_id: string | null;
  // Per-job execution overrides (#407 targeting); null = the handler's defaults. target_node is
  // enforced at claim time, so a claimed job is already on the right node.
  model?: string | null;
  provider?: string | null;
}

// A handler runs one claimed job to completion and returns its result (stored on eidan.jobs.result).
// Throwing marks the job failed. Bundles register kind-specific handlers (e.g. Sage for 'code').
export type JobHandler = (job: Job, services: MatbotServices) => Promise<{ result?: unknown }>;

export interface JobHandlers {
  register(kind: string, handler: JobHandler): void;
  get(kind: string): JobHandler | undefined;
}

export class JobHandlerRegistry implements JobHandlers {
  private readonly handlers = new Map<string, JobHandler>();
  register(kind: string, handler: JobHandler): void { this.handlers.set(kind, handler); }
  get(kind: string): JobHandler | undefined { return this.handlers.get(kind); }
}

function newSession(ownerId: string): Session {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), version: '0', ownerPrincipalId: ownerId, status: 'active',
    contexts: [], messages: [], createdAt: now, updatedAt: now,
  };
}


// The default handler for an otherwise-unhandled kind: run the job's goal as a single agent turn
// through the runner and capture the final assistant text. Conversations are user-scoped, so it
// needs job.user_id.
export function makeTurnHandler(provider: string): JobHandler {
  return async (job, services) => {
    const run = services.run;
    const sessions = services.sessions;
    if (!run || !sessions) throw new Error('jobs: runner/sessions unavailable');
    if (!job.user_id) throw new Error('jobs: default turn handler needs job.user_id (conversations are user-scoped)');
    const principal: Principal = { id: job.user_id, type: 'user' };
    // Run the whole turn under the job's identity, so the session + messages persist as the
    // delegating user — not the worker's boot principal (which isn't even a real users.id).
    return runAs(principal, async () => {
      const session = newSession(principal.id);
      await sessions.set(session.id, session);
      const ac = new AbortController();
      const turnProvider = job.provider ?? provider;
      const view = await run.open({
        sessionId: session.id, signal: ac.signal,
        content: [{ type: 'text', text: job.goal }], provider: turnProvider, principal,
      });
      let final: Session | undefined;
      const ledger = services.LlmCalls;
      const pendingUsage: Array<Omit<LlmCall, 'userId' | 'conversationId' | 'provider' | 'model'>> = [];
      const flushUsage = (): void => {
        if (!ledger) return;
        const looked = services.providers.get(turnProvider)?.model;
        let logProvider = turnProvider;
        let logModel = looked ?? job.model ?? turnProvider;
        // Handle OpenRouter providers (e.g., 'openrouter/deepseek/deepseek-chat')
        if (!looked && turnProvider.startsWith('openrouter/')) {
          logProvider = 'openrouter';
          logModel = job.model ?? turnProvider.substring('openrouter/'.length);
        }
        for (const u of pendingUsage) {
          void ledger.record({
            userId: principal.id, conversationId: session.id, provider: logProvider, model: logModel, ...u,
          });
        }
        pendingUsage.length = 0;
      };
      try {
        for await (const ev of view.events) {
          if (ev.type === 'done') { final = ev.session; break; }
          if (ev.type === 'error') throw new Error(ev.error);
          if (ev.type === 'aborted') throw new Error(`aborted: ${ev.reason}`);
          if (ev.type === 'usage') {
            pendingUsage.push({
              inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, requestId: ev.traceId,
              ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
              ...(ev.cacheCreationTokens !== undefined ? { cacheCreationTokens: ev.cacheCreationTokens } : {}),
              ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}),
            });
          }
        }
      } finally {
        flushUsage();
      }
      return { result: { sessionId: session.id, text: final ? lastAssistantText(final) : '' } };
    });
  };
}

async function claimOne(db: Db, kinds: string[], nodeId: string): Promise<Job | null> {
  return db.tx(async (q) => {
    const r = await q(
      `select id, kind, goal, payload, surface, user_id, model, provider from eidan.jobs
        where status='queued' and kind = any($1::text[])
          and (target_node is null or target_node = $2)
        order by created_at
        limit 1 for update skip locked`,
      [kinds, nodeId],
    );
    const row = r.rows[0] as Job | undefined;
    if (!row) return null;
    await q(`update eidan.jobs set status='claimed', claimed_by=$2, claimed_at=now() where id=$1`, [row.id, nodeId]);
    return row;
  });
}

async function mark(db: Db, id: string, status: string): Promise<void> {
  await db.query(`update eidan.jobs set status=$2 where id=$1`, [id, status]);
}
async function markDone(db: Db, id: string, result: unknown): Promise<void> {
  await db.query(`update eidan.jobs set status='done', result=$2::jsonb, error=null where id=$1`, [id, JSON.stringify(result)]);
}
async function markFailed(db: Db, id: string, error: string): Promise<void> {
  await db.query(`update eidan.jobs set status='failed', error=$2 where id=$1`, [id, error]);
}
// Put a claimed job back on the queue for a later tick. Used when a handler signals `requeue`
// (e.g. sage's "workspace lease busy") — the work isn't done and must not be buried as done.
async function markRequeue(db: Db, id: string): Promise<void> {
  await db.query(`update eidan.jobs set status='queued', claimed_by=null, claimed_at=null where id=$1`, [id]);
}

export interface JobWorkerOpts {
  kinds: string[];
  nodeId: string;
  provider: string;
  registry: JobHandlerRegistry;
  pollMs?: number;
  // Max jobs this node runs at once (EIDAN_JOBS_CONCURRENCY). Default 1 = the historical serial
  // loop. >1 lets independent jobs (typically different repos) proceed in parallel so one slow or
  // hung job no longer blocks the whole backlog. Same-repo `code` jobs still serialise via sage's
  // (repo,stack) lease — they `requeue` and retry rather than corrupt a shared checkout; true
  // same-repo parallelism needs per-job git worktrees (a separate change).
  concurrency?: number;
}

// Detached claim/run loop. Runs up to `concurrency` jobs at once; stop() ends the loop and waits
// for in-flight jobs to finish (so no row is left stuck in 'running').
export function startJobWorker(services: MatbotServices, db: Db, opts: JobWorkerOpts): () => Promise<void> {
  let stopped = false;
  const pollMs = opts.pollMs ?? 2000;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const inFlight = new Set<Promise<void>>();

  const runOne = async (job: Job): Promise<void> => {
    try {
      await mark(db, job.id, 'running');
      const handler = opts.registry.get(job.kind) ?? makeTurnHandler(opts.provider);
      const { result } = await handler(job, services);
      if ((result as { status?: unknown } | null | undefined)?.status === 'requeue') {
        // Don't bury it as done: put it back and hold this slot briefly so we don't hot-loop
        // re-claiming the same lease-blocked job while a peer slot still holds the lease.
        await markRequeue(db, job.id);
        console.log(`[jobs] requeue ${job.kind} ${job.id}`);
        await sleep(Math.max(pollMs, 3000));
      } else {
        await markDone(db, job.id, result ?? null);
        console.log(`[jobs] done ${job.kind} ${job.id}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await markFailed(db, job.id, msg).catch(() => undefined);
      console.warn(`[jobs] failed ${job.kind} ${job.id}: ${msg}`);
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      if (inFlight.size >= concurrency) { await Promise.race(inFlight); continue; }
      let job: Job | null = null;
      try {
        job = await claimOne(db, opts.kinds, opts.nodeId);
      } catch (e) {
        console.warn('[jobs] claim error:', e);
        await sleep(5000);
        continue;
      }
      if (!job) {
        // Nothing to claim: idle-poll, but wake early if an in-flight job frees a slot.
        await (inFlight.size === 0 ? sleep(pollMs) : Promise.race([...inFlight, sleep(pollMs)]));
        continue;
      }
      const p = runOne(job).finally(() => { inFlight.delete(p); });
      inFlight.add(p);
    }
    await Promise.allSettled(inFlight);
  };
  void loop();
  return async () => { stopped = true; await Promise.allSettled(inFlight); };
}
