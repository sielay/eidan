// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fetchEvents } from "./ics.js";

// A weekly recurring event (with one EXDATE cancellation), a single event in-window, and one
// event well in the past — exercises RRULE expansion, EXDATE, windowing, and sorting.
const FEED = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:weekly@example.com
SUMMARY:Weekly Standup
DTSTART:20260601T090000Z
DTEND:20260601T093000Z
RRULE:FREQ=WEEKLY;COUNT=12
EXDATE:20260622T090000Z
END:VEVENT
BEGIN:VEVENT
UID:once@example.com
SUMMARY:One-off Review
DTSTART:20260620T140000Z
DTEND:20260620T150000Z
END:VEVENT
BEGIN:VEVENT
UID:past@example.com
SUMMARY:Old Meeting
DTSTART:20260101T100000Z
END:VEVENT
END:VCALENDAR`;

const FROM = new Date("2026-06-14T00:00:00Z");
const TO = new Date("2026-07-14T00:00:00Z");
const canned = async (): Promise<string> => FEED;

describe("fetchEvents — ics parsing + recurrence", () => {
  it("expands a weekly recurring event into multiple occurrences within the window", async () => {
    const events = await fetchEvents(["feed"], { from: FROM, to: TO, fetcher: canned });
    const standup = events.filter((e) => e.summary === "Weekly Standup");
    assert.ok(standup.length > 1);
    assert.equal(standup.every((e) => e.recurring), true);
  });

  it("honours EXDATE — the cancelled 06-22 occurrence is absent", async () => {
    const events = await fetchEvents(["feed"], { from: FROM, to: TO, fetcher: canned });
    assert.equal(events.some((e) => e.summary === "Weekly Standup" && e.start.slice(0, 10) === "2026-06-22"), false);
    // but the surrounding occurrences are present
    assert.equal(events.some((e) => e.start.slice(0, 10) === "2026-06-15"), true);
    assert.equal(events.some((e) => e.start.slice(0, 10) === "2026-06-29"), true);
  });

  it("keeps a single (non-recurring) event inside the window", async () => {
    const events = await fetchEvents(["feed"], { from: FROM, to: TO, fetcher: canned });
    const once = events.filter((e) => e.summary === "One-off Review");
    assert.equal(once.length, 1);
    assert.equal(once[0]!.recurring, false);
  });

  it("drops events that fall outside the window", async () => {
    const events = await fetchEvents(["feed"], { from: FROM, to: TO, fetcher: canned });
    assert.equal(events.some((e) => e.summary === "Old Meeting"), false);
  });

  it("returns events sorted ascending by start", async () => {
    const events = await fetchEvents(["feed"], { from: FROM, to: TO, fetcher: canned });
    const ms = events.map((e) => e.startMs);
    assert.deepEqual(ms, [...ms].sort((a, b) => a - b));
  });

  // Regression: recurrence expansion must be host-timezone independent. node-ical/rrule.js skew
  // recurring occurrences by the DST offset on a non-UTC-matching host (the Pi/Fly run UTC), which
  // shifted every recurring BST event an hour early. We recombine the occurrence date with the
  // master wall-clock time in the event's IANA zone, so the instant is identical on any host.
  const MS_EXCHANGE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:Microsoft Exchange Server 2010
BEGIN:VTIMEZONE
TZID:GMT Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T010000
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:banter@exchange
SUMMARY:Team banter
DTSTART;TZID=GMT Standard Time:20260105T093000
DTEND;TZID=GMT Standard Time:20260105T100000
RRULE:FREQ=WEEKLY;BYDAY=MO
END:VEVENT
END:VCALENDAR`;

  it("expands a Windows-named (Exchange) recurring event to the correct UTC instant — 09:30 BST = 08:30Z", async () => {
    // Master is anchored in winter (GMT); a June occurrence is in BST. 09:30 local must be 08:30Z.
    const events = await fetchEvents(["x"], {
      from: new Date("2026-06-08T00:00:00Z"),
      to: new Date("2026-06-09T00:00:00Z"),
      fetcher: async () => MS_EXCHANGE,
    });
    const occ = events.find((e) => e.summary === "Team banter");
    assert.notEqual(occ, undefined);
    assert.equal(occ!.start, "2026-06-08T08:30:00.000Z"); // not 07:30Z (the host-skew bug)
    assert.equal(occ!.allDay, false);
  });

  it("surfaces all-day (VALUE=DATE) events as a date with allDay set, never a bogus midnight time", async () => {
    const feed = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:bin@example.com
SUMMARY:Food waste collection
DTSTART;VALUE=DATE:20260616
DTEND;VALUE=DATE:20260617
END:VEVENT
END:VCALENDAR`;
    const events = await fetchEvents(["x"], {
      from: new Date("2026-06-15T09:00:00Z"),
      to: new Date("2026-06-30T00:00:00Z"),
      fetcher: async () => feed,
    });
    const bin = events.find((e) => e.summary === "Food waste collection");
    assert.notEqual(bin, undefined);
    assert.equal(bin!.allDay, true);
    assert.equal(bin!.start, "2026-06-16"); // date only — no T, no Z
    assert.equal(bin!.end, null); // single-day all-day: exclusive DTEND 06-17 -> inclusive == start -> null
  });

  it("treats a multi-day all-day DTEND as exclusive — Fri–Sun ends Sunday, not Monday", async () => {
    // DTSTART 12 Jun (Fri), DTEND 15 Jun (Mon) means the event covers Fri/Sat/Sun and ends Sunday.
    const feed = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:camp@example.com
SUMMARY:Scouts camp
DTSTART;VALUE=DATE:20260612
DTEND;VALUE=DATE:20260615
END:VEVENT
END:VCALENDAR`;
    const events = await fetchEvents(["x"], {
      from: new Date("2026-06-13T09:00:00Z"), // mid-camp (Saturday) — still ongoing
      to: new Date("2026-06-30T00:00:00Z"),
      fetcher: async () => feed,
    });
    const camp = events.find((e) => e.summary === "Scouts camp");
    assert.notEqual(camp, undefined);
    assert.equal(camp!.start, "2026-06-12");
    assert.equal(camp!.end, "2026-06-14"); // Sunday, not the exclusive Monday 06-15
  });

  it("merges multiple feeds", async () => {
    const second = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:other@example.com
SUMMARY:Dentist
DTSTART:20260625T100000Z
END:VEVENT
END:VCALENDAR`;
    const events = await fetchEvents(["a", "b"], {
      from: FROM,
      to: TO,
      fetcher: async (u: string) => (u === "b" ? second : FEED),
    });
    assert.equal(events.some((e) => e.summary === "Dentist"), true);
    assert.equal(events.some((e) => e.summary === "One-off Review"), true);
  });
});
