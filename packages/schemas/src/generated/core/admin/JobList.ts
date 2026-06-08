// AUTO-GENERATED — do not edit by hand.
// Source: packages/schemas/schemas/**/*.schema.json
// Run `pnpm --filter @eidan/schemas gen:ts` to refresh.
import { z } from "zod"

export const JobList = z.object({ "jobs": z.array(z.any()).describe("Recent jobs, newest first (by created_at), capped at the server's most-recent limit.") }).strict().describe("Response shape of GET /api/admin/jobs (#251). The operator's window onto the universal delegation queue eidan.jobs (#247/#248): recent rows newest-first, capped server-side. The queue is a working set (terminal rows are not pruned here), so this is a recency-bounded snapshot, not the full history.")
export type JobList = z.infer<typeof JobList>
