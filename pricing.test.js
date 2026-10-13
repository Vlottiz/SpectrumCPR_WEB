'use strict';

/**
 * Group pricing: the surcharge on small bookings, the discounts on larger
 * ones, and the rules that stop a badly-set band silently mispricing a day.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP = path.join(__dirname, 'tmp-pricing.db');
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

const day = (price = 8500, tiers = null) => ({ id: 1, price_cents: price, pricing_tiers: tiers });
const dollars = (c) => (c / 100).toFixed(2);

console.log('\nthe default bands');

test('one person pays 10 percent more', () => {
  const q = seats.priceFor(day(), 1);
  assert.strictEqual(q.perSeatCents, 9350, `got ${dollars(q.perSeatCents)}`);
  assert.strictEqual(q.adjustPct, 10);
});

test('two people still pay the surcharge', () => {
  assert.strictEqual(seats.priceFor(day(), 2).perSeatCents, 9350);
});

test('three people get 5 percent off', () => {
  const q = seats.priceFor(day(), 3);
  assert.strictEqual(q.perSeatCents, 8075, `got ${dollars(q.perSeatCents)}`);
  assert.strictEqual(q.adjustPct, -5);
});

test('four people are still in the 5 percent band', () => {
  assert.strictEqual(seats.priceFor(day(), 4).perSeatCents, 8075);
});

test('five people get 10 percent off', () => {
  const q = seats.priceFor(day(), 5);
  assert.strictEqual(q.perSeatCents, 7650, `got ${dollars(q.perSeatCents)}`);
  assert.strictEqual(q.adjustPct, -10);
});

test('a big group stays at the best rate', () => {
  assert.strictEqual(seats.priceFor(day(), 12).perSeatCents, 7650);
});

test('the total is the per-person price times the headcount', () => {
  const q = seats.priceFor(day(), 5);
  assert.strictEqual(q.totalCents, 7650 * 5);
});

test('three people cost less in total than two', () => {
  // The point of the bands: adding a third person should not feel punitive.
  const two = seats.priceFor(day(), 2).totalCents;
  const three = seats.priceFor(day(), 3).totalCents;
  assert.ok(three > two, 'three still costs more overall');
  assert.ok(seats.priceFor(day(), 3).perSeatCents < seats.priceFor(day(), 2).perSeatCents,
    'but less per person');
});

console.log('\nexplaining the price');

test('every band carries a reason', () => {
  for (const n of [1, 3, 5]) {
    const q = seats.priceFor(day(), n);
    assert.ok(q.reason && q.reason.length > 20, `party of ${n} has no reason`);
    assert.ok(q.label, `party of ${n} has no label`);
  }
});

test('the surcharge explains the fixed cost of a visit', () => {
  const q = seats.priceFor(day(), 1);
  assert.ok(/travel|set up|visit/i.test(q.reason), q.reason);
});

test('a saving is reported as a saving', () => {
  assert.ok(seats.priceFor(day(), 5).savingCents > 0);
});

test('a surcharge is reported as a negative saving', () => {
  assert.ok(seats.priceFor(day(), 1).savingCents < 0);
});

console.log('\nrounding');

test('the per-person price is a whole number of cents', () => {
  for (const price of [8500, 9999, 7333, 6500]) {
    for (const n of [1, 3, 5]) {
      const q = seats.priceFor(day(price), n);
      assert.strictEqual(q.perSeatCents, Math.round(q.perSeatCents),
        `${price} / ${n} gave a fraction`);
    }
  }
});

test('the total divides evenly by the headcount', () => {
  // Rounding per seat, not on the total, so a roster never shows one person
  // paying a cent more than the rest.
  const q = seats.priceFor(day(9999), 7);
  assert.strictEqual(q.totalCents % 7, 0);
  assert.strictEqual(q.totalCents / 7, q.perSeatCents);
});

console.log('\ncustom bands');

test('a day can carry its own bands', () => {
  const custom = JSON.stringify([
    { minSize: 1, maxSize: 1, adjustPct: 25, label: 'Solo', reason: 'Private session.' },
    { minSize: 2, maxSize: null, adjustPct: 0, label: 'Standard', reason: 'Normal rate.' },
  ]);
  assert.strictEqual(seats.priceFor(day(8000, custom), 1).perSeatCents, 10000);
  assert.strictEqual(seats.priceFor(day(8000, custom), 6).perSeatCents, 8000);
});

test('unreadable bands fall back to the defaults', () => {
  const q = seats.priceFor(day(8500, 'not json at all'), 1);
  assert.strictEqual(q.perSeatCents, 9350, 'should price as if the defaults applied');
});

test('an empty band list falls back to the defaults', () => {
  assert.strictEqual(seats.priceFor(day(8500, '[]'), 5).perSeatCents, 7650);
});

test('a size no band covers pays the base price', () => {
  const gapped = JSON.stringify([
    { minSize: 1, maxSize: 2, adjustPct: 10, label: 'Small', reason: 'x' },
    { minSize: 9, maxSize: null, adjustPct: -20, label: 'Huge', reason: 'y' },
  ]);
  // Nothing covers 5. The base price is the safe answer — never an invented one.
  const q = seats.priceFor(day(8500, gapped), 5);
  assert.strictEqual(q.perSeatCents, 8500);
  assert.strictEqual(q.adjustPct, 0);
});

console.log('\nthe ladder shown to customers');

test('it lists every band', () => {
  assert.strictEqual(seats.priceLadder(day()).length, 3);
});

test('each rung carries its price and reason', () => {
  for (const rung of seats.priceLadder(day())) {
    assert.ok(rung.perSeatCents > 0);
    assert.ok(rung.reason);
    assert.ok(typeof rung.minSize === 'number');
  }
});

console.log('\nwhat a booking is charged');

test('a booking is charged its band price, not the base', () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  d.setUTCHours(16, 0, 0, 0);
  const open = d.toISOString();
  const close = new Date(d.getTime() + 10 * 3600_000).toISOString();

  const info = getDb()
    .prepare(`INSERT INTO classes
                (course_code, title, starts_at, ends_at, location, capacity, price_cents)
              VALUES ('CPR','CPR / AED',?,?,'',20,8500)`)
    .run(open, close);
  const classId = Number(info.lastInsertRowid);

  const r = seats.holdSeats({
    classId,
    attendees: ['Ana', 'Ben', 'Cara', 'Dev', 'Eve'],
    email: 'org@example.com',
    slotStart: open,
    address: '1200 SW Main St, Hillsboro, OR 97123',
  });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.registrations[0].amount_cents, 7650, 'each seat at the 10% discount');
  assert.strictEqual(r.totalCents, 7650 * 5);
  assert.strictEqual(r.pricing.adjustPct, -10);
});

test('a solo booking is charged the surcharge', () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 9);
  d.setUTCHours(16, 0, 0, 0);
  const open = d.toISOString();
  const close = new Date(d.getTime() + 10 * 3600_000).toISOString();

  const info = getDb()
    .prepare(`INSERT INTO classes
                (course_code, title, starts_at, ends_at, location, capacity, price_cents)
              VALUES ('CPR','CPR / AED',?,?,'',20,8500)`)
    .run(open, close);

  const r = seats.holdSeats({
    classId: Number(info.lastInsertRowid),
    attendees: ['Solo Person'],
    email: 'solo@example.com',
    slotStart: open,
    address: '1200 SW Main St, Hillsboro, OR 97123',
  });

  assert.strictEqual(r.registrations[0].amount_cents, 9350);
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
