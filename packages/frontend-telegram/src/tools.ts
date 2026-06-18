// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type { TelegramStore } from './store.js';
import { sendMessage } from './bot.js';

// "Message me on Telegram" for the agent. A user doesn't know their numeric chat id and shouldn't
// have to — this resolves the recipient from the account-link binding (eidan.telegram_chats), which
// owns that mapping. Defaults to the current user (the ambient principal); an explicit eidan user id
// targets another bound user. Lives here (not in @eidandev/notify) because the binding + principal
// are this plugin's concern — notify's free-form send_message stays for raw chat ids / Slack.
export function telegramSendTool(token: string, store: TelegramStore): Tool {
  return {
    name: 'telegram_send',
    description: 'Send a Telegram message to a bound eidan user. Defaults to the current user (you) — no chat id needed; it resolves your linked chat from the account binding. The recipient must have linked Telegram via the bot\'s /start flow (otherwise this returns an error explaining that). Use this for "message me / a user on Telegram"; the generic send_message tool is only for when you already hold a raw chat id.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The message body (plain text).' },
        to: { type: 'string', description: 'Optional eidan user id to send to. Omit to message the current user (you).' },
      },
    },
    executor: {
      async *execute(input, ctx) {
        const { text, to } = input as { text: string; to?: string };
        const userId = to ?? tryCurrentPrincipal()?.id ?? ctx.session.ownerPrincipalId;
        if (!userId) { yield { type: 'result', value: { sent: false, error: 'could not resolve the recipient user' } }; return; }
        const chatId = await store.chatForUser(userId);
        if (chatId === null) { yield { type: 'result', value: { sent: false, error: 'no Telegram chat is linked for this user — they need to open the bot and run /start to link their account' } }; return; }
        try { await sendMessage(token, chatId, text); yield { type: 'result', value: { sent: true, to: userId } }; }
        catch (e) { yield { type: 'result', value: { sent: false, to: userId, error: e instanceof Error ? e.message : String(e) } }; }
      },
    },
  };
}
