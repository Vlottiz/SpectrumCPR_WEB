'use strict';

/**
 * The travel-booking calendar: slot grid, the 2.5 hour block each booking
 * takes, day headcount caps, addresses and alternative-day suggestions.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP = path.join(__dirname, 'tmp-slots.db');
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.DB_PATH = TMP;
// The shipped defaults: a 4 hour session plus 90 minutes to set up, pack down
// and drive, so each booking owns 5.5 hours of the calendar.
process.env.SESSION_MINUTES = '240';
process.env.BUFFER_MINUTES = '90';
process.env.SLOT_STEP_MINUTES = '30';

const { getDb, closeDb } = require('../src/db');
const seats = require('../src/seats');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  \u2713 ${label}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${label}\n      ${err.message}`);
    failed++;
  }
}

/** A working day, given as UTC hours so the assertions read plainly. */
// Each test day gets its own date unless a test asks otherwise: one
// instructor means days sharing a date share her time.
let nextOffset = 7;
function makeDay({ openHour = 16, closeHour = 26, capacity = 20, price = 8500,
                   code = 'BLS', title = 'BLS Provider', dayOffset = null } = {}) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + (dayOffset ?? nextOffset++));
  d.setUTCHours(0, 0, 0, 0);
  const open = new Date(d.getTime() + openHour * 3600_000).toISOString();
  const close = new Date(d.getTime() + closeHour * 3600_000).toISOString();

  const info = getDb()
    .prepare(
      `INSERT INTO classes (course_code, title, starts_at, ends_at, location, capacity, price_cents)
       VALUES (?, ?, ?, ?, '', ?, ?)`
    )
    .run(code, title, open, close, capacity, price);
  return { id: Number(info.lastInsertRowid), open, close };
}

const at = (day, hours) =>
  new Date(new Date(day.open).getTime() + hours * 3600_000).toISOString();

const ADDRESS = '1200 SW Main St, Hillsboro, OR 97123';
const book = (day, slotStart, people = ['A Person'], extra = {}) =>
  seats.holdSeats({
    classId: day.id, attendees: people, email: 'org@example.com',
    slotStart, address: ADDRESS, ...extra,
  });

console.log('\nthe slot grid');

test('a ten hour day offers half-hour starts', () => {
  const day = makeDay();                       // 10 hours open, 4 hour sessions
  const grid = seats.slotGrid(seats.getClass(day.id));
  // Last start must let the session finish by closing: 8am..2pm inclusive.
  assert.strictEqual(grid.length, 13, `got ${grid.length}`);
  assert.strictEqual(grid[0], day.open);
});

test('no start is offered that would run past closing', () => {
  const day = makeDay();
  const grid = seats.slotGrid(seats.getClass(day.id));
  const last = new Date(grid[grid.length - 1]).getTime();
  assert.strictEqual(last + 240 * 60_000, new Date(day.close).getTime());
});

test('a short day offers fewer slots', () => {
  const day = makeDay({ openHour: 16, closeHour: 21 });   // five hours
  const grid = seats.slotGrid(seats.getClass(day.id));
  assert.strictEqual(grid.length, 3, `got ${grid.length}`);   // 0:00, 0:30, 1:00
});

test('a day shorter than one session offers nothing', () => {
  const day = makeDay({ openHour: 16, closeHour: 19 });   // three hours
  assert.strictEqual(seats.slotGrid(seats.getClass(day.id)).length, 0);
});

console.log('\nthe 5.5 hour block');

test('a booking blocks its own slot', () => {
  const day = makeDay();
  assert.strictEqual(book(day, at(day, 0)).ok, true);
  const slots = seats.daySlots(day.id).slots;
  assert.strictEqual(slots.find((s) => s.start === at(day, 0)).available, false);
});

test('it blocks the next five hours as well', () => {
  const day = makeDay();
  book(day, at(day, 0));
  const slots = seats.daySlots(day.id).slots;
  for (const h of [0.5, 1, 2, 3, 4, 5]) {
    assert.strictEqual(slots.find((s) => s.start === at(day, h)).available, false,
      `${h}h after should be blocked`);
  }
});

test('the slot exactly 5.5 hours later is free', () => {
  const day = makeDay();
  book(day, at(day, 0));
  const slots = seats.daySlots(day.id).slots;
  assert.strictEqual(slots.find((s) => s.start === at(day, 5.5)).available, true,
    'booking at 8am should leave 1:30pm open');
});

