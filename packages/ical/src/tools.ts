// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `ical` plugin — read the operator's named calendar feeds.
//
// Per-user: the operator registers calendars in the Calendars screen (name + .ics URL + a context
// prompt describing what the calendar is for). Each URL is sealed in the vault under the calendar's
// `vault_key`; the registry rows live in plugin_ical.calendars. At call time the tools list the
// caller's calendars, resolve each URL from the vault, fetch + parse the feeds, and annotate every
// event with its calendar's name + context so the agent can weigh it. Read-through — nothing stored.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { type CalEvent, fetchEvents, IcalError } from './ics.js';
import type { Db } from './db.js';

const UPCOMING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    days: { type: 'integer', description: 'Look-ahead window in days (default 14).', minimum: 1, maximum: 365 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
};
const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', description: 'Text to match in event titles.', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
};

interface ResolvedCalendar {
  name: string;
  context: string;
  url: string;
}

// Resolve the caller's calendars: registry rows → each URL from the vault under its vault_key. Falls
// back to the legacy single `EIDAN_ICAL_FEED_URLS` (unnamed, comma-joined) when no calendars are
// registered, so older env/secret setups keep working.
async function resolveCalendars(db: Db, ctx: ToolContext): Promise<ResolvedCalendar[]> {
  const out: ResolvedCalendar[] = [];
  for (const row of await db.listCalendars()) {
    try {
      const url = await ctx.vault.resolve('${' + row.vault_key + '}');
      if (url && url.trim()) out.push({ name: row.name, context: row.context, url: url.trim() });
    } catch {
      // A calendar whose secret was removed out-of-band — skip it rather than fail the whole call.
    }
  }
  if (out.length === 0) {
    let legacy = '';
    try {
      legacy = await ctx.vault.resolve('${EIDAN_ICAL_FEED_URLS}');
    } catch {
      legacy = '';
    }
    for (const u of String(legacy ?? '').split(/[\s,]+/).filter((x) => x.trim())) {
      out.push({ name: '', context: '', url: u.trim() });
    }
  }
  if (out.length === 0) {
    throw new IcalError(
      'No calendars configured — add one under Calendars (a name, the .ics/CalDAV URL, and a note ' +
        'on what the calendar is for).',
    );
  }
  return out;
}

interface TaggedEvent {
  calendar: string;
  context: string;
  event: CalEvent;
}

// Fetch every calendar (one bad feed never sinks the rest), tag each event with its source, sort.
// The window bounds RRULE expansion, so it must be finite for both tools.
async function gather(cals: ResolvedCalendar[], opts: { from: Date; to: Date }): Promise<TaggedEvent[]> {
  const tagged: TaggedEvent[] = [];
  for (const cal of cals) {
    let events: CalEvent[];
    try {
      events = await fetchEvents([cal.url], opts);
    } catch {
      continue;
    }
    for (const e of events) tagged.push({ calendar: cal.name, context: cal.context, event: e });
  }
  tagged.sort((a, b) => a.event.startMs - b.event.startMs);
  return tagged;
}

// Render an event time for the agent. All-day events surface a plain date ("Mon, 15 Jun 2026, all
// day") with no time/zone. Timed events render as wall-clock in the operator's zone, e.g.
// "Mon, 15 Jun 2026, 09:30 BST" — the zone label says it's already local, so the agent must NOT
// re-convert. Without a configured zone, fall back to the raw UTC ISO (clearly the engine default).
function fmt(value: string | null, allDay: boolean, tz: string): string | null {
  if (!value) return null;
  if (allDay) {
    const [y, mo, d] = value.split('-').map(Number);
    if (!y || !mo || !d) return value;
    return (
      new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-GB', {
        timeZone: 'UTC',
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }) + ', all day'
    );
  }
  if (!tz) return value;
  try {
    return new Date(value).toLocaleString('en-GB', {
      timeZone: tz,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    });
  } catch {
    return value;
  }
}

function view(t: TaggedEvent, tz: string): Record<string, unknown> {
  const e = t.event;
  const v: Record<string, unknown> = {
    summary: e.summary,
    start: fmt(e.start, e.allDay, tz),
    end: fmt(e.end, e.allDay, tz),
    location: e.location,
    uid: e.uid,
  };
  if (e.recurring) v['recurring'] = true;
  if (t.calendar) v['calendar'] = t.calendar;
  if (t.context) v['context'] = t.context;
  return v;
}

export function makeCalendarTools(db: Db): Tool[] {
  const calendarUpcomingTool: Tool = {
    name: 'calendar_upcoming',
    description:
      "List the operator's upcoming calendar events (title, start, end, location) within the next N " +
      "days, across all their named calendars. Each event carries its `calendar` name and `context` " +
      "(what that calendar is for / how important it is). The result also includes the operator's " +
      "general `routine` (their typical day shape, constraints, energy) — weigh events against it " +
      "when judging timing + priority. Use to answer 'what's on my calendar'.",
    inputSchema: UPCOMING_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { days?: number; limit?: number };
        const cals = await resolveCalendars(db, ctx);
        const now = Date.now();
        const tagged = await gather(cals, {
          from: new Date(now),
          to: new Date(now + (Number(args.days) || 14) * 86_400_000),
        });
        const { routine, timezone } = await db.getSettings();
        const events = tagged.slice(0, Number(args.limit) || 50).map((t) => view(t, timezone));
        yield { type: 'result', value: routine ? { routine, events } : { events } };
      },
    },
  };

  const calendarSearchTool: Tool = {
    name: 'calendar_search',
    description:
      "Find calendar events whose title matches the query across all the operator's named calendars " +
      '(past and future). Each hit carries its `calendar` name and `context`.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim().toLowerCase();
        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }
        const cals = await resolveCalendars(db, ctx);
        const now = Date.now();
        const tagged = await gather(cals, {
          from: new Date(now - 180 * 86_400_000),
          to: new Date(now + 365 * 86_400_000),
        });
        const { routine, timezone } = await db.getSettings();
        const events = tagged
          .filter((t) => t.event.summary.toLowerCase().includes(query))
          .slice(0, Number(args.limit) || 50)
          .map((t) => view(t, timezone));
        yield { type: 'result', value: routine ? { routine, events } : { events } };
      },
    },
  };

  return [calendarUpcomingTool, calendarSearchTool];
}
