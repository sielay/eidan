// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices, Principal, Session, MessageContent } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, runAs } from '@matatbread/matbot-plugin-api';
import { loadAllowlist, resolvePrincipal, type Allowlist } from './allowlist.js';
import { getUpdates, sendChatAction, sendMessage } from './bot.js';
import type { PoolClient } from 'pg';
import { Db } from './db.js';
import { TelegramStore } from './store.js';
import { startLinkServer } from './link-server.js';

// The inbound Telegram chat surface. An admitted sender's message becomes an eidan principal, a
// per-chat session is opened, and the turn runs through the SAME matbot run path (`run.open`) the
// AG-UI HTTP surface uses — the reply is sent back to the chat.
//
// Admission is potem-style account linking: a chat binds to an eidan user via `/start` → one-time
// web link → sign-in. Bound chats (eidan.telegram_chats) are admitted as their user; an optional
// static ${EIDAN_TELEGRAM_ALLOWLIST} still works as a fallback for pre-provisioned mappings.
//
// Config (operator-private, via vault/env — never tracked):
//   ${EIDAN_TELEGRAM_BOT_TOKEN} | EIDAN_TELEGRAM_BOT_TOKEN | TELEGRAM_BOT_TOKEN  BotFather token.
//   EIDAN_WEB_URL               base URL of the web app, for the /start link (e.g. https://e.sielay.com).
//   ${EIDAN_TELEGRAM_ALLOWLIST} optional JSON { "<telegram_id>": "<eidan_principal_id>" } fallback.
//   EIDAN_TELEGRAM_PROVIDER     provider name (falls back to the first registered provider).

// The TelegramChats service lets other plugins (e.g. @eidandev/routines) deliver to a user's bound
// chat without depending on this package's internals or holding the bot token.
export interface TelegramChats {
  getChatId(userId: string): Promise<number | null>;
  sendToUser(userId: string, text: string): Promise<boolean>;
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    TelegramChats?: TelegramChats;
  }
}

const SESSION_KEY_PREFIX = 'chat_session:';
// Telegram permits exactly one getUpdates long-poller per bot (a second one gets HTTP 409). This
// app-specific session advisory lock elects a single poller across all nodes sharing the database.
const POLL_LOCK_KEY = 0x7e1e6701;

