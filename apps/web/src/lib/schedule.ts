// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal schedule validator shared by the agents API routes — mirrors @eidandev/agents schedule.ts.
//   clock:    "HH:MM" · "<days> HH:MM"        (owner-local wall-clock)
//   interval: "every 5 minutes" · "every 2 hours" · "hourly" · "every minute"

const DAYS = new Set(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
const UNIT_MIN: Record<string, number> = {
  m: 1, min: 1, mins: 1, minute: 1, minutes: 1,
  h: 60, hr: 60, hrs: 60, hour: 60, hours: 60,
};

export function isValidSchedule(input: string): boolean {
  // Collapse runs of whitespace to single spaces up front, so the patterns below use literal spaces
  // (never adjacent `\s+`/`\s*` quantifiers, which backtrack polynomially on hostile input).
  const txt = input.trim().toLowerCase().replace(/\s+/g, " ");

  if (txt === "hourly") return true;
  const iv = txt.match(/^every (?:(\d+) )?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/);
  if (iv) {
    const n = iv[1] === undefined ? 1 : Number(iv[1]);
    const unit = UNIT_MIN[iv[2] ?? ""] ?? 0;
    const everyMinutes = n * unit;
    return n >= 1 && everyMinutes >= 1 && everyMinutes <= 1440;
  }

  const m = txt.match(/^(?:([a-z,]+) )?([0-2]?\d):([0-5]\d)$/);
  if (!m) return false;
  if (Number(m[2]) > 23) return false;
  if (m[1] !== undefined) {
    const toks = m[1].split(",");
    if (toks.length === 0 || !toks.every((t) => DAYS.has(t))) return false;
  }
  return true;
}
