// SPDX-License-Identifier: AGPL-3.0-or-later
// Topology-driven notification routing (ported from eidan notify_routes.py): a topic resolves to a
// (channel, target) via EIDAN_NOTIFY_ROUTES; senders are plain HTTP (potem's pattern, no SDK). A
// topic with no route is a no-op; a delivery failure is logged, never raised (a missing webhook
// must not crash a boot or a tick).

export interface Route { channel: string; target?: string }

export function loadRoutes(raw: string | undefined): Map<string, Route> {
  const routes = new Map<string, Route>();
  if (!raw || !raw.trim()) return routes;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { console.warn('[notify] failed to parse EIDAN_NOTIFY_ROUTES'); return routes; }
  if (typeof parsed !== 'object' || parsed === null) { console.warn('[notify] EIDAN_NOTIFY_ROUTES must be a JSON object'); return routes; }
  for (const [topic, spec] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof spec !== 'object' || spec === null) continue;
    const s = spec as Record<string, unknown>;
    const channel = typeof s['channel'] === 'string' ? s['channel'] : undefined;
    if (!channel) { console.warn(`[notify] skipping route ${topic}: needs a 'channel'`); continue; }
    const target = typeof s['target'] === 'string' ? s['target'] : undefined;
    routes.set(topic, { channel, ...(target !== undefined ? { target } : {}) });
  }
  return routes;
}

export interface Notify {
  emit(topic: string, text: string, severity?: string): Promise<void>;
}

export interface NotifyConfig {
  routes: Map<string, Route>;
  dryRun: boolean;
  telegramToken?: string;
  slackToken?: string;
}

export class NotifyImpl implements Notify {
  private readonly cfg: NotifyConfig;
  constructor(cfg: NotifyConfig) { this.cfg = cfg; }

  async emit(topic: string, text: string, severity = 'info'): Promise<void> {
    const route = this.cfg.routes.get(topic);
    if (!route) return; // no route → intentional no-op
    try {
      if (this.cfg.dryRun) {
        console.log(`[notify:dryrun] topic=${topic} channel=${route.channel} target=${route.target ?? ''} severity=${severity} text=${JSON.stringify(text)}`);
        return;
      }
      if (route.channel === 'telegram') await this.sendTelegram(route.target, text);
      else if (route.channel === 'slack') await this.sendSlack(route.target, text);
      else console.warn(`[notify] unknown channel '${route.channel}' for topic ${topic}`);
    } catch (e) {
      console.warn(`[notify] emit failed topic=${topic} channel=${route.channel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async sendTelegram(chatId: string | undefined, text: string): Promise<void> {
    if (!this.cfg.telegramToken || !chatId) { console.warn('[notify] telegram: missing bot token or chat_id'); return; }
    const res = await fetch(`https://api.telegram.org/bot${this.cfg.telegramToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) throw new Error(`telegram http ${res.status}`);
  }

  private async sendSlack(channel: string | undefined, text: string): Promise<void> {
    if (!this.cfg.slackToken) { console.warn('[notify] slack: missing bot token'); return; }
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.slackToken}` },
      body: JSON.stringify({ channel, text }),
    });
    const j = (await res.json()) as { ok?: boolean; error?: string };
    if (!j.ok) throw new Error(`slack: ${j.error ?? 'failed'}`);
  }
}
