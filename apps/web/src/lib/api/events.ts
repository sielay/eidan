// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { authFetch } from "@/lib/auth";

// Mutate a single event (Memory → Events). The list lives in MemoryScreen's loader; these just poke the
// row and the caller reloads.
export async function deleteEvent(id: string): Promise<void> {
  const res = await authFetch(`/api/events/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`DELETE /api/events/${id} returned ${res.status}`);
}

export async function setEventStatus(id: string, status: "done" | "pending"): Promise<void> {
  const res = await authFetch(`/api/events/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
  if (!res.ok) throw new Error(`PATCH /api/events/${id} returned ${res.status}`);
}
