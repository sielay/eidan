// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotServices } from '@matatbread/matbot-plugin-api';
import { RoutinesStore } from './store.js';
import { dueWindow } from './schedule.js';
import { runRoutineTurn } from './runner.js';

export interface RoutinesLoopOpts {
  provider: string;
  pollMs?: number;
  graceMinutes?: number;
}

// @eidandev/notify augments MatbotServices with `Notify`, but routines deliberately does not depend
// on that package — we narrow to just the method we call. If notify isn't loaded (or has no route for
// the topic) the optional-chained call is simply a no-op.
interface NotifyLike {
  emit(topic: string, text: string, severity?: string): Promise<void>;
}

// Detached poll loop. Every pollMs it scans all enabled routines, and for each one due in the current
// window (owner timezone) it claims the fire (cross-node unique guard), runs the prompt as a turn, and
// delivers the result on the `routine` notify topic. Returns stop() that ends the loop after the
// in-flight scan. A scan failure is logged and retried next tick — the loop never dies.
export function startRoutinesLoop(services: MatbotServices, store: RoutinesStore, opts: RoutinesLoopOpts): () => Promise<void> {
  let stopped = false;
  const pollMs = opts.pollMs ?? 60_000;
  const grace = opts.graceMinutes ?? 30;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const fire = async (routineId: string, userId: string, name: string, prompt: string, firedFor: string): Promise<void> => {
    try {
      const text = await runRoutineTurn(services, userId, prompt, opts.provider);
      const body = text.trim() ? text.trim() : '(routine produced no text)';
      const notify = (services as { Notify?: NotifyLike }).Notify;
      await notify?.emit('routine', `🔔 ${name}\n\n${body}`, 'info');
      await store.finishRun(routineId, firedFor, 'delivered', body);
      console.log(`[routines] fired "${name}" (${routineId}) for ${firedFor}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await store.finishRun(routineId, firedFor, 'failed', msg).catch(() => undefined);
      console.warn(`[routines] "${name}" (${routineId}) failed for ${firedFor}: ${msg}`);
    }
  };

  const tick = async (): Promise<void> => {
    const routines = await store.dueScan();
    for (const r of routines) {
      const tz = await store.userTimeZone(r.user_id);
      const firedFor = dueWindow(r.schedule, new Date(), tz, grace);
      if (!firedFor) continue;
      const won = await store.claimRun(r.id, r.user_id, firedFor);
      if (!won) continue; // another node is handling this window
      await fire(r.id, r.user_id, r.name, r.prompt, firedFor);
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await tick();
      } catch (e) {
        console.warn('[routines] scan error:', e instanceof Error ? e.message : e);
      }
      await sleep(pollMs);
    }
  };
  void loop();
  return async () => { stopped = true; };
}
