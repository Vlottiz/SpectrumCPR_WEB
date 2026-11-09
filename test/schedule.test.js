'use strict';

/**
 * Repeating schedules, time off, minimum notice, and one instructor's time
 * being shared across every course on a date.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP = path.join(__dirname, 'tmp-schedule.db');
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.DB_PATH = TMP;

const { getDb, closeDb } = require('../src/db');
const seats = require('../src/seats');
const schedule = require('../src/schedule');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${label}\n      ${err.message}`);
    failed++;
  }
}

const COURSES = [
  { code: 'CPR', title: 'CPR / AED', priceCents: 8500 },
  { code: 'HEARTSAVER', title: 'Heartsaver CPR / AED / First Aid', priceCents: 9500 },
];
const WEEKDAYS_9_TO_5 = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
  on: d >= 1 && d <= 5, open: '09:00', close: '17:00',
}));

const today = seats.localDate(new Date().toISOString());
const ADDRESS = '1200 SW Main St, Hillsboro, OR 97123';

function make(overrides = {}) {
  const v = schedule.cleanSchedule({
    courses: COURSES, week: WEEKDAYS_9_TO_5, weeksAhead: 2, capacity: 10,
    startsOn: today, ...overrides,
  }, { sessionMinutes: seats.SESSION_MINUTES });
  assert.ok(v.value, v.error);
  return schedule.createSchedule(v.value);
}

const daysOf = (id) => getDb()
  .prepare('SELECT * FROM classes WHERE schedule_id = ? ORDER BY starts_at, course_code').all(id);
// Days that open after tomorrow, so every time on them is still bookable.
const laterDays = (id) => daysOf(id)
  .filter((c) => c.starts_at > new Date(Date.now() + 86400_000).toISOString());

/** Open weekdays from today through the horizon, as the fill should see them. */
function expectedDates(weeks, week = WEEKDAYS_9_TO_5) {
  const out = [];
  const now = new Date().toISOString();
  for (let d = today; d <= schedule.addDays(today, weeks * 7 - 1); d = schedule.addDays(d, 1)) {
    if (!week[schedule.weekday(d)].on) continue;
    if (schedule.zonedToUtc(d, week[schedule.weekday(d)].close) <= now) continue;
    out.push(d);
  }
  return out;
}

function clearAll() {
  const db = getDb();
  for (const t of ['registrations', 'classes', 'schedules', 'schedule_skips', 'time_off', 'settings']) {
    db.exec(`DELETE FROM ${t}`);
  }
}

const book = (cls, slot = 0, extra = {}) => seats.holdSeats({
  classId: cls.id, attendees: ['Ana Reyes'], email: 'a@b.com',
  slotStart: seats.slotGrid(cls)[slot], address: ADDRESS, zip: '97123', ...extra,
});

// Bookings in most tests are days out, so notice doesn't get in the way.
seats.setSetting('min_notice_hours', 0);

console.log('\nlocal times');

test('9:00 Pacific is 17:00 UTC in winter', () => {
  assert.strictEqual(schedule.zonedToUtc('2027-01-12', '09:00'), '2027-01-12T17:00:00.000Z');
});

test('and 16:00 UTC in summer', () => {
  assert.strictEqual(schedule.zonedToUtc('2027-07-12', '09:00'), '2027-07-12T16:00:00.000Z');
});

test('the day clocks go forward still opens at 9:00 local', () => {
  assert.strictEqual(schedule.zonedToUtc('2027-03-14', '09:00'), '2027-03-14T16:00:00.000Z');
  assert.strictEqual(schedule.zonedToUtc('2027-03-13', '09:00'), '2027-03-13T17:00:00.000Z');
});

console.log('\na repeating schedule');

test('it creates a day per course per open date', () => {
  clearAll();
  const { id, created } = make();
  const dates = expectedDates(2);
  assert.strictEqual(created, dates.length * 2);
  assert.strictEqual(daysOf(id).length, dates.length * 2);
});

test('only on the ticked weekdays', () => {
  clearAll();
  const { id } = make();
  const weekdays = new Set(daysOf(id).map((c) => schedule.weekday(seats.localDate(c.starts_at))));
  assert.ok(!weekdays.has(0) && !weekdays.has(6), [...weekdays].join(','));
});

