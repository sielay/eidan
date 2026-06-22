// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotServices, Session, Principal } from '@matatbread/matbot-plugin-api';
import { runAs } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { lastAssistantText } from './session-text.js';

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
      const view = await run.open({
        sessionId: session.id, signal: ac.signal,
        content: [{ type: 'text', text: job.goal }], provider, principal,
      });
      let final: Session | undefined;
      for await (const ev of view.events) {
        if (ev.type === 'done') { final = ev.session; break; }
        if (ev.type === 'error') throw new Error(ev.error);
        if (ev.type === 'aborted') throw new Error(`aborted: ${ev.reason}`);
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

export interface JobWorkerOpts {
  kinds: string[];
  nodeId: string;
  provider: string;
  registry: JobHandlerRegistry;
  pollMs?: number;
}

// Detached claim/run loop. Returns a stop() that ends the loop after the in-flight job.
export function startJobWorker(services: MatbotServices, db: Db, opts: JobWorkerOpts): () => Promise<void> {
  let stopped = false;
  const pollMs = opts.pollMs ?? 2000;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const loop = async (): Promise<void> => {
    while (!stopped) {
      let job: Job | null = null;
      try {
        job = await claimOne(db, opts.kinds, opts.nodeId);
      } catch (e) {
        console.warn('[jobs] claim error:', e);
        await sleep(5000);
        continue;
      }
      if (!job) { await sleep(pollMs); continue; }
      try {
        await mark(db, job.id, 'running');
        const handler = opts.registry.get(job.kind) ?? makeTurnHandler(opts.provider);
        const { result } = await handler(job, services);
        await markDone(db, job.id, result ?? null);
        console.log(`[jobs] done ${job.kind} ${job.id}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await markFailed(db, job.id, msg).catch(() => undefined);
        console.warn(`[jobs] failed ${job.kind} ${job.id}: ${msg}`);
      }
    }
  };
  void loop();
  return async () => { stopped = true; };
}
