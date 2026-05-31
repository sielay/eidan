// AUTO-GENERATED — do not edit by hand.
// Source: packages/schemas/schemas/**/*.schema.json
// Run `pnpm --filter @eidan/schemas gen:ts` to refresh.
import { z } from "zod"

export const NodeList = z.object({ "nodes": z.array(z.any()).describe("Zero or more registered nodes. Empty array is a valid response on a fresh deployment.") }).strict().describe("Response shape of GET /api/admin/nodes (docs/024 §5.1). One row per registered backend process; ordered by last_seen DESC so live nodes float to the top. The UI uses seconds_since to render the heartbeat-freshness dot (≤90s green / ≤600s amber / else red per docs/024 §1.2).")
export type NodeList = z.infer<typeof NodeList>
