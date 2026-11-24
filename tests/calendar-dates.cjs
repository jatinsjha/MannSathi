const assert = require('node:assert/strict');
const dates = require('../js/utils/date-utils.js');

process.env.TZ = 'Asia/Kolkata';
assert.equal(dates.toInstant('2026-11-24T09:00'), '2026-11-24T03:30:00.000Z');
assert.equal(dates.localInput('2026-11-24T03:30:00Z'), '2026-11-24T09:00');
assert.equal(dates.addDays('2028-02-28', 1), '2028-02-29');
assert.equal(dates.addDays('2028-02-29', 1), '2028-03-01');
assert.equal(dates.shiftMonth('2026-01-31', 1), '2026-02-28');
assert.equal(dates.shiftMonth('2026-12-31', 1), '2027-01-31');
assert.throws(() => dates.parseDate('2026-02-29'));
assert.deepEqual(dates.range('2026-11-24', 'month'), { start: '2026-10-26', end: '2026-12-07' });
assert.deepEqual(dates.range('2026-11-24', 'week'), { start: '2026-11-23', end: '2026-11-30' });
assert.deepEqual(dates.range('2026-11-24', 'day'), { start: '2026-11-24', end: '2026-11-25' });
const allDay = { id: 'a', all_day: true, start_date: '2026-11-24', end_date: '2026-11-26' };
assert(dates.onDay(allDay, '2026-11-24'));
assert(dates.onDay(allDay, '2026-11-25'));
assert(!dates.onDay(allDay, '2026-11-26'));
const timed = { id: 'b', all_day: false, starts_at: '2026-11-24T18:00:00Z', ends_at: '2026-11-24T19:00:00Z' };
assert(dates.onDay(timed, '2026-11-24'));
assert(dates.onDay(timed, '2026-11-25'));
assert(dates.overlaps(allDay, timed));
const touching = { ...timed, id: 'c', starts_at: timed.ends_at, ends_at: '2026-11-24T20:00:00Z' };
assert(!dates.overlaps(timed, touching));
assert.equal(dates.sortEvents([timed, allDay])[0].id, 'a');

process.env.TZ = 'America/New_York';
assert.throws(() => dates.toInstant('2026-03-08T02:30'), /does not exist/);
assert.equal(dates.toInstant('2026-03-08T03:30'), '2026-03-08T07:30:00.000Z');
assert.equal(dates.addDays('2026-03-08', 1), '2026-03-09');
assert.equal(dates.parseDate('2026-03-09') - dates.parseDate('2026-03-08'), 23 * 3600000);
assert.equal(dates.parseDate('2026-11-02') - dates.parseDate('2026-11-01'), 25 * 3600000);
assert(dates.onDay(allDay, '2026-11-24'), 'all-day dates do not shift when timezone changes');

console.log('PASS calendar local dates, UTC conversion, leap days, month navigation, exclusive ends, overlaps, and DST');
