// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { ensureSchema } from './schema.js';
import { loadConfig } from './config.js';
import { loadPats, routePat, type PatEntry } from './pats.js';
import { runInitialPipeline, parseRepo, type Notify, type PipelineResult } from './pipeline.js';
import { runTick } from './iteration.js';
import { loadSelfReviewConfig } from './selfreview.js';
import { makeEscalate } from './escalations.js';
import { startPrReconcile } from './reconcile.js';
import { startPanelServer } from './panel-server.js';

// The jobs substrate's handler registry (declared by @eidandev/jobs; re-declared here, the matbot
// pattern, so the bundle stays decoupled from core's package layout). A bundle "plugs in" by
// registering a handler for its capability kind — sage owns 'code'.
interface Job { id: string; kind: string; goal: string; payload: Record<string, unknown>; surface: string | null; user_id: string | null; model?: string | null; provider?: string | null; }
type JobHandler = (job: Job, services: MatbotServices) => Promise<{ result?: unknown }>;
interface JobHandlers { register(kind: string, handler: JobHandler): void; get(kind: string): JobHandler | undefined; }
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    JobHandlers?: JobHandlers;
    // Topic-first outbound notifications, registered by @eidandev/notify. Optional: a node with no
    // notify plugin simply has no service and milestone posts fall back to console.log.
    Notify?: { emit(topic: string, text: string, severity?: string): Promise<void> };
  }
}

function str(payload: Record<string, unknown>, key: string): string | undefined {
  return typeof payload[key] === 'string' ? (payload[key] as string) : undefined;
}