test('an earlier slot that would run into a booking is blocked', () => {
  const day = makeDay();
  book(day, at(day, 5.5));                     // 1:30pm
  const slots = seats.daySlots(day.id).slots;
  assert.strictEqual(slots.find((s) => s.start === at(day, 5)).available, false,
    '1pm would still be on site at 1:30pm');
  assert.strictEqual(slots.find((s) => s.start === at(day, 0)).available, true,
    '8am finishes and travels in time');
});

test('booking the exact boundary slot is allowed', () => {
  const day = makeDay();
  book(day, at(day, 0));
  assert.strictEqual(book(day, at(day, 5.5), ['Second Party']).ok, true);
});

test('two bookings cannot share a time', () => {
  const day = makeDay();
  book(day, at(day, 0));
  const clash = book(day, at(day, 0), ['Second Party']);
  assert.strictEqual(clash.ok, false);
  assert.strictEqual(clash.reason, 'slot_taken');
});

test('a booking inside another booking is refused', () => {
  const day = makeDay();
  book(day, at(day, 0));
  const clash = book(day, at(day, 1), ['Second Party']);
  assert.strictEqual(clash.ok, false);
  assert.strictEqual(clash.reason, 'slot_taken');
});

test('two bookings fill a ten hour day', () => {
  // 4 hours on site plus 90 minutes to move on leaves room for exactly two
  // visits between 8am and 6pm.
  const day = makeDay({ capacity: 40 });
  for (const h of [0, 5.5]) {
    assert.strictEqual(book(day, at(day, h), [`Party ${h}`]).ok, true, `${h}h failed`);
  }
  assert.strictEqual(seats.daySlots(day.id).availableSlots, 0);
});

test('a longer day fits a third booking', () => {
  const day = makeDay({ openHour: 14, closeHour: 32, capacity: 40 });   // 18 hours
  for (const h of [0, 5.5, 11]) {
    assert.strictEqual(book(day, at(day, h), [`Party ${h}`]).ok, true, `${h}h failed`);
  }
});

console.log('\ntimes off the grid');

test('a start between grid points is refused', () => {
  const day = makeDay();
  const offGrid = new Date(new Date(day.open).getTime() + 15 * 60_000).toISOString();
  const r = book(day, offGrid);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'slot_not_offered');
});

test('a start after closing is refused', () => {
  const day = makeDay();
  const r = book(day, at(day, 9));            // would finish an hour late
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'slot_not_offered');
});

