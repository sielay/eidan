// AUTO-GENERATED — do not edit by hand.
// Source: packages/schemas/schemas/**/*.schema.json
// Run `pnpm --filter @eidan/schemas gen:ts` to refresh.
import { z } from "zod"

export const IntendedActions = z.object({ "actions": z.array(z.any()).describe("Zero or more intended actions, in the order the user expressed them.") }).strict().describe("Structured list of actions the user expects the agent to perform on a given turn. Emitted by the intent classifier (issue #59, step ④.5 of docs/005 §3). Rendered into the primary call's system prompt so the model executes a known, finite list rather than improvising; stashed on TurnContext so the post-primary verifier (issue #60) can check which declared actions left a side-effect.")
export type IntendedActions = z.infer<typeof IntendedActions>
