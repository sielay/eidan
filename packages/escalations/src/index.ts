// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { EscalationsStore, type EscalationsService, type RelationshipType } from './store.js';
import { buildEscalateTools } from './tools.js';

// @eidandev/notify augments MatbotServices with `Notify`; escalations narrows to the one method it
// calls so it has no hard dependency. Missing service / unrouted topic ⇒ the emit is a no-op.
interface NotifyLike {
  emit(topic: string, text: string, severity?: string): Promise<void>;
}

// Advertise the human-in-the-loop inbox writer so any plugin can flag the operator with type safety:
// services.Escalations?.raise({ severity, reasonClass, suggestedAction, … }).
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    Escalations?: EscalationsService;
    Notify?: NotifyLike;
  }
}

// @eidandev/frontend-telegram registers `TelegramChats` (the same path routines deliver on: vault bot
// token + the owner's linked chat). Narrowed here; absent ⇒ no Telegram ping.
interface TelegramChatsLike {
  sendToUser(userId: string, text: string): Promise<boolean>;
}

let db: Db | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'eidan escalations: the human-in-the-loop inbox (eidan.escalations). Registers an Escalations ' +
      'service (raise) + an `escalate` tool so any agent/turn can flag something needing the operator ' +
      '(severity + reason_class + suggested_action + evidence), deduped per agent, and emits the ' +
      '`escalation` notify topic so they are pinged (route it in EIDAN_NOTIFY_ROUTES). The Inbox UI ' +
      'lists/acknowledges/resolves these.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/escalations');
    db = new Db(url);
    const store = new EscalationsStore(db);

    // The service wraps the store insert with notify delivery, so the tool AND auto-escalation share
    // one path: raise → (deduped) insert → ping on the `escalation` topic.
    const svc: EscalationsService = {
      async raise(args) {
        const res = await store.insert(args);
        if (res) {
          const head = args.severity === 'high' ? '🚨' : '⚠️';
          const text = `${head} Escalation (${args.severity} · ${args.reasonClass})\n\n${args.suggestedAction ?? 'needs your attention'}`;
          // Telegram — the proven path (vault token + the owner's linked chat); the operator's primary.
          const userId = args.userId ?? tryCurrentPrincipal()?.id;
          const tg = (services as { TelegramChats?: TelegramChatsLike }).TelegramChats;
          if (userId && tg) await tg.sendToUser(userId, text).catch(() => undefined);
          // notify topic too (Slack/other), if a route + token are configured.
          await services.Notify?.emit('escalation', text, args.severity === 'high' ? 'error' : 'warn').catch(() => undefined);
        }
        return res;
      },
      async respond(args) {
        const res = await store.respond(args);
        if (res) {
          const escalation = await store.getEscalation(args.id);
          if (escalation && escalation.to_agent) {
            const responseText = args.feedback;
            const triggerPrompt = escalation.trigger_prompt;
            const payload = JSON.stringify({
              escalation_id: escalation.id,
              agent_id: escalation.to_agent,
              user_id: escalation.user_id,
              response_text: responseText,
              trigger_prompt: triggerPrompt,
            });
            await services.Notify?.emit('escalations:response', payload, 'info').catch(() => undefined);
          }
        }
        return res;
      },
      async list(args) {
        return await store.list(args);
      },
      async listUnprocessedResponsesForAgents(toAgentIds, limit) {
        return await store.listUnprocessedResponsesForAgents(toAgentIds, limit);
      },
      async markResponseProcessed(id: string) {
        return await store.markResponseProcessed(id);
      },
      async listAgentRelationships(userId: string, options?: { fromAgent?: string; toAgent?: string }) {
        return await store.listAgentRelationships(userId, options);
      },
      async setAgentRelationship(userId: string, rel: { fromAgent: string; toAgent: string; type: RelationshipType; strength?: number; description?: string }) {
        return await store.setAgentRelationship(userId, rel);
      },
      async deleteAgentRelationship(userId: string, fromAgent: string, toAgent: string) {
        return await store.deleteAgentRelationship(userId, fromAgent, toAgent);
      },
    };

    await services.register('Escalations', svc);
    for (const tool of buildEscalateTools(svc)) services.tools.register(tool);
    console.log('[escalations] service + escalate tool registered (notify topic: escalation)');
  },
  async teardown() {
    if (db) await db.close();
  },
};
