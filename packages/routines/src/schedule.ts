// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure scheduling logic — no I/O, fully unit-testable. A routine's `schedule` is a small human string:
//   "08:00"             every day at 08:00 (owner-local)
//   "mon 08:00"         Mondays at 08:00
//   "mon,wed,fri 18:30" those weekdays
// Times are evaluated in the owner's IANA timezone via Intl (no date library). "Due" is windowed:
// a routine fires when local time is in [scheduled, scheduled + graceMinutes) on a matching weekday,
// which absorbs poll jitter and brief downtime without firing a freshly-created routine retroactively.

export interface ParsedSchedule {
  days: number[] | null; // null = every day; otherwise weekday numbers (0=Sun..6=Sat)
  minutes: number; // minutes since local midnight
}

export interface LocalNow {
  date: string; // YYYY-MM-DD in the target tz
  weekday: number; // 0=Sun..6=Sat in the target tz
  minutes: number; // minutes since local midnight in the target tz
}

const DAY_NUM: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const WEEKDAY_NUM: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Parse a schedule string, or return null if it is malformed (caller surfaces a clear error).
export function parseSchedule(input: string): ParsedSchedule | null {
  const txt = input.trim().toLowerCase();
  const m = txt.match(/^(?:([a-z,]+)\s+)?([0-2]?\d):([0-5]\d)$/);
  if (!m) return null;
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  if (hh > 23) return null;
  let days: number[] | null = null;
  if (m[1] !== undefined) {
    const out: number[] = [];
    for (const tok of m[1].split(',')) {
      const d = DAY_NUM[tok];
      if (d === undefined) return null;
      if (!out.includes(d)) out.push(d);
    }
    if (out.length === 0) return null;
    days = out;
  }
  return { days, minutes: hh * 60 + mm };
}

export function isValidSchedule(input: string): boolean {
  return parseSchedule(input) !== null;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock parts of `now` in the given IANA timezone.
export function localNow(now: Date, tz: string): LocalNow {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  const hour = Number(p['hour']) % 24; // some locales render midnight as "24"
  const minutes = hour * 60 + Number(p['minute']);
  const weekday = WEEKDAY_NUM[p['weekday'] ?? 'Sun'] ?? 0;
  return { date: `${p['year']}-${p['month']}-${p['day']}`, weekday, minutes };
}

// If the routine is due right now, return its stable window key (e.g. "2026-06-15T08:00") for the
// idempotency guard; otherwise null. graceMinutes is the firing window width after the scheduled time.
export function dueWindow(schedule: string, now: Date, tz: string, graceMinutes: number): string | null {
  const parsed = parseSchedule(schedule);
  if (!parsed) return null;
  const { date, weekday, minutes } = localNow(now, tz);
  if (parsed.days !== null && !parsed.days.includes(weekday)) return null;
  const delta = minutes - parsed.minutes;
  if (delta < 0 || delta >= graceMinutes) return null;
  const hh = String(Math.floor(parsed.minutes / 60)).padStart(2, '0');
  const mm = String(parsed.minutes % 60).padStart(2, '0');
  return `${date}T${hh}:${mm}`;
}