test('with the hours in local time and each course\'s own price', () => {
  clearAll();
  const { id } = make();
  const cpr = daysOf(id).find((c) => c.course_code === 'CPR');
  const hs = daysOf(id).find((c) => c.course_code === 'HEARTSAVER');
  const ymd = seats.localDate(cpr.starts_at);
  assert.strictEqual(cpr.starts_at, schedule.zonedToUtc(ymd, '09:00'));
  assert.strictEqual(cpr.ends_at, schedule.zonedToUtc(ymd, '17:00'));
  assert.strictEqual(cpr.price_cents, 8500);
  assert.strictEqual(hs.price_cents, 9500);
});

test('filling again makes nothing twice', () => {
  clearAll();
  const { id } = make();
  const before = daysOf(id).length;
  assert.strictEqual(schedule.fillSchedules(), 0);
  getDb().prepare('UPDATE schedules SET filled_through = NULL').run();
  assert.strictEqual(schedule.fillSchedules(), 0);
  assert.strictEqual(daysOf(id).length, before);
});

test('as time passes it keeps the same number of weeks open', () => {
  clearAll();
  const { id } = make();
  const before = daysOf(id).length;
  const nextWeek = new Date(Date.now() + 7 * 86400_000).toISOString();
  const added = schedule.fillSchedule(id, nextWeek);
  assert.strictEqual(added, 5 * 2, 'one more week of Mon-Fri, two courses');
  assert.strictEqual(daysOf(id).length, before + 10);
});

test('a paused schedule adds nothing', () => {
  clearAll();
  const { id } = make();
  schedule.setScheduleActive(id, false);
  const nextWeek = new Date(Date.now() + 7 * 86400_000).toISOString();
  assert.strictEqual(schedule.fillSchedule(id, nextWeek), 0);
});

test('a cancelled and cleared day is not put back', () => {
  clearAll();
  const { id } = make();
  const victim = daysOf(id)[2];
  getDb().prepare(`UPDATE classes SET status = 'cancelled' WHERE id = ?`).run(victim.id);
  seats.purgeEmptyCancelledDays();
  getDb().prepare('UPDATE schedules SET filled_through = NULL').run();
  schedule.fillSchedules();
  const back = daysOf(id).filter((c) =>
    c.course_code === victim.course_code && c.starts_at === victim.starts_at);
  assert.strictEqual(back.length, 0);
});

test('changing it rebuilds unbooked days and keeps booked ones', () => {
  clearAll();
  const { id } = make();
  const bookedDay = laterDays(id).find((c) => c.course_code === 'CPR');
  assert.strictEqual(book(bookedDay).ok, true);

  const v = schedule.cleanSchedule({
    courses: COURSES,
    week: WEEKDAYS_9_TO_5.map((d) => ({ ...d, open: '10:00', close: '18:00' })),
    weeksAhead: 2, capacity: 10, startsOn: today,
  }, { sessionMinutes: seats.SESSION_MINUTES });
  schedule.updateSchedule(id, v.value);

  const cpr = daysOf(id).filter((c) => c.course_code === 'CPR');
  const kept = cpr.find((c) => c.id === bookedDay.id);
  assert.ok(kept, 'the booked day survives');
  assert.strictEqual(kept.starts_at, bookedDay.starts_at, 'with the hours it was booked for');
  const rebuilt = cpr.filter((c) => c.id !== bookedDay.id && c.starts_at > new Date().toISOString());
  assert.ok(rebuilt.length && rebuilt.every((c) =>
    c.starts_at === schedule.zonedToUtc(seats.localDate(c.starts_at), '10:00')));
});

console.log('\none price per course');

test('a schedule ignores a price sent with it', () => {
  clearAll();
  const { id } = make({ courses: [{ ...COURSES[0], priceCents: 1 }] });
  assert.ok(daysOf(id).every((c) => c.price_cents === seats.coursePrice('CPR')));
});

test('changing a course price moves every upcoming day at once', () => {
  clearAll();
  const { id } = make();
  const bookedDay = laterDays(id).find((c) => c.course_code === 'CPR');
  const r = book(bookedDay);
  const paid = r.registration.amount_cents;

  const out = seats.setCoursePrice('CPR', 9900);
  assert.ok(out.daysUpdated > 0);
  const cpr = daysOf(id).filter((c) => c.course_code === 'CPR' && c.ends_at > new Date().toISOString());
  assert.ok(cpr.every((c) => c.price_cents === 9900), 'every week matches');
  assert.ok(daysOf(id).filter((c) => c.course_code === 'HEARTSAVER').every((c) => c.price_cents === 9500),
    'other courses untouched');
  assert.strictEqual(seats.findByRef(r.registration.public_ref).amount_cents, paid,
    'a booking keeps what it was charged');
});

