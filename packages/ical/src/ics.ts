// SPDX-License-Identifier: AGPL-3.0-or-later
// iCal (.ics) feed fetching + parsing for the eidan `ical` plugin.
//
// Parsing + recurrence expansion uses `node-ical`: a recurring VEVENT (weekly standup, etc.) is
// expanded to its concrete occurrences within the requested window via its RRULE, with EXDATE
// cancellations and per-occurrence RECURRENCE-ID overrides honoured. Read-through — nothing is
// synced/stored. The HTTP fetch is injectable so expansion can be unit-tested against canned .ics
// text with no network.
import nodeIcal from 'node-ical';

// We only use the string parser; cast to the slice of the API we rely on so we don't depend on the
// exact shape of node-ical's bundled types.
const ical = nodeIcal as unknown as {
  async: { parseICS(data: string): Promise<Record<string, unknown>> };
};

// A fetcher takes a feed URL and returns its raw .ics text. Injected in tests.
export type Fetcher = (url: string) => Promise<string>;

export class IcalError extends Error {}

export interface CalEvent {
  uid: string;
  summary: string;
  // Timed events: ISO-8601 (UTC) of this occurrence. All-day events: a plain `YYYY-MM-DD` date
  // (no time, no zone) — `allDay` says which, so the renderer never prints a bogus midnight time.
  start: string;
  end: string | null;
  location: string | null;
  startMs: number; // epoch ms of this occurrence, for sorting/filtering
  recurring: boolean;
  allDay: boolean;
}

// The slice of node-ical's VEVENT we read. `rrule` is an rrule.js instance; `recurrences` maps a
// YYYY-MM-DD occurrence key to a modified VEVENT; `exdate` maps the same key to a cancelled Date.
// `datetype`/`start.dateOnly` flag VALUE=DATE all-day events; `start.tz` is the IANA zone node-ical
// resolved (it maps Windows names like "GMT Standard Time" -> "Europe/London"); `rrule.origOptions
// .tzid` is the same zone on the rule.
interface VEventLike {
  type?: string;
  uid?: string;
  summary?: string;
  location?: string;
  datetype?: string;
  start?: Date & { tz?: string; dateOnly?: boolean };
  end?: Date;
  rrule?: { between(after: Date, before: Date, inc?: boolean): Date[]; origOptions?: { tzid?: string } };
  exdate?: Record<string, Date | string>;
  recurrences?: Record<string, VEventLike>;
}

// --- Host-TZ-independent time helpers --------------------------------------------------------
// node-ical/rrule.js expand recurrences using the PROCESS's local timezone, so on a UTC host (Fly,
// the Pi) every recurring event comes out shifted by the DST offset (an hour early in summer). We
// never trust rrule's time-of-day: we keep only the (reliable) occurrence DATE and recombine it
// with the master's wall-clock time, resolved DST-aware in the event's own IANA zone. That makes
// the result identical on any host. Done with Intl only — no tz library, no `process.env.TZ`.

interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function partsIn(tz: string, at: Date): WallClock {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  return {
    y: Number(p['year']),
    mo: Number(p['month']),
    d: Number(p['day']),
    h: Number(p['hour'] === '24' ? '00' : p['hour']),
    mi: Number(p['minute']),
    s: Number(p['second']),
  };
}

// Minutes east of UTC for `tz` at instant `at`.
function offsetEastMinutes(tz: string, at: Date): number {
  const w = partsIn(tz, at);
  const asUTC = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return Math.round((asUTC - at.getTime()) / 60000);
}

// A wall-clock time in `tz` -> the UTC instant it denotes (two passes settle a DST transition).
function zonedToUtc(w: WallClock, tz: string): Date {
  const naive = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  let off = offsetEastMinutes(tz, new Date(naive));
  off = offsetEastMinutes(tz, new Date(naive - off * 60000));
  return new Date(naive - off * 60000);
}

// The event's resolved IANA zone, or null for floating/zoneless times.
function eventZone(e: VEventLike): string | null {
  const tz = e.start?.tz ?? e.rrule?.origOptions?.tzid;
  return typeof tz === 'string' && tz ? tz : null;
}

function isAllDay(e: VEventLike): boolean {
  return e.datetype === 'date' || e.start?.dateOnly === true;
}

