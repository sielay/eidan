// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure scheduling logic — no I/O, fully unit-testable. A schedule string is one of:
//   clock:    "08:00"  ·  "mon 08:00"  ·  "mon,wed,fri 18:30"   (owner-local wall-clock, once/day/match)
//   interval: "every 5 minutes"  ·  "every 2 hours"  ·  "hourly"  ·  "every minute"
// Clock schedules fire once in a windowed [scheduled, scheduled+grace) slot (absorbs poll jitter and
// brief downtime without firing retroactively). Interval schedules fire once per interval bucket
// (floor(now / N) — the bucket key is the dedup guard, so exactly one node fires each bucket).

export type ParsedSchedule =
  | { kind: 'clock'; days: number[] | null; minutes: number }
  | { kind: 'interval'; everyMinutes: number };

export interface LocalNow {
  date: string; // YYYY-MM-DD in the target tz
  weekday: number; // 0=Sun..6=Sat in the target tz
  minutes: number; // minutes since local midnight in the target tz
}

const DAY_NUM: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const WEEKDAY_NUM: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const UNIT_MIN: Record<string, number> = { m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60 };

export function parseSchedule(input: string): ParsedSchedule | null {
  // Collapse runs of whitespace to single spaces up front, so the patterns below use literal spaces
  // (never adjacent `\s+`/`\s*` quantifiers, which backtrack polynomially on hostile input).
  const txt = input.trim().toLowerCase().replace(/\s+/g, ' ');

  // interval: "hourly", "every minute/hour", "every N minutes/hours"
  if (txt === 'hourly') return { kind: 'interval', everyMinutes: 60 };
  const iv = txt.match(/^every (?:(\d+) )?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/);
  if (iv) {
    const n = iv[1] === undefined ? 1 : Number(iv[1]);
    const unit = UNIT_MIN[iv[2] ?? ''];
    if (!unit || n < 1) return null;
    const everyMinutes = n * unit;
    if (everyMinutes < 1 || everyMinutes > 1440) return null; // 1 min … 24 h
    return { kind: 'interval', everyMinutes };
  }

  // clock: "HH:MM" or "<days> HH:MM"
  const m = txt.match(/^(?:([a-z,]+) )?([0-2]?\d):([0-5]\d)$/);
  if (!m) return null;
  const hh = Number(m[2]);
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
  return { kind: 'clock', days, minutes: hh * 60 + Number(m[3]) };
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

// If due now, return the stable fire key for the idempotency guard; else null.
//  - clock: "<date>T<HH:MM>" once per day inside the grace window.
//  - interval: "i<N>m@<iso bucket start>" once per interval bucket (grace is ignored).
export function dueWindow(schedule: string, now: Date, tz: string, graceMinutes: number): string | null {
  const parsed = parseSchedule(schedule);
  if (!parsed) return null;

  if (parsed.kind === 'interval') {
    const ms = parsed.everyMinutes * 60_000;
    const bucketStart = Math.floor(now.getTime() / ms) * ms;
    return `i${parsed.everyMinutes}m@${new Date(bucketStart).toISOString()}`;
  }

  const { date, weekday, minutes } = localNow(now, tz);
  if (parsed.days !== null && !parsed.days.includes(weekday)) return null;
  const delta = minutes - parsed.minutes;
  if (delta < 0 || delta >= graceMinutes) return null;
  const hh = String(Math.floor(parsed.minutes / 60)).padStart(2, '0');
  const mm = String(parsed.minutes % 60).padStart(2, '0');
  return `${date}T${hh}:${mm}`;
}