test('new days use the current price', () => {
  const nextWeek = new Date(Date.now() + 7 * 86400_000).toISOString();
  schedule.fillSchedule(schedule.listSchedules()[0].id, nextWeek);
  const id = schedule.listSchedules()[0].id;
  assert.ok(daysOf(id).filter((c) => c.course_code === 'CPR').every((c) => c.price_cents === 9900));
  seats.setCoursePrice('CPR', 8500);
});

test('deleting it removes its unbooked future days', () => {
  clearAll();
  const { id } = make();
  const bookedDay = laterDays(id)[0];
  assert.strictEqual(book(bookedDay).ok, true);
  schedule.deleteSchedule(id);
  const left = getDb().prepare('SELECT * FROM classes').all();
  assert.deepStrictEqual(left.map((c) => c.id), [bookedDay.id]);
  assert.strictEqual(left[0].schedule_id, null);
});

test('a bad schedule is explained', () => {
  const v = schedule.cleanSchedule({
    courses: COURSES, weeksAhead: 2, capacity: 10,
    week: WEEKDAYS_9_TO_5.map((d, i) => (i === 3 ? { on: true, open: '09:00', close: '10:00' } : d)),
  }, { sessionMinutes: 240 });
  assert.ok(/Wed: open at least 4 hours/.test(v.error), v.error);
  assert.ok(schedule.cleanSchedule({ courses: [], week: WEEKDAYS_9_TO_5, weeksAhead: 2, capacity: 1 },
    { sessionMinutes: 240 }).error.includes('course'));
});

console.log('\ntime off');

test('time off removes unbooked days and keeps booked ones', () => {
  clearAll();
  const { id } = make({ weeksAhead: 3 });
  const dates = [...new Set(laterDays(id).map((c) => seats.localDate(c.starts_at)))];
  const [from, to] = [dates[2], dates[4]];
  const bookedDay = daysOf(id).find((c) => seats.localDate(c.starts_at) === dates[3]);
  assert.strictEqual(book(bookedDay).ok, true);

  const r = schedule.addTimeOff({ startsOn: from, endsOn: to, note: 'Vacation' });
  assert.deepStrictEqual(r.kept.map((k) => k.id), [bookedDay.id]);
  const inside = daysOf(id).filter((c) => {
    const d = seats.localDate(c.starts_at);
    return d >= from && d <= to;
  });
  assert.deepStrictEqual(inside.map((c) => c.id), [bookedDay.id]);
});

test('a booked day inside time off takes no new bookings', () => {
  const kept = daysOf(schedule.listSchedules()[0].id)
    .find((c) => seats.isTimeOff(seats.localDate(c.starts_at)));
  const slots = seats.daySlots(kept.id);
  assert.strictEqual(slots.availableSlots, 0);
  assert.ok(slots.slots.some((s) => s.reason === 'time_off'));
  assert.strictEqual(book(seats.getClass(kept.id), 8).reason, 'day_off');
});

test('schedules skip time off as they fill', () => {
  clearAll();
  const far = schedule.addDays(today, 14);
  schedule.addTimeOff({ startsOn: far, endsOn: schedule.addDays(far, 6) });
  const { id } = make({ weeksAhead: 4 });
  assert.ok(!daysOf(id).some((c) => seats.isTimeOff(seats.localDate(c.starts_at))));
});

test('lifting time off puts the days back', () => {
  const id = schedule.listSchedules()[0].id;
  const before = daysOf(id).length;
  schedule.removeTimeOff(schedule.listTimeOff()[0].id);
  assert.strictEqual(daysOf(id).length, before + 10, 'a week of Mon-Fri, two courses');
});

console.log('\none instructor, every course');

test('a CPR booking blocks Heartsaver at the same time that day', () => {
  clearAll();
  const { id } = make();
  const future = laterDays(id);
  const cpr = future.find((c) => c.course_code === 'CPR');
  const hs = future.find((c) => c.course_code === 'HEARTSAVER' && c.starts_at === cpr.starts_at);
  assert.strictEqual(book(cpr, 0).ok, true);
  assert.strictEqual(book(hs, 0).reason, 'slot_taken');
  assert.ok(seats.daySlots(hs.id).slots[0].reason === 'booked');
});

