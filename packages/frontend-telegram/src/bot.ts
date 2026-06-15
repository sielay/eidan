// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal Telegram Bot API client: long-poll getUpdates + sendMessage + a typing indicator. Plain
// `fetch`, no SDK (matbot doctrine). The bot token is passed in by the caller, already resolved from
// the vault — it is never read from env or hardcoded here. The wire is Telegram's own snake_case.

const API = 'https://api.telegram.org';

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string; username?: string };
  text?: string;
}

// Long-poll for the next batch of message updates. `offset` is the highest update_id+1 seen, so
// Telegram only returns unacknowledged updates. `timeout` (seconds) is the server-side hold; the
// signal aborts the wait on teardown. Restricted to message updates — this surface ignores the rest.
export async function getUpdates(botToken: string, offset: number, timeout: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
  const url = `${API}/bot${botToken}/getUpdates?offset=${offset}&timeout=${timeout}&allowed_updates=%5B%22message%22%5D`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`getUpdates failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
  if (!data.ok) throw new Error('telegram getUpdates returned ok=false');
  return data.result ?? [];
}

// Send a reply. Telegram caps a message at 4096 UTF-16 units, so long agent replies are split on a
// word/line boundary and sent as consecutive messages.
export async function sendMessage(botToken: string, chatId: number, text: string): Promise<void> {
  for (const chunk of splitText(text)) {
    const res = await fetch(`${API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!res.ok) throw new Error(`sendMessage failed: ${res.status} ${await res.text()}`);
  }
}

// Best-effort typing indicator while a turn runs; failures are swallowed by the caller.
export async function sendChatAction(botToken: string, chatId: number, action = 'typing'): Promise<void> {
  await fetch(`${API}/bot${botToken}/sendChatAction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

export function* splitText(text: string, max = 4096): Iterable<string> {
  if (text.length <= max) { yield text; return; }
  let i = 0;
  while (i < text.length) {
    const window = i + max;
    const boundaries = [
      text.lastIndexOf(' ', window) + 1,
      text.lastIndexOf('\n', window) + 1,
    ].filter((v) => v > i && v <= window);
    const end = boundaries.length ? Math.max(...boundaries) : Math.min(window, text.length);
    yield text.slice(i, end);
    i = end;
  }
}
