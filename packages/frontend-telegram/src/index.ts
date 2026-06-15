// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices, Principal, Session, MessageContent } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, runAs } from '@matatbread/matbot-plugin-api';
import { loadAllowlist, resolvePrincipal, type Allowlist } from './allowlist.js';
import { getUpdates, sendChatAction, sendMessage } from './bot.js';

// The inbound Telegram chat surface. It is the frontend-agui idea over a Telegram transport: an
// allowlisted sender's message becomes an eidan principal, a per-chat session is opened, and the
// turn runs through the SAME matbot run path (`run.open`) that the AG-UI HTTP surface uses — the
// agent's reply is sent back to the chat on completion.
//
// Transport: long-poll `getUpdates` (no public ingress / webhook needed — works behind NAT on a
// self-hosted box). A webhook mode can be added later behind the same allowlist + run path; the
// admission and run logic live in pure/shared modules precisely so a second transport can reuse them.
//
// Config (all operator-private, supplied via the vault / gitignored env — never tracked):
//   ${EIDAN_TELEGRAM_BOT_TOKEN}  BotFather token. Absent -> plugin is inert (logs and returns).
//   ${EIDAN_TELEGRAM_ALLOWLIST}  JSON object: { "<telegram_id>": "<eidan_principal_id>", ... }.
//                                Empty/absent -> nobody is admitted (fail-closed).
//   EIDAN_TELEGRAM_PROVIDER      provider name from matbot.yaml (falls back to the agui/job provider).

const SESSION_KEY_PREFIX = 'chat_session:'; // plugin-settings key per chat id

let teardownAc: AbortController | undefined;

function newSession(ownerId: string, title: string): Session {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), version: '0', ownerPrincipalId: ownerId, status: 'active',
    title, contexts: [], messages: [], createdAt: now, updatedAt: now,
  };
}

function assistantText(s: Session): string {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m && m.role === 'assistant') {
      return m.content
        .filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
        .map((c) => c.text).join('\n').trim();
    }
  }
  return '';
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Inbound Telegram chat surface: long-polls getUpdates, maps an allowlisted Telegram sender to an eidan principal, and runs each message as a matbot turn (same run path as frontend-agui), replying to the chat. Bot token + allowlist resolved from the vault; unknown senders are rejected.',
  },

  async setup(services: MatbotServices) {
    let botToken: string;
    try {
      botToken = await services.vault.resolve('${EIDAN_TELEGRAM_BOT_TOKEN}');
    } catch {
      console.warn('[frontend-telegram] EIDAN_TELEGRAM_BOT_TOKEN not set — inbound Telegram surface disabled');
      return;
    }

    const allow: Allowlist = loadAllowlist(await resolveOptional(services, '${EIDAN_TELEGRAM_ALLOWLIST}'));
    if (allow.size === 0) {
      console.warn('[frontend-telegram] EIDAN_TELEGRAM_ALLOWLIST empty — no senders admitted (set it to enable)');
    }

    const sessions = services.sessions;
    const run = services.run;
    if (!sessions || !run) {
      console.warn('[frontend-telegram] sessions/runner unavailable — not starting');
      return;
    }

    const provider = (await resolveOptional(services, '${EIDAN_TELEGRAM_PROVIDER}'))
      ?? [...services.providers.keys()][0];
    if (!provider || !services.providers.has(provider)) {
      console.warn('[frontend-telegram] no usable provider configured — not starting');
      return;
    }

    services.registerFrontend({ name: 'frontend-telegram' });
    const settings = services.settings();

    const ac = new AbortController();
    teardownAc = ac;

    async function handleMessage(principal: Principal, chatId: number, text: string, senderName: string): Promise<void> {
      void sendChatAction(botToken, chatId, 'typing').catch(() => {});
      // One persistent session per chat, restored from plugin settings (re-created if archived/hidden
      // in the web UI). The runner appends + persists the user message when the turn starts.
      const sessionKey = `${SESSION_KEY_PREFIX}${chatId}`;
      const storedId = await settings.get<string>(sessionKey);
      let session: Session | null = storedId !== undefined ? await sessions!.get(storedId) : null;
      if (session?.status !== 'active') session = null;
      if (!session) {
        session = newSession(principal.id, `${senderName} on Telegram`);
        await sessions!.set(session.id, session);
        await settings.set(sessionKey, session.id);
      }

      const keepTyping = setInterval(() => { void sendChatAction(botToken, chatId, 'typing'); }, 4000);
      try {
        const view = await run!.open({
          sessionId: session.id, signal: ac.signal,
          content: [{ type: 'text', text }], provider: provider!, principal,
        });
        let final: Session | undefined;
        for await (const ev of view.events) {
          if (ev.type === 'done') { final = ev.session; break; }
          if (ev.type === 'error') throw new Error(ev.error);
          if (ev.type === 'aborted') throw new Error(`aborted: ${ev.reason}`);
          if (ev.type === 'cancelled') return;
        }
        const reply = final ? assistantText(final) : '';
        if (reply) await sendMessage(botToken, chatId, reply);
      } finally {
        clearInterval(keepTyping);
      }
    }

    // Long-poll dispatch loop — runs until teardown.
    void (async () => {
      let offset = 0;
      while (!ac.signal.aborted) {
        try {
          const updates = await getUpdates(botToken, offset, 30, ac.signal);
          for (const update of updates) {
            offset = update.update_id + 1;
            const msg = update.message;
            if (!msg?.text) continue;
            const principal = resolvePrincipal(allow, {
              chatId: msg.chat.id,
              ...(msg.from ? { fromId: msg.from.id } : {}),
            });
            if (!principal) {
              console.warn(`[frontend-telegram] rejected message from chat=${msg.chat.id} from=${msg.from?.id ?? '?'} (not allowlisted)`);
              continue;
            }
            const senderName = msg.from?.first_name || msg.from?.username || 'Telegram';
            // Establish the principal at the dispatch entry so session/settings store access runs
            // under it (the turn itself is independently re-scoped by the runner's pump).
            const chatId = msg.chat.id;
            const text = msg.text;
            void runAs(principal, () => handleMessage(principal, chatId, text, senderName)).catch((e: unknown) => {
              if (ac.signal.aborted) return;
              console.warn(`[frontend-telegram] error handling chat ${chatId}: ${e instanceof Error ? e.message : String(e)}`);
              void sendMessage(botToken, chatId, 'An error occurred handling your message.').catch(() => {});
            });
          }
        } catch (e) {
          if (ac.signal.aborted) break;
          console.warn(`[frontend-telegram] poll error: ${e instanceof Error ? e.message : String(e)}`);
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 2000);
            ac.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
          });
        }
      }
    })();

    console.log(`[frontend-telegram] inbound surface started (provider=${provider}, allowlisted=${allow.size})`);
  },

  async teardown() {
    teardownAc?.abort();
    teardownAc = undefined;
  },
};

// Resolve an optional ${NAME} vault placeholder, returning undefined when it isn't set rather than
// throwing — used for config that legitimately may be absent.
async function resolveOptional(services: MatbotServices, ref: string): Promise<string | undefined> {
  try {
    return await services.vault.resolve(ref);
  } catch {
    return undefined;
  }
}