test('but the headcount stays each course\'s own', () => {
  const id = schedule.listSchedules()[0].id;
  const future = laterDays(id);
  const cpr = future.find((c) => c.course_code === 'CPR');
  const hs = future.find((c) => c.course_code === 'HEARTSAVER' && c.starts_at === cpr.starts_at);
  assert.strictEqual(seats.daySlots(hs.id).seatsLeft, 10);
  assert.strictEqual(seats.daySlots(cpr.id).seatsLeft, 9);
});

test('a different date is unaffected', () => {
  const id = schedule.listSchedules()[0].id;
  const future = laterDays(id);
  const first = seats.localDate(future[0].starts_at);
  const other = future.find((c) => c.course_code === 'HEARTSAVER' && seats.localDate(c.starts_at) !== first);
  assert.strictEqual(book(other, 0).ok, true);
});

console.log('\ntrainers');

test('one trainer: overlapping visits are refused', () => {
  clearAll();
  const { id } = make();
  const cpr = laterDays(id).find((c) => c.course_code === 'CPR');
  assert.strictEqual(book(cpr, 0).ok, true);
  assert.strictEqual(book(cpr, 2).reason, 'slot_taken');
});

test('two trainers: two visits can run at once', () => {
  const id = schedule.listSchedules()[0].id;
  const cpr = laterDays(id).find((c) => c.course_code === 'CPR');
  const hs = laterDays(id).find((c) => c.course_code === 'HEARTSAVER' && c.starts_at === cpr.starts_at);
  const day = seats.localDate(cpr.starts_at);
  assert.deepStrictEqual(seats.setTrainers([day], 2), []);
  assert.strictEqual(seats.trainersOn(day), 2);
  assert.strictEqual(book(hs, 0).ok, true, 'a second trainer takes the same time');
  assert.strictEqual(book(cpr, 1).reason, 'slot_taken', 'but not a third');
  assert.strictEqual(seats.daySlots(cpr.id).trainers, 2);
});

test('two trainers: each later start is checked against both', () => {
  clearAll();
  const { id } = make();
  const cpr = laterDays(id).find((c) => c.course_code === 'CPR');
  seats.setTrainers([seats.localDate(cpr.starts_at)], 2);
  assert.strictEqual(book(cpr, 0).ok, true);                 // 9:00, trainer A
  const grid = seats.slotGrid(cpr);
  const at = (i) => seats.daySlots(cpr.id).slots.find((s) => s.start === grid[i]);
  assert.strictEqual(at(8).available, true, '1:00 still has trainer B');
  assert.strictEqual(book(cpr, 8).ok, true);                 // 1:00, trainer B
  assert.ok(seats.daySlots(cpr.id).slots.every((s) => !s.available),
    'both trainers are now busy at every start that day');
});

test('cutting trainers below what is booked is reported', () => {
  const id = schedule.listSchedules()[0].id;
  const cpr = laterDays(id).find((c) => c.course_code === 'CPR');
  const day = seats.localDate(cpr.starts_at);
  const over = seats.setTrainers([day], 1);
  assert.strictEqual(over.length, 1);
  assert.strictEqual(over[0].mostAtOnce, 2);
  assert.strictEqual(over[0].trainers, 1);
});

test('0 trainers (a call-out) takes no new bookings that day', () => {
  clearAll();
  const { id } = make();
  const cpr = laterDays(id).find((c) => c.course_code === 'CPR');
  seats.setTrainers([seats.localDate(cpr.starts_at)], 0);
  const slots = seats.daySlots(cpr.id);
  assert.strictEqual(slots.availableSlots, 0);
  assert.ok(slots.slots.some((s) => s.reason === 'no_trainer'));
  assert.strictEqual(book(cpr, 0).reason, 'slot_taken');
});

test('null puts a date back to the usual number', () => {
  const id = schedule.listSchedules()[0].id;
  const day = seats.localDate(laterDays(id)[0].starts_at);
  seats.setTrainers([day], null);
  assert.strictEqual(seats.trainersOn(day), 1);
});

test('the usual number can be raised for every day', () => {
  seats.setSetting('default_trainers', 3);
  assert.strictEqual(seats.trainersOn('2030-01-01'), 3);
  seats.setSetting('default_trainers', 1);
});

console.log('\ntravel time between visits');

