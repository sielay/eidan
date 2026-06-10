// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";

/**
 * `/admin/activity` lands on the dashboard tab by default — the
 * at-a-glance overview (turn volume, jobs, loop tallies) is the natural
 * entry point; the per-area tabs (conversations / nodes / cursors / …)
 * sit one click away. See `docs/014 §3`'s admin row.
 */
export default function AdminActivityIndex(): never {
  redirect("/admin/activity/dashboard");
}
