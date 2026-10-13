'use strict';

/**
 * Service areas: which ZIP codes a day will travel to, and what happens to a
 * customer outside them.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP = path.join(__dirname, 'tmp-geo.db');
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.DB_PATH = TMP;

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

function makeDay({ zips = null, code = 'CPR', dayOffset = 7, capacity = 20 } = {}) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(16, 0, 0, 0);
  const open = d.toISOString();
  const close = new Date(d.getTime() + 12 * 3600_000).toISOString();

  const info = getDb()
    .prepare(`INSERT INTO classes
                (course_code, title, starts_at, ends_at, location, capacity,
                 price_cents, service_zips)
              VALUES (?, 'CPR / AED', ?, ?, '', ?, 8500, ?)`)
    .run(code, open, close, capacity, zips ? JSON.stringify(zips) : null);
  return { id: Number(info.lastInsertRowid), open, close };
}

const book = (day, zip, hours = 0) =>
  seats.holdSeats({
    classId: day.id,
    attendees: ['Ana Reyes'],
    email: 'a@b.com',
    slotStart: new Date(new Date(day.open).getTime() + hours * 3600_000).toISOString(),
    address: `1200 SW Main St, Hillsboro, OR ${zip}`,
    zip,
  });

console.log('\nreading the area');

test('a day with no list travels anywhere', () => {
  const day = makeDay();
  assert.deepStrictEqual(seats.serviceZipsFor(seats.getClass(day.id)), []);
  assert.strictEqual(seats.servesZip(seats.getClass(day.id), '97123'), true);
  assert.strictEqual(seats.servesZip(seats.getClass(day.id), '10001'), true);
});

test('a listed ZIP is served', () => {
  const day = makeDay({ zips: ['97123', '97124'] });
  assert.strictEqual(seats.servesZip(seats.getClass(day.id), '97124'), true);
});

test('an unlisted ZIP is not', () => {
  const day = makeDay({ zips: ['97123'] });
  assert.strictEqual(seats.servesZip(seats.getClass(day.id), '97005'), false);
});

test('a ZIP+4 is matched on its first five digits', () => {
  const day = makeDay({ zips: ['97123'] });
  assert.strictEqual(seats.servesZip(seats.getClass(day.id), '97123-4455'), true);
});

test('a restricted day refuses a missing ZIP', () => {
  // Nothing to check them against, so we cannot promise to turn up.
  const day = makeDay({ zips: ['97123'] });
  assert.strictEqual(seats.servesZip(seats.getClass(day.id), ''), false);
});

test('an unrestricted day accepts a missing ZIP', () => {
  const day = makeDay();
  assert.strictEqual(seats.servesZip(seats.getClass(day.id), ''), true);
});

test('junk in the column means unrestricted, not unbookable', () => {
  const day = makeDay();
  getDb().prepare('UPDATE classes SET service_zips = ? WHERE id = ?')
    .run('not json', day.id);
  assert.strictEqual(seats.servesZip(seats.getClass(day.id), '99999'), true);
});

test('malformed entries in the list are ignored', () => {
  const day = makeDay({ zips: ['97123', 'abcde', '12', '97124'] });
  assert.deepStrictEqual(seats.serviceZipsFor(seats.getClass(day.id)), ['97123', '97124']);
});

console.log('\nbooking inside and outside');

test('a booking inside the area goes through', () => {
  const day = makeDay({ zips: ['97123'] });
  assert.strictEqual(book(day, '97123').ok, true);
});

test('a booking outside the area is refused', () => {
  const day = makeDay({ zips: ['97123'] });
  const r = book(day, '97005');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'outside_service_area');
});

test('the refusal says where we do go', () => {
  const day = makeDay({ zips: ['97123', '97124'] });
  const r = book(day, '97005');
  assert.deepStrictEqual(r.serviceZips, ['97123', '97124']);
  assert.strictEqual(r.zip, '97005');
});

test('a refused booking reserves nothing', () => {
  const day = makeDay({ zips: ['97123'] });
  book(day, '97005');
  assert.strictEqual(seats.availability(day.id).taken, 0, 'no seat taken');
  assert.strictEqual(seats.daySlots(day.id).slots[0].available, true, 'no slot held');
});

test('an unrestricted day takes any ZIP', () => {
  const day = makeDay();
  assert.strictEqual(book(day, '10001').ok, true);
});

test('a restricted day refuses a booking with no ZIP at all', () => {
  const day = makeDay({ zips: ['97123'] });
  const r = seats.holdSeats({
    classId: day.id, attendees: ['Ana'], email: 'a@b.com',
    slotStart: day.open, address: '1200 SW Main St, Hillsboro OR',
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'outside_service_area');
});

console.log('\nfinding a day that does reach them');

test('only days serving the ZIP are suggested', () => {
  const near = makeDay({ zips: ['97005'], code: 'GEO_A', dayOffset: 40 });
  makeDay({ zips: ['99999'], code: 'GEO_A', dayOffset: 41 });
  const full = makeDay({ zips: ['97005'], code: 'GEO_A', dayOffset: 39, capacity: 1 });
  book(full, '97005');

  const alts = seats.suggestAlternatives({ classId: full.id, partySize: 1, zip: '97005' });
  assert.strictEqual(alts.length, 1, 'only the day covering 97005');
  assert.strictEqual(alts[0].classId, near.id);
});

test('without a ZIP every day is suggested', () => {
  const full = makeDay({ zips: ['97005'], code: 'GEO_B', dayOffset: 50, capacity: 1 });
  makeDay({ zips: ['97005'], code: 'GEO_B', dayOffset: 51 });
  makeDay({ zips: ['99999'], code: 'GEO_B', dayOffset: 52 });
  book(full, '97005');

  const alts = seats.suggestAlternatives({ classId: full.id, partySize: 1 });
  assert.strictEqual(alts.length, 2);
});

test('suggestions carry their own area', () => {
  const full = makeDay({ zips: ['97005'], code: 'GEO_C', dayOffset: 60, capacity: 1 });
  makeDay({ zips: ['97005', '97006'], code: 'GEO_C', dayOffset: 61 });
  book(full, '97005');

  const alts = seats.suggestAlternatives({ classId: full.id, partySize: 1, zip: '97005' });
  assert.deepStrictEqual(alts[0].serviceZips, ['97005', '97006']);
});

console.log(`\n${passed} passed, ${failed} failed\n`);

closeDb();
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch { /* the OS will clear it */ }
}
process.exit(failed === 0 ? 0 : 1);
