// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";

/**
 * `/admin/activity` lands on the conversations tab by default —
 * mirrors the "running work first" stance documented in
 * `docs/014 §3`'s admin row.
 */
export default function AdminActivityIndex(): never {
  redirect("/admin/activity/conversations");
}