/** A one-off CPR day on a far-off date, hours in local time. */
function oneDay(ymd, open, close) {
  const info = getDb().prepare(
    `INSERT INTO classes (course_code, title, starts_at, ends_at, location, capacity, price_cents)
     VALUES ('CPR', 'CPR / AED', ?, ?, '', 20, 8500)`)
    .run(schedule.zonedToUtc(ymd, open), schedule.zonedToUtc(ymd, close));
  return seats.getClass(Number(info.lastInsertRowid));
}
const localTime = (iso) => new Date(iso).toLocaleTimeString('en-US',
  { timeZone: seats.BUSINESS_TZ, hour: 'numeric', minute: '2-digit' });
const openTimes = (cls) => seats.daySlots(cls.id).slots.filter((x) => x.available).map((x) => localTime(x.start));

test('travel defaults to one hour', () => {
  clearAll();
  assert.strictEqual(seats.bufferMinutes(), 60);
});

test('8am-9pm with a 1pm visit still fits an 8am one: class 8-12, drive 12-1', () => {
  clearAll();
  const cls = oneDay('2027-06-07', '08:00', '21:00');
  const one = seats.slotGrid(cls).find((t) => localTime(t) === '1:00 PM');
  getDb().prepare(`INSERT INTO registrations (public_ref, class_id, status, student_name, student_email,
      amount_cents, slot_start, address) VALUES ('SPC-TEST01', ?, 'confirmed', 'Billy', 'b@x.com', 10000, ?, 'x')`)
    .run(cls.id, one);
  assert.deepStrictEqual(openTimes(cls), ['8:00 AM']);
  assert.strictEqual(book(cls, 0).ok, true);
});

test('with 1.5 hours of travel the same day has no room left', () => {
  seats.setSetting('buffer_minutes', 90);
  const cls = getDb().prepare(`SELECT * FROM classes WHERE starts_at LIKE '2027-06-07%'`).get();
  getDb().prepare(`DELETE FROM registrations WHERE class_id = ? AND public_ref != 'SPC-TEST01'`).run(cls.id);
  assert.deepStrictEqual(openTimes(cls), []);
  seats.setSetting('buffer_minutes', 60);
});

test('an empty 8am-9pm day now fits two visits with more choice of time', () => {
  clearAll();
  const cls = oneDay('2027-06-08', '08:00', '21:00');
  const times = openTimes(cls);
  assert.ok(times.includes('8:00 AM') && times.includes('12:00 PM') && times.includes('5:00 PM'), times.join(' '));
});

console.log('\nminimum notice');

test('times inside the notice period are not offered', () => {
  clearAll();
  seats.setSetting('min_notice_hours', 24);
  const soon = new Date(Date.now() + 3 * 3600_000);
  soon.setUTCMinutes(0, 0, 0);
  const info = getDb().prepare(
    `INSERT INTO classes (course_code, title, starts_at, ends_at, location, capacity, price_cents)
     VALUES ('CPR', 'CPR / AED', ?, ?, '', 10, 8500)`)
    .run(soon.toISOString(), new Date(soon.getTime() + 10 * 3600_000).toISOString());
  const day = seats.daySlots(Number(info.lastInsertRowid));
  assert.strictEqual(day.availableSlots, 0);
  assert.ok(day.slots.every((s) => s.reason === 'too_soon' || s.reason === 'past'));
});

test('and a booking inside it is refused', () => {
  const cls = getDb().prepare('SELECT * FROM classes ORDER BY id DESC').get();
  const r = book(cls, 0);
  assert.strictEqual(r.reason, 'slot_too_soon');
  assert.strictEqual(r.noticeHours, 24);
});

test('setting the notice to 0 lets it through', () => {
  seats.setSetting('min_notice_hours', 0);
  const cls = getDb().prepare('SELECT * FROM classes ORDER BY id DESC').get();
  assert.ok(seats.daySlots(cls.id).availableSlots > 0);
});

test('without a setting it defaults to 24 hours', () => {
  getDb().prepare(`DELETE FROM settings WHERE key = 'min_notice_hours'`).run();
  const saved = process.env.MIN_NOTICE_HOURS;
  delete process.env.MIN_NOTICE_HOURS;
  assert.strictEqual(seats.minNoticeHours(), 24);
  if (saved !== undefined) process.env.MIN_NOTICE_HOURS = saved;
});

console.log(`\n${passed} passed, ${failed} failed\n`);

closeDb();
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch { /* the OS will clear it */ }
}
process.exit(failed === 0 ? 0 : 1);
