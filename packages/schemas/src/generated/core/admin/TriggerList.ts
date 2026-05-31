// AUTO-GENERATED — do not edit by hand.
// Source: packages/schemas/schemas/**/*.schema.json
// Run `pnpm --filter @eidan/schemas gen:ts` to refresh.
import { z } from "zod"

export const TriggerList = z.object({ "triggers": z.array(z.any()).describe("Every behaviour registered with the in-process BehaviourRegistry, in registration order."), "dlq_count": z.number().int().gte(0).describe("Total rows in eidan.behaviour_dlq. Non-zero means at least one cron/schedule firing has thrown — operator should drill in via psql or a future DLQ pane.") }).strict().describe("Response shape of GET /api/admin/triggers. Read-only snapshot of the in-process behaviour dispatcher (docs/006 §4) plus a rolled-up count of the DLQ. 'Last fire' is not surfaced because the registry does not record it yet — only next_run_ts (when APScheduler owns the trigger) and the DLQ tail give the operator a concrete signal today; richer per-behaviour timing lands when docs/006 §4.4's per-turn snapshot does.")
export type TriggerList = z.infer<typeof TriggerList>