test('a booking with no time is refused', () => {
  const day = makeDay();
  const r = seats.holdSeats({
    classId: day.id, attendees: ['A'], email: 'a@b.com', address: ADDRESS,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'slot_required');
});

test('a day already past offers nothing bookable', () => {
  const day = makeDay({ dayOffset: -3 });
  const d = seats.daySlots(day.id);
  assert.strictEqual(d.availableSlots, 0);
  assert.ok(d.slots.every((s) => s.reason === 'past'));
});

console.log('\naddresses');

test('the instructor needs somewhere to go', () => {
  const day = makeDay();
  const r = seats.holdSeats({
    classId: day.id, attendees: ['A'], email: 'a@b.com', slotStart: at(day, 0),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'address_required');
});

test('the address is stored on every seat of a group', () => {
  const day = makeDay();
  const r = book(day, at(day, 0), ['Ana', 'Ben', 'Cara']);
  assert.strictEqual(r.address, ADDRESS);
  assert.ok(r.registrations.every((x) => x.address === ADDRESS));
});

test('access notes ride along', () => {
  const day = makeDay();
  const r = book(day, at(day, 0), ['Ana'], { addressNotes: 'Gate code 4417, park at rear' });
  assert.ok(r.registrations[0].address_notes.includes('4417'));
});

test('the roster carries the time and address', () => {
  const day = makeDay();
  book(day, at(day, 5.5), ['Ana', 'Ben']);
  const rows = seats.roster(day.id);
  assert.strictEqual(rows[0].slot_start, at(day, 5.5));
  assert.strictEqual(rows[0].address, ADDRESS);
});

console.log('\nthe day headcount cap');

test('party size draws down the day capacity', () => {
  const day = makeDay({ capacity: 10 });
  book(day, at(day, 0), ['A', 'B', 'C', 'D']);
  assert.strictEqual(seats.daySlots(day.id).seatsLeft, 6);
});

test('a party larger than the remaining headcount is refused', () => {
  const day = makeDay({ capacity: 6 });
  book(day, at(day, 0), ['A', 'B', 'C', 'D']);
  const big = book(day, at(day, 5.5), ['E', 'F', 'G']);
  assert.strictEqual(big.ok, false);
  assert.strictEqual(big.reason, 'not_enough_seats');
  assert.strictEqual(big.available, 2);
});

test('slots hide themselves from a party that cannot fit', () => {
  const day = makeDay({ capacity: 6 });
  book(day, at(day, 0), ['A', 'B', 'C', 'D']);

  const forPair = seats.daySlots(day.id, { partySize: 2 });
  const forSix = seats.daySlots(day.id, { partySize: 6 });

  assert.ok(forPair.availableSlots > 0, 'a pair still fits');
  assert.strictEqual(forSix.availableSlots, 0, 'six do not');
  assert.ok(forSix.slots.some((s) => s.reason === 'not_enough_seats'));
});

test('a full day reports no seats left', () => {
  const day = makeDay({ capacity: 4 });
  book(day, at(day, 0), ['A', 'B', 'C', 'D']);
  const d = seats.daySlots(day.id);
  assert.strictEqual(d.seatsLeft, 0);
  assert.ok(d.slots.filter((s) => s.reason === 'day_full').length > 0);
});

console.log('\nreleasing time');

test('cancelling frees the slot again', () => {
  const day = makeDay();
  const r = book(day, at(day, 0), ['Ana', 'Ben']);
  assert.strictEqual(seats.daySlots(day.id).slots[0].available, false);

  seats.cancelGroup(r.groupRef);
  assert.strictEqual(seats.daySlots(day.id).slots[0].available, true);
});

test('an expired hold frees the slot', () => {
  const day = makeDay();
  const r = book(day, at(day, 0));
  getDb()
    .prepare(`UPDATE registrations SET hold_expires_at = ? WHERE public_ref = ?`)
    .run(new Date(Date.now() - 1000).toISOString(), r.registration.public_ref);
  assert.strictEqual(seats.daySlots(day.id).slots[0].available, true);
});

test('a confirmed booking keeps its slot', () => {
  const day = makeDay();
  const r = book(day, at(day, 0));
  seats.confirmPayment({
    publicRef: r.registration.public_ref, provider: 'mock', paymentRef: 'TXN_SLOT',
  });
  assert.strictEqual(seats.daySlots(day.id).slots[0].available, false);
});

console.log('\nsuggesting another day');

test('a booked-out day points at the next one', () => {
  // Its own course code, so days created by earlier tests — which are
  // genuinely sooner and would rightly be suggested first — stay out of it.
  const a = makeDay({ dayOffset: 10, capacity: 2, code: 'ALT_TEST' });
  const b = makeDay({ dayOffset: 11, capacity: 20, code: 'ALT_TEST' });
  book(a, at(a, 0), ['One', 'Two']);          // day A now headcount-full

  const alts = seats.suggestAlternatives({ classId: a.id, partySize: 2 });
  assert.strictEqual(alts.length, 1, 'only day B qualifies');
  assert.strictEqual(alts[0].classId, b.id);
});

test('the soonest suitable day comes first', () => {
  const full = makeDay({ dayOffset: 50, capacity: 1, code: 'ORDER_TEST' });
  const later = makeDay({ dayOffset: 60, code: 'ORDER_TEST' });
  const sooner = makeDay({ dayOffset: 55, code: 'ORDER_TEST' });
  book(full, at(full, 0), ['Taken']);

  const alts = seats.suggestAlternatives({ classId: full.id, partySize: 1 });
  assert.strictEqual(alts[0].classId, sooner.id);
  assert.strictEqual(alts[1].classId, later.id);
});

test('a day offering the wanted time is preferred', () => {
  const a = makeDay({ dayOffset: 20, capacity: 2, code: 'FIRSTAID' });
  const early = makeDay({ dayOffset: 21, openHour: 20, closeHour: 26, code: 'FIRSTAID' });
  const matching = makeDay({ dayOffset: 22, openHour: 16, closeHour: 26, code: 'FIRSTAID' });
  book(a, at(a, 0), ['One', 'Two']);

  const wanted = new Date(a.open).toISOString().slice(11, 16);
  const alts = seats.suggestAlternatives({ classId: a.id, partySize: 2, preferredTime: wanted });

  assert.strictEqual(alts[0].classId, matching.id,
    'the day that can do that hour should come first, even though it is later');
  assert.strictEqual(alts[0].matchesPreferredTime, true);
  assert.ok(alts.some((x) => x.classId === early.id));
});

test('only the same course is suggested', () => {
  const a = makeDay({ dayOffset: 30, capacity: 1, code: 'PEDIATRIC' });
  makeDay({ dayOffset: 31, code: 'BABYSIT' });
  book(a, at(a, 0), ['Only One']);

  const alts = seats.suggestAlternatives({ classId: a.id, partySize: 1 });
  assert.ok(alts.every((x) => x.courseCode === 'PEDIATRIC'));
});

test('a day that cannot fit the party is not suggested', () => {
  const a = makeDay({ dayOffset: 40, capacity: 1, code: 'HEARTSAVER' });
  makeDay({ dayOffset: 41, capacity: 2, code: 'HEARTSAVER' });
  book(a, at(a, 0), ['Only One']);

  const alts = seats.suggestAlternatives({ classId: a.id, partySize: 5 });
  assert.strictEqual(alts.length, 0, 'no day has room for five');
});

console.log('\nwaitlist');

test('a waitlist entry keeps the time they wanted', () => {
  const day = makeDay({ capacity: 1 });
  book(day, at(day, 0), ['Taken']);
  const w = seats.joinWaitlist({
    classId: day.id, name: 'Hopeful', email: 'h@d.com',
    preferredTime: '09:00', partySize: 3,
  });
  assert.strictEqual(w.ok, true);
  assert.ok(w.registration.notes.includes('09:00'));
  assert.ok(w.registration.notes.includes('party of 3'));
});

console.log('\nnot wasting the day');

// A visit holds the trainer for 4h + 1.5h travel = 5.5h. Times are UTC hours
// after the day's midnight, as makeDay takes them.
const openStarts = (day) => seats.daySlots(day.id).slots.filter((x) => x.available).map((x) => x.start);
const h = (day, hours) => at(day, hours - 16);   // openHour 16 is the day's first start

test('a 13 hour day hides the mid-day starts that would leave room for only one visit', () => {
  const day = makeDay({ openHour: 16, closeHour: 29 });   // 13 hours, last start at +9h
  const starts = openStarts(day);
  // 2 visits fit: one starting by +3.5h and one from +5.5h.
  assert.ok(starts.includes(h(day, 16)) && starts.includes(h(day, 19.5)), 'early starts offered');
  assert.ok(starts.includes(h(day, 21.5)) && starts.includes(h(day, 25)), 'late starts offered');
  for (const mid of [20, 20.5, 21]) assert.ok(!starts.includes(h(day, mid)), `+${mid - 16}h hidden`);
});

test('and a booking at one of those times is refused', () => {
  const day = makeDay({ openHour: 16, closeHour: 29 });
  assert.strictEqual(book(day, h(day, 21)).reason, 'slot_taken');
  assert.strictEqual(seats.availability(day.id).taken, 0);
});

test('after an early booking, the later visit still fits', () => {
  const day = makeDay({ openHour: 16, closeHour: 29 });
  assert.strictEqual(book(day, h(day, 17)).ok, true);
  const starts = openStarts(day);
  assert.ok(starts.length > 0, 'room for a second visit');
  assert.ok(starts.every((x) => x >= h(day, 22.5)), 'only after the first visit and its travel');
});

test('a day that only fits one visit offers every time', () => {
  const day = makeDay({ openHour: 16, closeHour: 24 });   // 8 hours
  assert.strictEqual(openStarts(day).length, seats.slotGrid(seats.getClass(day.id)).length);
});

test('with two trainers, a second visit can take the same early time', () => {
  const day = makeDay({ openHour: 16, closeHour: 29 });
  seats.setTrainers([seats.localDate(day.open)], 2);
  assert.strictEqual(book(day, h(day, 16)).ok, true);
  assert.ok(openStarts(day).includes(h(day, 16)), 'the other trainer is free at the same time');
  assert.ok(!openStarts(day).includes(h(day, 20.5)), 'mid-day still wastes a trainer');
  seats.setTrainers([seats.localDate(day.open)], null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);

closeDb();
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
  // Windows won't unlink a file another handle still holds. Leaving a temp
  // file behind is harmless; failing the run over it is not.
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch { /* the OS will clear it */ }
}
process.exit(failed === 0 ? 0 : 1);
