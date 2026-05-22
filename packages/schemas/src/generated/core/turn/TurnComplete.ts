// AUTO-GENERATED — do not edit by hand.
// Source: packages/schemas/schemas/**/*.schema.json
// Run `pnpm --filter @eidan/schemas gen:ts` to refresh.
import { z } from "zod"

export const TurnComplete = z.object({ "user_message_id": z.string().uuid().describe("Id of the persisted user `messages` row for this turn."), "assistant_message_id": z.string().uuid().describe("Id of the persisted assistant `messages` row for this turn.") }).strict().describe("Payload of the terminal SSE `complete` event from POST /api/turn (docs/005 §5.5). Carries the persisted message ids so the UI can flip its optimistic placeholders onto the backend-assigned rows and re-anchor the per-turn cost counter.")
export type TurnComplete = z.infer<typeof TurnComplete>
