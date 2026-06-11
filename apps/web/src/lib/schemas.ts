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
export const TurnInput = z.object({
  conversation_id: z.string(),
  text: z.string(),
  sent_at_utc: z.string(),
  user_tz: z.string(),
});
export type TurnInput = z.infer<typeof TurnInput>;
