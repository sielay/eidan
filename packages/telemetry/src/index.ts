// SPDX-License-Identifier: AGPL-3.0-or-later
import os from 'node:os';
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { calculateStaleThreshold } from './stale.js';

const HEARTBEAT_MS = 30_000;
const DEFAULT_REAPER_INTERVAL_MS = 300_000; // 5 minutes

function parsePositiveInt(envVar: string | undefined, defaultValue: number, envVarName?: string): number;
function parsePositiveInt(envVar: string | undefined, defaultValue: undefined, envVarName?: string): number | undefined;
function parsePositiveInt(envVar: string | undefined, defaultValue: number | undefined = undefined, envVarName?: string): number | undefined {
  if (!envVar) return defaultValue;
  const parsed = Number(envVar);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    if (envVarName) {
      console.warn(`[telemetry] ${envVarName}="${envVar}" is invalid; using default`);
    }
    return defaultValue;
  }
  return parsed;
}

const REAPER_INTERVAL_MS = parsePositiveInt(process.env['EIDAN_REAPER_INTERVAL_MS'], DEFAULT_REAPER_INTERVAL_MS, 'EIDAN_REAPER_INTERVAL_MS');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// session.id is sometimes the conversation uuid and sometimes an opaque runner id; node_events
// .conversation_id is a uuid column, so only attach it when it actually is one.
function conversationIdOf(sessionId: string | undefined): string | null {
  return sessionId && UUID_RE.test(sessionId) ? sessionId : null;
}

// eidan.node_heartbeats.node_type is CHECK-constrained to this set; an out-of-set value would make
// every heartbeat upsert fail, so clamp misconfiguration to 'local' rather than degrade telemetry.
const NODE_TYPES = new Set(['pi', 'fly', 'heroku', 'k8s', 'local']);

function nodeIdentity(): { nodeId: string; nodeType: string } {
  const nodeId = process.env['EIDAN_NODE_ID'] ?? `mb-${os.hostname()}`;
  const declared = process.env['EIDAN_NODE_TYPE'] ?? (process.env['FLY_APP_NAME'] ? 'fly' : 'local');
  const nodeType = NODE_TYPES.has(declared) ? declared : 'local';
  return { nodeId, nodeType };
}

let db: Db | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let reaperTimer: ReturnType<typeof setInterval> | undefined;
let lastReapPromise: Promise<void> = Promise.resolve();
let nodeId: string | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Node telemetry: keeps eidan.node_heartbeats fresh (liveness for the admin dashboard + nodes view) and appends eidan.node_events for every turn and tool call (the log/live activity stream).',
  },

  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) { console.warn('[telemetry] no EIDAN_DATABASE_URL — telemetry disabled'); return; }

    const id = nodeIdentity();
    nodeId = id.nodeId;
    db = new Db(url);

    const servedKinds = (process.env['EIDAN_JOB_KINDS'] ?? 'chat').split(',').map((s) => s.trim()).filter(Boolean);
    const metadata = { host: os.hostname(), pid: process.pid, startedAt: new Date().toISOString() };

    const beat = async (): Promise<void> => {
      // Read the tool list per-beat, not once at setup: telemetry loads early in the plugin order, so
      // at setup only a handful of tools exist yet — by the first interval the full set is registered.
      let plugins: string[] = [];
      try { plugins = services.tools.list().map((t) => t.name); } catch { /* tools not ready */ }
      try {
        await db!.upsertHeartbeat({ nodeId: id.nodeId, nodeType: id.nodeType, status: 'online', plugins, servedKinds, metadata });
      } catch (err) {
        console.warn('[telemetry] heartbeat failed:', (err as Error).message);
      }
    };

    // First beat creates the node_heartbeats row before any node_events reference it (FK), so do it
    // up front, then announce the node and start the periodic refresh.
    await beat();
    void db.emitEvent({ nodeId: id.nodeId, type: 'node.online', payload: { servedKinds }, conversationId: null });
    timer = setInterval(() => { void beat(); }, HEARTBEAT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    // Stale-marking reaper: mark nodes offline if they haven't been seen in STALE_THRESHOLD_MS.
    const reap = async (): Promise<void> => {
      try {
        const staleMs = parsePositiveInt(process.env['EIDAN_NODE_STALE_MS'], undefined, 'EIDAN_NODE_STALE_MS');
        const staleThreshold = calculateStaleThreshold(HEARTBEAT_MS, staleMs);
        await db!.markStaleOffline(staleThreshold);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[telemetry] reaper failed:', msg);
      }
    };
    // Chain all reaps so teardown can await the final promise and know all pending reaps have completed.
    // Don't block setup if the initial reap fails (telemetry is non-critical).
    lastReapPromise = reap();
    reaperTimer = setInterval(() => { lastReapPromise = lastReapPromise.then(() => reap()); }, REAPER_INTERVAL_MS);
    if (typeof reaperTimer.unref === 'function') reaperTimer.unref();

    // Activity stream. Both handlers are fire-and-forget observers — telemetry must never add latency
    // to or throw into a turn, so they never await and emitEvent swallows its own errors.
    services.hooks.register({
      on: 'screen',
      handler(ctx) {
        void db?.emitEvent({
          nodeId: id.nodeId,
          type: 'turn',
          payload: { messages: ctx.session.messages.length, provider: ctx.config.provider },
          conversationId: conversationIdOf(ctx.session.id),
        });
      },
    });
    services.hooks.register({
      on: 'toolresult',
      handler(ctx) {
        void db?.emitEvent({
          nodeId: id.nodeId,
          type: 'tool',
          payload: { tool: ctx.tool.name, durationMs: ctx.durationMs, isError: ctx.isError },
          conversationId: conversationIdOf(ctx.session.id),
        });
      },
    });

    console.log(`[telemetry] node ${id.nodeId} (${id.nodeType}) online — heartbeat every ${HEARTBEAT_MS / 1000}s`);
  },

  async teardown() {
    if (timer) clearInterval(timer);
    if (reaperTimer) clearInterval(reaperTimer);
    // Wait for any pending reaps to complete. reap() catches all errors and returns successfully,
    // so this promise will never reject (errors are logged by reap, not here).
    await lastReapPromise;
    if (db && nodeId) {
      try {
        await db.emitEvent({ nodeId, type: 'node.offline', payload: {}, conversationId: null });
        await db.markOffline(nodeId);
      } catch { /* shutting down — best effort */ }
      await db.close();
    }
  },
};
