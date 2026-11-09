'use strict';

/**
 * Travel zones: which zone a ZIP is in, what the trip costs, and the
 * per-day limit on trips into each zone.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP = path.join(__dirname, 'tmp-zones.db');
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.DB_PATH = TMP;

const { getDb, closeDb } = require('../src/db');
const seats = require('../src/seats');
const zones = require('../src/zones');

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

// ZIPs at known distances from 97116 (Forest Grove).
const ZONE1 = '97113';   // Cornelius, ~8 miles
const ZONE1B = '97123';  // Hillsboro, ~13 miles
const ZONE2 = '97301';   // Salem, ~46 miles
const ZONE3 = '97031';   // Hood River, ~80 miles
const ZONE3B = '97368';  // Otis, on the coast
const FAR = '97401';     // Eugene, past 90 miles

let dayCounter = 0;
function makeDay({ limits = null, code = 'CPR', dayOffset = null, capacity = 20 } = {}) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + (dayOffset ?? (10 + dayCounter++ * 2)));
  d.setUTCHours(16, 0, 0, 0);
  const open = d.toISOString();
  const close = new Date(d.getTime() + 12 * 3600_000).toISOString();

  const info = getDb()
    .prepare(`INSERT INTO classes
                (course_code, title, starts_at, ends_at, location, capacity,
                 price_cents, zone_limits)
              VALUES (?, 'CPR / AED', ?, ?, '', ?, 8500, ?)`)
    .run(code, open, close, capacity, limits ? JSON.stringify(limits) : null);
  return { id: Number(info.lastInsertRowid), open, close };
}

// Bookings on one day must not overlap, so each takes its own slot.
const book = (day, zip, { slot = 0, people = ['Ana Reyes'] } = {}) =>
  seats.holdSeats({
    classId: day.id,
    attendees: people,
    email: 'a@b.com',
    slotStart: seats.slotGrid(seats.getClass(day.id))[slot],
    address: `1200 Main St, Somewhere, OR ${zip}`,
    zip,
  });

console.log('\nfinding the zone');

test('home is Zone 1 with no charge', () => {
  const z = zones.zoneForZip('97116');
  assert.strictEqual(z.zone, 1);
  assert.strictEqual(z.feeCents, 0);
  assert.strictEqual(z.miles, 0);
});

test('a nearby town is Zone 1', () => {
  assert.strictEqual(zones.zoneForZip(ZONE1).zone, 1);
});

test('Salem is Zone 2 at $50', () => {
  const z = zones.zoneForZip(ZONE2);
  assert.strictEqual(z.zone, 2);
  assert.strictEqual(z.feeCents, 5000);
  assert.ok(z.miles > 25 && z.miles <= 50, `${z.miles} miles`);
});

test('Hood River is Zone 3 at $100', () => {
  const z = zones.zoneForZip(ZONE3);
  assert.strictEqual(z.zone, 3);
  assert.strictEqual(z.feeCents, 10000);
  assert.ok(z.miles > 50 && z.miles <= 90, `${z.miles} miles`);
});

test('past 90 miles is outside the area', () => {
  const z = zones.zoneForZip(FAR);
  assert.strictEqual(z.ok, false);
  assert.strictEqual(z.reason, 'outside_area');
});

test('a ZIP across the country is outside the area', () => {
  assert.strictEqual(zones.zoneForZip('10001').reason, 'outside_area');
});

test('junk is not a ZIP', () => {
  assert.strictEqual(zones.zoneForZip('12').reason, 'zip_invalid');
  assert.strictEqual(zones.zoneForZip('').reason, 'zip_invalid');
});

test('a ZIP+4 uses its first five digits', () => {
  assert.strictEqual(zones.zoneForZip(`${ZONE2}-1234`).zone, 2);
});

test('the band edges follow 25 / 25.01 / 50 / 50.01 / 90', () => {
  assert.strictEqual(zones.zoneForMiles(25).zone, 1);
  assert.strictEqual(zones.zoneForMiles(25.01).zone, 2);
  assert.strictEqual(zones.zoneForMiles(50).zone, 2);
  assert.strictEqual(zones.zoneForMiles(50.01).zone, 3);
  assert.strictEqual(zones.zoneForMiles(90).zone, 3);
  assert.strictEqual(zones.zoneForMiles(90.01), null);
});

console.log('\ntravel charge on a booking');

test('a Zone 1 booking adds nothing', () => {
  const day = makeDay();
  const r = book(day, ZONE1);
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.travelCents, 0);
  assert.strictEqual(r.totalCents, r.seatsCents);
});

test('a Zone 2 booking adds $50 to the total', () => {
  const day = makeDay();
  const r = book(day, ZONE2);
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.travelCents, 5000);
  assert.strictEqual(r.totalCents, r.seatsCents + 5000);
  assert.strictEqual(r.travel.zone, 2);
});

test('a group pays the travel charge once, not per person', () => {
  const day = makeDay();
  const r = book(day, ZONE3, { people: ['A One', 'B Two', 'C Three'] });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.travelCents, 10000);
  assert.strictEqual(r.totalCents, r.seatsCents + 10000);
  const stored = r.registrations.map((x) => x.travel_cents);
  assert.deepStrictEqual(stored, [10000, 0, 0]);
  assert.ok(r.registrations.every((x) => x.travel_zone === 3));
});

test('the stored booking totals include the trip', () => {
  const day = makeDay();
  const r = book(day, ZONE2, { people: ['A One', 'B Two'] });
  const totals = seats.bookingTotals(r.registration);
  assert.strictEqual(totals.travelCents, 5000);
  assert.strictEqual(totals.totalCents, r.totalCents);
});

test('an address outside the area is refused and holds nothing', () => {
  const day = makeDay();
  const r = book(day, FAR);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'outside_service_area');
  assert.strictEqual(seats.availability(day.id).taken, 0);
});

test('a booking with no ZIP at all is refused', () => {
  const day = makeDay();
  const r = seats.holdSeats({
    classId: day.id, attendees: ['Ana'], email: 'a@b.com',
    slotStart: day.open, address: '1200 SW Main St, Hillsboro OR',
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'zip_required');
});

test('a ZIP at the end of the address is used when none is sent', () => {
  const day = makeDay();
  const r = seats.holdSeats({
    classId: day.id, attendees: ['Ana'], email: 'a@b.com',
    slotStart: day.open, address: `1200 Main St, Salem, OR ${ZONE2}`,
  });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.travel.zone, 2);
});

console.log('\ntrips per zone per day');

test('a day with no limits takes any number of trips', () => {
  const day = makeDay();
  assert.strictEqual(book(day, ZONE3, { slot: 0 }).ok, true);
  assert.strictEqual(book(day, ZONE3B, { slot: 11 }).ok, true);
  assert.strictEqual(seats.zoneTripsLeft(day.id, 3).left, null);
});

test('one Zone 3 trip a day refuses the second', () => {
  const day = makeDay({ limits: { 3: 1 } });
  assert.strictEqual(book(day, ZONE3, { slot: 0 }).ok, true);
  const second = book(day, ZONE3B, { slot: 11 });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'zone_full');
  assert.strictEqual(second.zone, 3);
});

test('the limit counts trips, not people', () => {
  const day = makeDay({ limits: { 3: 1 } });
  const group = book(day, ZONE3, { people: ['A One', 'B Two', 'C Three'] });
  assert.strictEqual(group.ok, true, group.reason);
  const t = seats.zoneTripsLeft(day.id, 3);
  assert.strictEqual(t.used, 1);
  assert.strictEqual(t.left, 0);
});

test('other zones are unaffected by a full Zone 3', () => {
  const day = makeDay({ limits: { 3: 1 } });
  book(day, ZONE3, { slot: 0 });
  assert.strictEqual(book(day, ZONE1, { slot: 11 }).ok, true);
});

test('0 closes a zone for the day', () => {
  const day = makeDay({ limits: { 2: 0 } });
  assert.strictEqual(book(day, ZONE2).reason, 'zone_full');
  assert.strictEqual(book(day, ZONE1B).ok, true);
});

test('a cancelled trip gives the zone back', () => {
  const day = makeDay({ limits: { 3: 1 } });
  const first = book(day, ZONE3, { slot: 0 });
  seats.cancelRegistration(first.registration.public_ref);
  assert.strictEqual(book(day, ZONE3B, { slot: 11 }).ok, true);
});

test('two days on the same date share the limit', () => {
  // Same date, different course: the van can still only go so far.
  const a = makeDay({ limits: { 3: 1 }, dayOffset: 80 });
  const b = makeDay({ limits: { 3: 1 }, dayOffset: 80, code: 'BABYSIT' });
  assert.strictEqual(book(a, ZONE3).ok, true);
  assert.strictEqual(book(b, ZONE3B).reason, 'zone_full');
});

test('the stricter of two same-date limits wins', () => {
  const a = makeDay({ dayOffset: 82 });                      // unlimited
  const b = makeDay({ limits: { 3: 1 }, dayOffset: 82, code: 'BABYSIT' });
  assert.strictEqual(book(a, ZONE3).ok, true);
  assert.strictEqual(seats.zoneTripsLeft(a.id, 3).left, 0);
  assert.strictEqual(book(a, ZONE3B, { slot: 11 }).reason, 'zone_full');
  void b;
});

test('a different date has its own trips', () => {
  const a = makeDay({ limits: { 3: 1 }, dayOffset: 84 });
  const b = makeDay({ limits: { 3: 1 }, dayOffset: 85 });
  assert.strictEqual(book(a, ZONE3).ok, true);
  assert.strictEqual(book(b, ZONE3B).ok, true);
});

test('times show as unavailable once the zone is used up', () => {
  const day = makeDay({ limits: { 3: 1 } });
  book(day, ZONE3, { slot: 0 });
  const slots = seats.daySlots(day.id, { zone: 3 });
  assert.strictEqual(slots.availableSlots, 0);
  assert.ok(slots.slots.some((s) => s.reason === 'zone_full'));
  assert.ok(seats.daySlots(day.id, { zone: 1 }).availableSlots > 0, 'Zone 1 still open');
});

test('unreadable limits mean unlimited, not closed', () => {
  const day = makeDay();
  getDb().prepare('UPDATE classes SET zone_limits = ? WHERE id = ?').run('not json', day.id);
  assert.strictEqual(seats.zoneLimitsFor(seats.getClass(day.id))[3], null);
  assert.strictEqual(book(day, ZONE3).ok, true);
});

console.log('\nfinding another day');

test('only days with a trip left into their zone are suggested', () => {
  const full = makeDay({ limits: { 3: 1 }, code: 'ZN_A', dayOffset: 100 });
  const open = makeDay({ limits: { 3: 1 }, code: 'ZN_A', dayOffset: 101 });
  const taken = makeDay({ limits: { 3: 1 }, code: 'ZN_A', dayOffset: 102 });
  book(full, ZONE3);
  book(taken, ZONE3);

  const alts = seats.suggestAlternatives({ classId: full.id, zip: ZONE3B });
  assert.deepStrictEqual(alts.map((a) => a.classId), [open.id]);
});

test('nothing is suggested to an address outside the area', () => {
  const a = makeDay({ code: 'ZN_B', dayOffset: 110 });
  makeDay({ code: 'ZN_B', dayOffset: 111 });
  assert.deepStrictEqual(seats.suggestAlternatives({ classId: a.id, zip: FAR }), []);
});

console.log(`\n${passed} passed, ${failed} failed\n`);

closeDb();
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch { /* the OS will clear it */ }
}
process.exit(failed === 0 ? 0 : 1);
