// AUTO-GENERATED — do not edit by hand.
// Source: packages/schemas/schemas/**/*.schema.json
// Run `pnpm --filter @eidan/schemas gen:ts` to refresh.
import { z } from "zod"

export const ConversationUpdate = z.object({ "title": z.union([z.string().max(200).describe("Human-readable label shown in the sidebar and conversation header. Trimmed of surrounding whitespace by the handler. Null (or empty after trim) clears the title back to autogen-eligible state per issue #48."), z.null().describe("Human-readable label shown in the sidebar and conversation header. Trimmed of surrounding whitespace by the handler. Null (or empty after trim) clears the title back to autogen-eligible state per issue #48.")]).describe("Human-readable label shown in the sidebar and conversation header. Trimmed of surrounding whitespace by the handler. Null (or empty after trim) clears the title back to autogen-eligible state per issue #48.").optional() }).strict().describe("Request body for PATCH /api/conversations/{id} — the editable fields on a conversation row. Per issue #48 the only editable field today is the operator-facing title; null clears the title and makes the conversation eligible for auto-title regeneration on the next opportunity.")
export type ConversationUpdate = z.infer<typeof ConversationUpdate>
