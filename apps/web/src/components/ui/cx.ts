// SPDX-License-Identifier: AGPL-3.0-or-later
// Tiny classname joiner for the control primitives (no dependency).
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export type Zone = "good" | "info" | "warn" | "alert" | "neutral";
