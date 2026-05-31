// AUTO-GENERATED — do not edit by hand.
// Source: packages/schemas/schemas/**/*.schema.json
// Run `pnpm --filter @eidan/schemas gen:ts` to refresh.
import { z } from "zod"

export const NodeEventList = z.object({ "node_id": z.string().min(1).describe("Echoes the path parameter so the UI can hold one polling tail per node without re-parsing the request."), "events": z.array(z.any()).describe("Zero or more events past the supplied after_seq. Empty array is a valid response — the node exists but has not emitted since.") }).strict().describe("Response shape of GET /api/admin/nodes/{node_id}/events (docs/024 §5.2). Drives the live event tail in the /admin/activity nodes pane. Ordering matches the route: chronological when filtered to a conversation_id, latest-first otherwise.")
export type NodeEventList = z.infer<typeof NodeEventList>
