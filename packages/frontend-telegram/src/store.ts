// SPDX-License-Identifier: AGPL-3.0-or-later
import { Db } from './db.js';

export interface LinkTokenInfo {
  chat_id: number;
  first_name: string | null;
  username: string | null;
}

// The Telegram binding store: one-time link tokens + the chat<->user binding. All ids are explicit;
// no ambient principal needed (the /start mint is pre-auth; the bind runs under the web caller's
// principal but writes its id explicitly).
export class TelegramStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // /start: mint a fresh one-time token for this chat (clearing any prior unused one).
  async createLinkToken(chatId: number, firstName: string | null, username: string | null): Promise<string> {
    await this.db.query('delete from eidan.telegram_link_tokens where chat_id = $1 and used_at is null', [chatId]);
    const r = await this.db.query(
      'insert into eidan.telegram_link_tokens (chat_id, first_name, username) values ($1, $2, $3) returning token',
      [chatId, firstName, username],
    );
    return (r.rows[0] as { token: string }).token;
  }

  // Redeem: valid = unused AND < 30 min old. Marks it used and returns the captured chat info, or null.
  async consumeToken(token: string): Promise<LinkTokenInfo | null> {
    const r = await this.db.query(
      `update eidan.telegram_link_tokens set used_at = now()
       where token = $1 and used_at is null and created_at > now() - interval '30 minutes'
       returning chat_id, first_name, username`,
      [token],
    );
    const row = r.rows[0] as { chat_id: string; first_name: string | null; username: string | null } | undefined;
    if (!row) return null;
    return { chat_id: Number(row.chat_id), first_name: row.first_name, username: row.username };
  }

  // Bind a chat to a user. A chat moves to its newest owner; a user keeps one chat (re-link replaces).
  async bind(userId: string, chatId: number, firstName: string | null, username: string | null): Promise<void> {
    await this.db.query('delete from eidan.telegram_chats where chat_id = $1 and user_id <> $2', [chatId, userId]);
    await this.db.query(
      `insert into eidan.telegram_chats (user_id, chat_id, username, first_name)
       values ($1, $2, $3, $4)
       on conflict (user_id) do update set
         chat_id = excluded.chat_id, username = excluded.username,
         first_name = excluded.first_name, updated_at = now()`,
      [userId, chatId, username, firstName],
    );
  }

  // Inbound admission: which eidan user owns this chat (if bound).
  async userForChat(chatId: number): Promise<string | null> {
    const r = await this.db.query('select user_id from eidan.telegram_chats where chat_id = $1', [chatId]);
    return (r.rows[0] as { user_id: string } | undefined)?.user_id ?? null;
  }

  // Outbound: the chat to deliver to for a given user (if bound).
  async chatForUser(userId: string): Promise<number | null> {
    const r = await this.db.query('select chat_id from eidan.telegram_chats where user_id = $1', [userId]);
    const row = r.rows[0] as { chat_id: string } | undefined;
    return row ? Number(row.chat_id) : null;
  }
}
