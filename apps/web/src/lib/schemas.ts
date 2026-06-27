// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

/**
 * Local cross-boundary DTOs.
 *
 * The matbot pivot eliminates the `@eidan/schemas` JSON-Schema→Zod
 * codegen package ([[matbot_core_pivot]]). The web client still needs to
 * validate the couple of request/response shapes it speaks, so the
 * formerly-codegen'd DTOs it depends on are declared locally here. Keep
 * these in sync with the backend wire (`docs/010 §6`, `docs/005 §5.5`).
 */

/** `GET /api/cost/summary` rollup (`docs/010 §6`). */
export const CostSummary = z.object({
  scope: z.enum(["turn", "session", "day"]),
  cost_usd: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
});
export type CostSummary = z.infer<typeof CostSummary>;

/** `POST /api/turn` request body (eidan-owned, snake_case; `docs/005 §5.5`). */
// One attachment sent with a turn: base64 payload + its mime + filename. The engine folds these into
// the user message (images → vision blocks; text files → inlined into the prompt).
export const TurnAttachment = z.object({
  data: z.string(),
  mime: z.string(),
  name: z.string().optional(),
});
export type TurnAttachment = z.infer<typeof TurnAttachment>;

export const TurnInput = z.object({
  conversation_id: z.string(),
  text: z.string(),
  sent_at_utc: z.string(),
  user_tz: z.string(),
  // Optional matbot provider name (one model per provider). Omitted ⇒ server default.
  provider: z.string().optional(),
  // Optional files attached to this turn.
  attachments: z.array(TurnAttachment).optional(),
  // Fork-and-merge ("⑂ Compare"): ≥2 provider names to race this prompt against in parallel; the
  // turn's `provider` then judges + merges them into one answer. Omitted/<2 ⇒ a normal single turn.
  compare: z.array(z.string()).optional(),
});
export type TurnInput = z.infer<typeof TurnInput>;
