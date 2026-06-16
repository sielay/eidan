// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, isValidSchedule, isValidTimeZone, localNow, dueWindow } from './schedule.js';

describe('parseSchedule', () => {
  it('parses a bare daily time (every day)', () => {
    assert.deepEqual(parseSchedule('08:00'), { days: null, minutes: 480 });
    assert.deepEqual(parseSchedule('00:00'), { days: null, minutes: 0 });
    assert.deepEqual(parseSchedule('23:59'), { days: null, minutes: 23 * 60 + 59 });
  });

  it('parses a single weekday', () => {
    assert.deepEqual(parseSchedule('mon 08:00'), { days: [1], minutes: 480 });
    assert.deepEqual(parseSchedule('sun 20:00'), { days: [0], minutes: 1200 });
    assert.deepEqual(parseSchedule('sat 09:30'), { days: [6], minutes: 570 });
  });

  it('parses a comma list of weekdays (order preserved, deduped)', () => {
    assert.deepEqual(parseSchedule('mon,wed,fri 18:30'), { days: [1, 3, 5], minutes: 1110 });
    assert.deepEqual(parseSchedule('mon,mon 08:00'), { days: [1], minutes: 480 });
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    assert.deepEqual(parseSchedule('  MON  08:00 '), { days: [1], minutes: 480 });
  });

  it('rejects malformed input', () => {
    for (const bad of ['25:00', '08:60', 'xyz 08:00', 'mon,zzz 08:00', '8', '08', 'mon', '', '  ', '08:5', 'mon 7:5']) {
      assert.equal(parseSchedule(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });

  it('accepts hour 0..23 only', () => {
    assert.ok(parseSchedule('23:00'));
    assert.equal(parseSchedule('24:00'), null);
  });
});

describe('isValidSchedule', () => {
  it('mirrors parseSchedule success', () => {
    assert.equal(isValidSchedule('mon,fri 08:00'), true);
    assert.equal(isValidSchedule('nope'), false);
  });
});

describe('isValidTimeZone', () => {
  it('accepts real IANA zones', () => {
    assert.equal(isValidTimeZone('UTC'), true);
    assert.equal(isValidTimeZone('Europe/Warsaw'), true);
    assert.equal(isValidTimeZone('America/New_York'), true);
  });
  it('rejects nonsense zones', () => {
    assert.equal(isValidTimeZone('Mars/Phobos'), false);
    assert.equal(isValidTimeZone('Not/AZone'), false);
  });
});

describe('localNow', () => {
  // 2026-06-15 06:05:00Z is a Monday; Europe/Warsaw is UTC+2 in June (CEST).
  const now = new Date('2026-06-15T06:05:00Z');
  it('reports UTC wall-clock', () => {
    assert.deepEqual(localNow(now, 'UTC'), { date: '2026-06-15', weekday: 1, minutes: 6 * 60 + 5 });
  });
  it('shifts into the target timezone (UTC+2)', () => {
    assert.deepEqual(localNow(now, 'Europe/Warsaw'), { date: '2026-06-15', weekday: 1, minutes: 8 * 60 + 5 });
  });
  it('can roll the local date/weekday across the UTC boundary', () => {
    // 23:30Z Sunday → 01:30 Monday in Warsaw (+2): date + weekday advance.
    const lateSun = new Date('2026-06-14T23:30:00Z'); // 2026-06-14 is a Sunday
    const w = localNow(lateSun, 'Europe/Warsaw');
    assert.equal(w.date, '2026-06-15');
    assert.equal(w.weekday, 1); // Monday
    assert.equal(w.minutes, 90);
  });
});

describe('dueWindow', () => {
  const now = new Date('2026-06-15T06:05:00Z'); // Monday, 06:05 UTC

  it('fires inside the grace window, returning the stable window key', () => {
    assert.equal(dueWindow('06:00', now, 'UTC', 30), '2026-06-15T06:00');
  });
  it('does not fire before the scheduled time', () => {
    assert.equal(dueWindow('06:40', now, 'UTC', 30), null);
  });
  it('does not fire once past the grace window (missed)', () => {
    assert.equal(dueWindow('05:00', now, 'UTC', 30), null);
  });
  it('respects the weekday filter', () => {
    assert.equal(dueWindow('tue 06:00', now, 'UTC', 30), null); // now is Monday
    assert.equal(dueWindow('mon 06:00', now, 'UTC', 30), '2026-06-15T06:00');
  });
  it('evaluates the schedule in the owner timezone', () => {
    // 06:05Z == 08:05 in Warsaw → an 08:00 Warsaw schedule is due.
    assert.equal(dueWindow('08:00', now, 'Europe/Warsaw', 30), '2026-06-15T08:00');
    // ...but an 08:00 UTC schedule is not (it's only 06:05 UTC).
    assert.equal(dueWindow('08:00', now, 'UTC', 30), null);
  });
  it('returns null for a malformed schedule', () => {
    assert.equal(dueWindow('garbage', now, 'UTC', 30), null);
  });
  it('the window key is the scheduled instant, independent of the firing minute within grace', () => {
    const at0602 = new Date('2026-06-15T06:02:00Z');
    const at0625 = new Date('2026-06-15T06:25:00Z');
    assert.equal(dueWindow('06:00', at0602, 'UTC', 30), '2026-06-15T06:00');
    assert.equal(dueWindow('06:00', at0625, 'UTC', 30), '2026-06-15T06:00');
  });
});