// All-day events carry no time/zone — node-ical builds them at LOCAL midnight, so the calendar date
// is the date's local Y-M-D on any host. Emit `YYYY-MM-DD`.
function localDateOnly(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

async function httpFetch(url: string): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  } catch (exc) {
    throw new IcalError(`failed to fetch feed: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
  if (resp.status !== 200) throw new IcalError(`feed returned HTTP ${resp.status}`);
  return await resp.text();
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Expand one parsed feed into concrete CalEvents within [from, to]. Recurring events are expanded
// occurrence-by-occurrence; non-recurring events are kept only if their start falls in the window.
function expand(parsed: Record<string, unknown>, from: Date, to: Date): CalEvent[] {
  const out: CalEvent[] = [];
  for (const raw of Object.values(parsed)) {
    const e = raw as VEventLike;
    if (e.type !== 'VEVENT') continue;

    if (e.rrule) {
      const zone = eventZone(e);
      const allDay = isAllDay(e);
      // Master wall-clock time (constant for the series) in the event's own zone.
      const masterWall = zone && e.start ? partsIn(zone, e.start) : null;
      let occurrences: Date[] = [];
      try {
        occurrences = e.rrule.between(from, to, true);
      } catch {
        if (e.start) occurrences = [e.start]; // odd rule — degrade to the master start
      }
      for (const occStart of occurrences) {
        const key = dayKey(occStart);
        // EXDATE — this occurrence was cancelled.
        if (e.exdate) {
          const excluded = Object.values(e.exdate).some((ex) => {
            const d = ex instanceof Date ? ex : new Date(String(ex));
            return dayKey(d) === key;
          });
          if (excluded) continue;
        }

        // RECURRENCE-ID override: node-ical already resolved this moved/edited occurrence to a
        // concrete instant — use it verbatim (it isn't subject to the rrule expansion skew).
        const override = e.recurrences?.[key];
        if (override?.start) {
          const oAllDay = isAllDay(override);
          out.push(makeEvent(override, e, override.start, override.end ?? null, oAllDay));
          continue;
        }

        // Ordinary occurrence: rrule's DATE is reliable but its time-of-day is skewed by the host
        // timezone. Recombine the occurrence's date (read in the event zone) with the master's
        // wall-clock time, resolved DST-aware. Fall back to rrule's raw instant if no zone.
        let start = occStart;
        if (!allDay && zone && masterWall) {
          try {
            const od = partsIn(zone, occStart);
            start = zonedToUtc({ y: od.y, mo: od.mo, d: od.d, h: masterWall.h, mi: masterWall.mi, s: masterWall.s }, zone);
          } catch {
            start = occStart;
          }
        }
        const dur = e.end && e.start ? e.end.getTime() - e.start.getTime() : null;
        const end = dur != null ? new Date(start.getTime() + dur) : null;
        out.push(makeEvent(e, e, start, end, allDay));
      }
    } else {
      if (!e.start) continue;
      const start = e.start instanceof Date ? e.start : new Date(e.start);
      const end = e.end ? (e.end instanceof Date ? e.end : new Date(e.end)) : null;
      const allDay = isAllDay(e);
      // All-day events span [start, end) — keep them while the day is current or future, so a
      // "today" all-day item isn't dropped just because its local midnight is before `now`.
      if (allDay) {
        if ((end ?? new Date(start.getTime() + 86_400_000)) <= from || start > to) continue;
      } else if (start < from || start > to) {
        continue;
      }
      out.push(makeEvent(e, e, start, end, allDay));
    }
  }
  return out;
}

// Build a CalEvent from a (possibly overridden) source event. All-day events surface a date-only
// string; timed events surface the UTC ISO instant. `fallback` supplies uid/summary/location when
// the source (a RECURRENCE-ID override) omits them.
function makeEvent(
  src: VEventLike,
  fallback: VEventLike,
  start: Date,
  end: Date | null,
  allDay: boolean,
): CalEvent {
  const startStr = allDay ? localDateOnly(start) : null;
  return {
    uid: src.uid ?? fallback.uid ?? '',
    summary: src.summary ?? fallback.summary ?? '',
    location: src.location ?? fallback.location ?? null,
    start: startStr ?? start.toISOString(),
    end: end ? (allDay ? allDayInclusiveEnd(startStr!, end) : end.toISOString()) : null,
    startMs: start.getTime(),
    recurring: Boolean(fallback.rrule),
    allDay,
  };
}

// In iCal an all-day event's DTEND is EXCLUSIVE (a Fri–Sun event ends DTEND=Mon). Step back one
// day to the last day actually covered, so the agent doesn't think it runs into the end date.
// Returns null for a single-day event (inclusive end == start), so nothing redundant is shown.
function allDayInclusiveEnd(startStr: string, endExclusive: Date): string | null {
  const [y, mo, d] = localDateOnly(endExclusive).split('-').map(Number);
  const t = new Date(Date.UTC(y!, mo! - 1, d!));
  t.setUTCDate(t.getUTCDate() - 1);
  const inc = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  return inc > startStr ? inc : null;
}

// Fetch + parse + expand every feed, return events within [from, to] sorted by start.
export async function fetchEvents(
  feedUrls: Iterable<string>,
  opts: { from: Date; to: Date; fetcher?: Fetcher },
): Promise<CalEvent[]> {
  const fetcher = opts.fetcher ?? httpFetch;
  const collected: CalEvent[] = [];
  for (const raw of feedUrls) {
    const url = raw.trim();
    if (!url) continue;
    const text = await fetcher(url);
    let parsed: Record<string, unknown>;
    try {
      parsed = await ical.async.parseICS(text);
    } catch (exc) {
      throw new IcalError(`failed to parse feed: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
    collected.push(...expand(parsed, opts.from, opts.to));
  }
  collected.sort((a, b) => a.startMs - b.startMs);
  return collected;
}
