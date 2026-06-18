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

// What a single delivery attempt resolved to — so the agent-facing tool can report back honestly
// (sent / dry-run / no such route / channel error) instead of the fire-and-forget emit() that swallows.
export interface DeliverResult {
  ok: boolean;
  noRoute?: boolean;
  dryRun?: boolean;
  channel?: string;
  target?: string;
  error?: string;
}

export interface Notify {
  // Fire-and-forget, for system events: a missing route/webhook is a silent no-op (never throws).
  emit(topic: string, text: string, severity?: string): Promise<void>;
  // Topic→route delivery with a status (does NOT swallow). Used by emit(); kept for system topics.
  deliver(topic: string, text: string): Promise<DeliverResult>;
  // Free-form on-demand send: the caller picks the channel + destination directly (no route needed).
  // This is what the agent send tool uses — the operator only has to supply the channel's bot token.
  sendTo(channel: string, target: string, text: string): Promise<DeliverResult>;
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
    if (this.cfg.dryRun) {
      console.log(`[notify:dryrun] topic=${topic} channel=${route.channel} target=${route.target ?? ''} severity=${severity} text=${JSON.stringify(text)}`);
      return;
    }
    const res = await this.deliver(topic, text);
    if (!res.ok && !res.noRoute) console.warn(`[notify] emit failed topic=${topic} channel=${route.channel}: ${res.error ?? 'failed'}`);
  }

  async deliver(topic: string, text: string): Promise<DeliverResult> {
    const route = this.cfg.routes.get(topic);
    if (!route) return { ok: false, noRoute: true };
    const where = { channel: route.channel, ...(route.target !== undefined ? { target: route.target } : {}) };
    if (this.cfg.dryRun) return { ok: true, dryRun: true, ...where };
    try {
      if (route.channel === 'telegram') await this.sendTelegram(route.target, text);
      else if (route.channel === 'slack') await this.sendSlack(route.target, text);
      else return { ok: false, ...where, error: `unknown channel '${route.channel}'` };
      return { ok: true, ...where };
    } catch (e) {
      return { ok: false, ...where, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async sendTo(channel: string, target: string, text: string): Promise<DeliverResult> {
    const where = { channel, target };
    if (this.cfg.dryRun) return { ok: true, dryRun: true, ...where };
    try {
      if (channel === 'telegram') await this.sendTelegram(target, text);
      else if (channel === 'slack') await this.sendSlack(target, text);
      else return { ok: false, ...where, error: `unknown channel '${channel}' (use 'slack' or 'telegram')` };
      return { ok: true, ...where };
    } catch (e) {
      return { ok: false, ...where, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async sendTelegram(chatId: string | undefined, text: string): Promise<void> {
    if (!this.cfg.telegramToken) throw new Error('missing telegram bot token (set EIDAN_TELEGRAM_BOT_TOKEN)');
    if (!chatId) throw new Error('route has no target (telegram chat id)');
    const res = await fetch(`https://api.telegram.org/bot${this.cfg.telegramToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) throw new Error(`telegram http ${res.status}`);
  }

  private async sendSlack(channel: string | undefined, text: string): Promise<void> {
    if (!this.cfg.slackToken) throw new Error('missing slack bot token (set EIDAN_SLACK_BOT_TOKEN)');
    if (!channel) throw new Error('route has no target (slack channel, e.g. #eidan)');
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.slackToken}` },
      body: JSON.stringify({ channel, text }),
    });
    const j = (await res.json()) as { ok?: boolean; error?: string };
    if (!j.ok) throw new Error(`slack: ${j.error ?? 'failed'}`);
  }
}