let teardownAc: AbortController | undefined;
let stopLink: (() => void) | undefined;
let db: Db | undefined;
let lockClient: PoolClient | undefined;

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
    description: 'Inbound Telegram chat surface with potem-style account linking: /start → one-time web link → sign-in binds the chat to an eidan user (eidan.telegram_chats). Bound senders run each message as a matbot turn (same path as frontend-agui). Registers the TelegramChats service for outbound delivery (routines/replies). Bot token from vault or env; EIDAN_WEB_URL for the link.',
  },

  async setup(services: MatbotServices) {
    // Token: prefer the vault placeholder, fall back to plain env (mirrors @eidandev/notify) so a
    // deploy that only sets TELEGRAM_BOT_TOKEN still works.
    let botToken: string | undefined;
    try { botToken = await services.vault.resolve('${EIDAN_TELEGRAM_BOT_TOKEN}'); } catch { botToken = undefined; }
    botToken = botToken ?? process.env['EIDAN_TELEGRAM_BOT_TOKEN'] ?? process.env['TELEGRAM_BOT_TOKEN'];
    if (!botToken) {
      console.warn('[frontend-telegram] no bot token (vault ${EIDAN_TELEGRAM_BOT_TOKEN} / EIDAN_TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_TOKEN) — inbound Telegram disabled');
      return;
    }
    const token: string = botToken;

    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) {
      console.warn('[frontend-telegram] EIDAN_DATABASE_URL not set — inbound Telegram disabled');
      return;
    }
    db = new Db(url);
    const store = new TelegramStore(db);

    const allow: Allowlist = loadAllowlist(await resolveOptional(services, '${EIDAN_TELEGRAM_ALLOWLIST}'));

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
    const webUrl = process.env['EIDAN_WEB_URL']?.replace(/\/$/, '');

    // Outbound delivery service for other plugins (routines, etc.).
    const telegramChats: TelegramChats = {
      getChatId: (userId) => store.chatForUser(userId),
      async sendToUser(userId, text) {
        const chatId = await store.chatForUser(userId);
        if (chatId === null) return false;
        try { await sendMessage(token, chatId, text); return true; } catch { return false; }
      },
    };
    await services.register('TelegramChats', telegramChats);

    // Account-link redemption endpoint, exposed through the AG-UI front door.
    const linkPort = Number(process.env['MATBOT_TELEGRAM_LINK_PORT'] ?? 8096);
    const webOrigin = process.env['EIDAN_DEV_WEB_ORIGIN'];
    stopLink = startLinkServer(services, { port: linkPort, botToken: token, store, ...(webOrigin !== undefined ? { webOrigin } : {}) });
    services.PanelProxy?.register({ prefix: '/api/me/telegram/link', port: linkPort });

    const ac = new AbortController();
    teardownAc = ac;

    async function handleMessage(principal: Principal, chatId: number, text: string, senderName: string): Promise<void> {
      void sendChatAction(token, chatId, 'typing').catch(() => {});
      const sessionKey = `${SESSION_KEY_PREFIX}${chatId}`;
      const storedId = await settings.get<string>(sessionKey);
      let session: Session | null = storedId !== undefined ? await sessions!.get(storedId) : null;
      if (session?.status !== 'active') session = null;
      if (!session) {
        session = newSession(principal.id, `${senderName} on Telegram`);
        await sessions!.set(session.id, session);
        await settings.set(sessionKey, session.id);
      }

      const keepTyping = setInterval(() => { void sendChatAction(token, chatId, 'typing'); }, 4000);
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
        if (reply) await sendMessage(token, chatId, reply);
      } finally {
        clearInterval(keepTyping);
      }
    }

    // /start: mint a one-time link token and reply with the web sign-in link that binds this chat.
    async function handleStart(chatId: number, firstName: string | null, username: string | null): Promise<void> {
      const linkToken = await store.createLinkToken(chatId, firstName, username);
      if (!webUrl) {
        await sendMessage(token, chatId, "Linking isn't configured yet (the operator needs to set EIDAN_WEB_URL).");
        return;
      }
      const link = `${webUrl}/telegram/link?token=${linkToken}`;
      await sendMessage(token, chatId,
        `👋 To link this chat to your eidan account, open:\n${link}\n\nSign in if prompted. The link expires in 30 minutes.`);
    }

    const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      ac.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    let havePollLock = false;
    // Acquire (once) the single-poller advisory lock on a held connection. Returns whether we may poll.
    async function ensurePollLock(): Promise<boolean> {
      if (havePollLock) return true;
      try {
        if (!lockClient) lockClient = await db!.pool.connect();
        const r = await lockClient.query('select pg_try_advisory_lock($1) as ok', [POLL_LOCK_KEY]);
        havePollLock = Boolean((r.rows[0] as { ok: boolean }).ok);
      } catch { havePollLock = false; }
      return havePollLock;
    }

    // Long-poll dispatch loop — runs until teardown; only the lock holder actually polls.
    void (async () => {
      let offset = 0;
      while (!ac.signal.aborted) {
        if (!(await ensurePollLock())) { await sleep(30_000); continue; } // another node is the poller
        try {
          const updates = await getUpdates(token, offset, 30, ac.signal);
          for (const update of updates) {
            offset = update.update_id + 1;
            const msg = update.message;
            if (!msg?.text) continue;
            const chatId = msg.chat.id;
            const text = msg.text;

            if (text === '/start' || text.startsWith('/start ')) {
              void handleStart(chatId, msg.from?.first_name ?? null, msg.from?.username ?? null)
                .catch((e: unknown) => console.warn(`[frontend-telegram] /start failed for ${chatId}: ${e instanceof Error ? e.message : String(e)}`));
              continue;
            }

            // Admission: a bound chat is its user; else fall back to the static allowlist.
            const boundUser = await store.userForChat(chatId);
            const principal: Principal | undefined = boundUser
              ? { id: boundUser, type: 'user' }
              : resolvePrincipal(allow, { chatId, ...(msg.from ? { fromId: msg.from.id } : {}) });
            if (!principal) {
              await sendMessage(token, chatId, 'Send /start to link your eidan account, then message me.').catch(() => {});
              continue;
            }
            const senderName = msg.from?.first_name || msg.from?.username || 'Telegram';
            void runAs(principal, () => handleMessage(principal, chatId, text, senderName)).catch((e: unknown) => {
              if (ac.signal.aborted) return;
              console.warn(`[frontend-telegram] error handling chat ${chatId}: ${e instanceof Error ? e.message : String(e)}`);
              void sendMessage(token, chatId, 'An error occurred handling your message.').catch(() => {});
            });
          }
        } catch (e) {
          if (ac.signal.aborted) break;
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[frontend-telegram] poll error: ${msg}`);
          // 409 means another poller exists despite our lock (e.g. a node still on pre-lock code) —
          // drop our claim and re-contend rather than hammer Telegram.
          if (msg.includes('409')) { havePollLock = false; }
          await sleep(2000);
        }
      }
    })();

    console.log(`[frontend-telegram] inbound surface started (provider=${provider}, linking=${webUrl ? 'on' : 'no EIDAN_WEB_URL'}, allowlist=${allow.size})`);
  },

  async teardown() {
    teardownAc?.abort();
    teardownAc = undefined;
    if (stopLink) { stopLink(); stopLink = undefined; }
    if (lockClient) {
      try { await lockClient.query('select pg_advisory_unlock($1)', [POLL_LOCK_KEY]); } catch { /* ignore */ }
      lockClient.release();
      lockClient = undefined;
    }
    if (db) { await db.close(); db = undefined; }
  },
};

async function resolveOptional(services: MatbotServices, ref: string): Promise<string | undefined> {
  try {
    return await services.vault.resolve(ref);
  } catch {
    return undefined;
  }
}