// The full Sage loop: clone payload.repo, drive `claude` to write the change, commit+push, open the
// PR, request Copilot, and seed the Copilot/CI iteration-loop cursor. The iteration loop itself
// (advancing the cursor on each settled PR) is the follow-on brick driven by a scheduled poll.
function makeCodeHandler(db: Db, pats: PatEntry[]): JobHandler {
  const cfg = loadConfig();
  const resolvePat = (opts: { host: string; ownerRepo: string; scope: 'read' | 'write' }): string | null =>
    routePat(pats, opts)?.token ?? null;

  return async (job, services) => {
    const repoSpec = str(job.payload, 'repo');
    if (!repoSpec) throw new Error('sage: code job needs payload.repo (owner/repo)');
    const { host, owner, repo } = parseRepo(repoSpec);
    const stack = str(job.payload, 'stack') ?? 'sage';
    const title = str(job.payload, 'title') ?? (job.goal.split('\n', 1)[0] || 'sage task').slice(0, 120);

    // Best-effort milestone posts to the operator's sage channel (none-safe: no Notify service → log).
    const notify: Notify = async (text, severity = 'info') => {
      try {
        await services.Notify?.emit(cfg.notifyTopic, text, severity);
      } catch (e) {
        console.warn(`[sage] notify failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!services.Notify) console.log(`[sage] ${text}`);
    };

    const result: PipelineResult = await runInitialPipeline(
      { db, cfg, resolvePat, notify },
      { jobId: job.id, host, owner, repo, stack, title, goal: job.goal, userId: job.user_id,
        model: typeof job.model === 'string' && job.model.trim() ? job.model.trim() : null },
    );
    // The worker marks the job failed iff the handler throws; a requeue/skipped/blocked result is
    // surfaced in the stored result for the operator, not raised.
    return { result: { handler: 'sage', repo: repoSpec, ...result } };
  };
}

// The PR-iteration poll. The Python plugin used the host's `schedule:` behaviour; here we self-pace
// a detached loop (same shape as @eidandev/jobs' worker), gated on claude being present.
function startIterationPoll(db: Db, pats: PatEntry[], notify: Notify): () => void {
  const cfg = loadConfig();
  const resolvePat = (opts: { host: string; ownerRepo: string; scope: 'read' | 'write' }): string | null =>
    routePat(pats, opts)?.token ?? null;
  if (cfg.claudeBinPath === null) {
    console.log('[sage] iteration poll disabled — no claude on this node (Pi-only runtime)');
    return () => undefined;
  }
  const selfreview = loadSelfReviewConfig();
  const escalate = makeEscalate(db); // mirror loop escalations to the eidan.escalations inbox
  let stopped = false;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());
  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await runTick({ db, cfg, resolvePat, notify, selfreview, escalate });
      } catch (e) {
        console.warn(`[sage] iteration tick error: ${e instanceof Error ? e.message : String(e)}`);
      }
      await sleep(cfg.pollIntervalMs);
    }
  };
  void loop();
  console.log(`[sage] iteration poll started (every ${Math.round(cfg.pollIntervalMs / 1000)}s, self-review=${selfreview ? selfreview.model : 'off'})`);
  return () => { stopped = true; };
}

let db: Db | undefined;
let stopPoll: (() => void) | undefined;
let stopReconcile: (() => void) | undefined;
let stopPanel: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: "Sage coding bundle: registers a 'code' JobHandler on the eidan jobs substrate that runs the full deterministic claim→PR pipeline (lease+clone→claude→commit/push→open PR→Copilot→seed iteration cursor).",
  },
  async setup(services: MatbotServices) {
    const handlers = services.JobHandlers;
    if (!handlers) {
      console.warn('[sage] @eidandev/jobs not loaded — no code handler registered');
      return;
    }
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/sage');

    let pats: PatEntry[] = [];
    try {
      pats = loadPats(process.env['EIDAN_GH_PATS']);
    } catch (e) {
      console.warn(`[sage] EIDAN_GH_PATS invalid — sage will fail to clone/push: ${e instanceof Error ? e.message : String(e)}`);
    }

    db = new Db(url);
    await ensureSchema(db);
    handlers.register('code', makeCodeHandler(db, pats));
    const cfg = loadConfig();
    console.log(`[sage] registered 'code' JobHandler (node=${cfg.nodeId}, claude=${cfg.claudeBinPath ?? 'MISSING'}, base=${cfg.defaultBase}, pats=${pats.length})`);

    // Start the Copilot/CI iteration poll on this node. Milestone posts go to the configured topic.
    const pollNotify: Notify = async (text, severity = 'info') => {
      try {
        await services.Notify?.emit(cfg.notifyTopic, text, severity);
      } catch (e) {
        console.warn(`[sage] notify failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!services.Notify) console.log(`[sage] ${text}`);
    };
    stopPoll = startIterationPoll(db, pats, pollNotify);
    // Passive PR-state mirror: reflect merged/closed/CI-failed back onto each job's phase.
    stopReconcile = startPrReconcile(db, pats, pollNotify);

    // Serve the operator's PR-queue board data: the plugin "cursor panel" contract core's
    // CursorsPane probes (GET <base>/cursors|summary, POST <base>/cursors/:id/:action). Behind the
    // Next front-door proxy; the panel prefix is advertised to /api/admin/panels via EIDAN_ADMIN_PANELS.
    services.registerFrontend?.({ name: 'sage-panel' });
    const panelPort = Number(process.env['EIDAN_SAGE_PANEL_PORT'] ?? 8093);
    const panelBase = process.env['EIDAN_SAGE_PANEL_BASE']?.trim() || '/api/sage';
    const webOrigin = process.env['EIDAN_DEV_WEB_ORIGIN'];
    stopPanel = startPanelServer(services, {
      db, port: panelPort, base: panelBase, nodeId: cfg.nodeId,
      ...(webOrigin !== undefined ? { webOrigin } : {}),
    });
    console.log(`[sage] panel server on :${panelPort} (${panelBase}/cursors|summary) — admin PR-queue board`);
  },
  async teardown() {
    if (stopReconcile) stopReconcile();
    if (stopPanel) stopPanel();
    if (stopPoll) stopPoll();
    if (db) await db.close();
  },
};
