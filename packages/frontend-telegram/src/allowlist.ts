// SPDX-License-Identifier: AGPL-3.0-or-later
// The admission policy for the inbound Telegram surface, kept as pure logic so it can be unit
// tested without a live bot. An operator supplies an allowlist mapping Telegram ids -> eidan
// principal ids (a real eidan.users UUID). Resolution is default-deny: a sender not on the list
// gets no principal and is rejected, so an unknown Telegram user can never open a turn.
//
// The wire is snake_case (Telegram's own field names: `from.id`, `chat.id`). Ids are Telegram's
// signed integers; we key the map by their decimal string form to keep one stable lookup key.

import type { Principal } from '@matatbread/matbot-plugin-api';

// A resolved allowlist: telegram id (decimal string) -> eidan principal id.
export type Allowlist = Map<string, string>;

// Parse EIDAN_TELEGRAM_ALLOWLIST. Accepts a JSON object whose keys are Telegram ids (user id or
// chat id, as a number or numeric string) and whose values are the eidan principal id to run as.
// A malformed blob yields an empty allowlist (fail-closed: nobody is admitted) and a warning —
// never a throw, so a bad config can't crash boot.
export function loadAllowlist(raw: string | undefined): Allowlist {
  const out: Allowlist = new Map();
  if (!raw || !raw.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[frontend-telegram] failed to parse EIDAN_TELEGRAM_ALLOWLIST as JSON');
    return out;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn('[frontend-telegram] EIDAN_TELEGRAM_ALLOWLIST must be a JSON object');
    return out;
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const id = normaliseId(key);
    if (id === undefined) {
      console.warn(`[frontend-telegram] skipping allowlist entry '${key}': key must be a Telegram numeric id`);
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      console.warn(`[frontend-telegram] skipping allowlist entry '${key}': value must be a non-empty eidan principal id`);
      continue;
    }
    out.set(id, value.trim());
  }
  return out;
}

// A Telegram id may arrive as a JSON number key (string) or a number off the API. Accept either,
// reject anything that isn't a base-10 integer, and return the canonical decimal-string key.
export function normaliseId(value: string | number): string | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : undefined;
  }
  const trimmed = value.trim();
  return /^-?\d+$/.test(trimmed) ? String(Number.parseInt(trimmed, 10)) : undefined;
}

// The minimal shape of an inbound Telegram message we admit on. Both the sender (`from.id`) and the
// conversation (`chat.id`) are consulted so an operator can allow a specific user OR a whole chat
// (e.g. a private group). `from` is absent on channel posts — those are never admitted.
export interface InboundSender {
  fromId?: number;
  chatId: number;
}

// Resolve a sender to the eidan principal it may act as, or undefined to reject. The user id is
// preferred over the chat id so a per-user mapping wins inside an allowed group. The returned
// principal is always type 'user' — a Telegram message is a human acting, never an agent/system.
export function resolvePrincipal(allow: Allowlist, sender: InboundSender): Principal | undefined {
  if (allow.size === 0) return undefined;
  const fromKey = sender.fromId !== undefined ? normaliseId(sender.fromId) : undefined;
  const chatKey = normaliseId(sender.chatId);
  const id = (fromKey !== undefined ? allow.get(fromKey) : undefined) ?? (chatKey !== undefined ? allow.get(chatKey) : undefined);
  if (id === undefined) return undefined;
  return { id, type: 'user' };
}
