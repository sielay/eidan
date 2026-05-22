// AUTO-GENERATED — do not edit by hand.
// Source: packages/schemas/schemas/**/*.schema.json
// Run `pnpm --filter @eidan/schemas gen:ts` to refresh.
import { z } from "zod"

export const TurnChunk = z.object({ "text": z.string().describe("The incremental assistant text delta for this frame. May be empty when the provider emits structural-only chunks.") }).strict().describe("Payload of an SSE `chunk` event from POST /api/turn — one slice of streamed assistant text (docs/005 §5.5). Multiple chunks compose a single assistant message; the runner concatenates them into the persisted row before emitting TurnComplete.")
export type TurnChunk = z.infer<typeof TurnChunk>
