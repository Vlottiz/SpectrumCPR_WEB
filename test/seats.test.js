'use strict';

/**
 * Holds, payment, waitlist and group bookings under the travel model.
 *
 * A booking is one visit to one address, so it owns its time outright —
 * unlike a classroom, two customers can't share a slot. Slot mechanics
 * themselves live in slots.test.js; this file is about everything around them.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP = path.join(__dirname, 'tmp-test.db');
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.DB_PATH = TMP;
process.env.HOLD_MINUTES = '20';

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

/**
 * A long working day, so there's always another slot to reach for.
 *
 * Each booking owns 5.5 hours — 4 teaching plus 90 minutes to move on — so a
 * fixture that needs three non-clashing visits needs sixteen hours. Not a
 * realistic shift, but these tests are about holds and payment, not rostering.
 */
function makeDay({ capacity = 20, price = 8500, code = 'CPR', dayOffset = 7 } = {}) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(16, 0, 0, 0);
  const open = d.toISOString();
  const close = new Date(d.getTime() + 16 * 3600_000).toISOString();

  const info = getDb()
    .prepare(
      `INSERT INTO classes (course_code, title, starts_at, ends_at, location, capacity, price_cents)
       VALUES (?, 'BLS Provider', ?, ?, '', ?, ?)`
    )
    .run(code, open, close, capacity, price);
  return { id: Number(info.lastInsertRowid), open, close };
}

const ADDRESS = '1200 SW Main St, Hillsboro, OR 97123';

/** Slot n of the day, spaced far enough apart never to collide. */
const slot = (day, n = 0) =>
  new Date(new Date(day.open).getTime() + n * 5.5 * 3600_000).toISOString();

const person = (n) => ({ name: `Student ${n}`, email: `s${n}@example.com` });

/** One booking at its own slot. */
function hold(day, n = 0, people = null, extra = {}) {
  return seats.holdSeats({
    classId: day.id,
    attendees: people || [person(n).name],
    email: extra.email || person(n).email,
    slotStart: slot(day, n),
    address: ADDRESS,
    ...extra,
  });
}

console.log('\nholds');

test('a booking reserves a seat', () => {
  const day = makeDay();
  const r = hold(day, 0);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(seats.availability(day.id).taken, 1);
});

test('the hold window is 20 minutes', () => {
  const day = makeDay();
  const mins = (new Date(hold(day, 0).expiresAt) - new Date()) / 60000;
  assert.ok(mins > 19.5 && mins <= 20.1, `expected ~20 minutes, got ${mins.toFixed(2)}`);
});

test('the day headcount cannot be exceeded', () => {
  const day = makeDay({ capacity: 2 });
  assert.strictEqual(hold(day, 0).ok, true);
  assert.strictEqual(hold(day, 1).ok, true);

  const third = hold(day, 2);
  assert.strictEqual(third.ok, false);
  assert.strictEqual(third.reason, 'full');
  assert.strictEqual(seats.availability(day.id).available, 0);
});

test('a booking records its time and address', () => {
  const day = makeDay();
  const r = hold(day, 1);
  assert.strictEqual(r.registration.slot_start, slot(day, 1));
  assert.strictEqual(r.registration.address, ADDRESS);
});

console.log('\nexpiry');

test('an expired hold frees its seat with no sweeper run', () => {
  const day = makeDay({ capacity: 1 });
  const r = hold(day, 0);
  assert.strictEqual(seats.availability(day.id).available, 0);

  getDb()
    .prepare(`UPDATE registrations SET hold_expires_at = ? WHERE public_ref = ?`)
    .run(new Date(Date.now() - 1000).toISOString(), r.registration.public_ref);

  assert.strictEqual(seats.availability(day.id).available, 1);
  assert.strictEqual(hold(day, 1).ok, true);
});

test('the sweeper marks lapsed holds expired', () => {
  const day = makeDay();
  const r = hold(day, 0);
  getDb()
    .prepare(`UPDATE registrations SET hold_expires_at = ? WHERE public_ref = ?`)
    .run(new Date(Date.now() - 1000).toISOString(), r.registration.public_ref);

  const swept = seats.sweepExpired();
  assert.ok(swept.expiredHolds >= 1);
  assert.strictEqual(seats.findByRef(r.registration.public_ref).status, 'expired');
});

console.log('\npayment');

test('an approved payment confirms the booking', () => {
  const day = makeDay();
  const r = hold(day, 0);
  const c = seats.confirmPayment({
    publicRef: r.registration.public_ref, provider: 'mock', paymentRef: 'TXN_A',
  });
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.registration.status, 'confirmed');
});

test('replaying the same payment is idempotent', () => {
  const day = makeDay({ capacity: 4 });
  const r = hold(day, 0);
  const ref = r.registration.public_ref;

  seats.confirmPayment({ publicRef: ref, provider: 'mock', paymentRef: 'TXN_B' });
  const again = seats.confirmPayment({ publicRef: ref, provider: 'mock', paymentRef: 'TXN_B' });

  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.alreadyConfirmed, true);
  assert.strictEqual(seats.availability(day.id).taken, 1, 'must not consume a second seat');
});

test('payment landing after expiry on a full day flags a refund', () => {
  const day = makeDay({ capacity: 1 });
  const late = hold(day, 0);

  getDb()
    .prepare(`UPDATE registrations SET hold_expires_at = ? WHERE public_ref = ?`)
    .run(new Date(Date.now() - 1000).toISOString(), late.registration.public_ref);

  const other = hold(day, 1);
  seats.confirmPayment({
    publicRef: other.registration.public_ref, provider: 'mock', paymentRef: 'TXN_C',
  });

  const result = seats.confirmPayment({
    publicRef: late.registration.public_ref, provider: 'mock', paymentRef: 'TXN_D',
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'expired_and_full');
  assert.strictEqual(result.needsRefund, true);
});

console.log('\nwaitlist');

test('joining a full day puts you on the waitlist', () => {
  const day = makeDay({ capacity: 1 });
  hold(day, 0);
  const w = seats.joinWaitlist({ classId: day.id, name: 'Hopeful', email: 'h@d.com' });
  assert.strictEqual(w.ok, true);
  assert.strictEqual(w.position, 1);
  assert.strictEqual(seats.availability(day.id).waitlist, 1);
});

test('the same email cannot double-join', () => {
  const day = makeDay({ capacity: 1 });
  hold(day, 0);
  seats.joinWaitlist({ classId: day.id, name: 'Hopeful', email: 'dup@d.com' });
  const dup = seats.joinWaitlist({ classId: day.id, name: 'Hopeful', email: 'dup@d.com' });
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.reason, 'already_registered');
});

test('a cancellation offers the seat to the longest waiter', () => {
  const day = makeDay({ capacity: 1 });
  const held = hold(day, 0);
  const first = seats.joinWaitlist({ classId: day.id, name: 'First', email: 'f@d.com' });
  seats.joinWaitlist({ classId: day.id, name: 'Second', email: 'sec@d.com' });

  const res = seats.cancelRegistration(held.registration.public_ref);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.promoted.length, 1, 'one seat freed, one offer');
  assert.strictEqual(res.promoted[0].public_ref, first.registration.public_ref);
});

test('an offered seat is not available to anyone else', () => {
  const day = makeDay({ capacity: 1 });
  const held = hold(day, 0);
  seats.joinWaitlist({ classId: day.id, name: 'Waiting', email: 'w2@d.com' });
  seats.cancelRegistration(held.registration.public_ref);

  assert.strictEqual(seats.availability(day.id).available, 0, 'the offer holds the seat');
  assert.strictEqual(hold(day, 1).ok, false);
});

test('accepting an offer converts it to a 20 minute hold', () => {
  const day = makeDay({ capacity: 1 });
  const held = hold(day, 0);
  const w = seats.joinWaitlist({ classId: day.id, name: 'Waiting', email: 'w3@d.com' });
  seats.cancelRegistration(held.registration.public_ref);

  const accepted = seats.acceptOffer(w.registration.public_ref);
  assert.strictEqual(accepted.ok, true);
  assert.strictEqual(accepted.registration.status, 'held');
  const mins = (new Date(accepted.expiresAt) - new Date()) / 60000;
  assert.ok(mins > 19.5 && mins <= 20.1);
});

console.log('\ngroup bookings');

test('a group reserves one seat per attendee', () => {
  const day = makeDay();
  const r = hold(day, 0, ['Ana Reyes', 'Ben Cole', 'Cara Diaz']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.seats, 3);
  assert.strictEqual(seats.availability(day.id).taken, 3);
});

test('each attendee keeps their own name and reference', () => {
  const day = makeDay();
  const r = hold(day, 0, ['Ana Reyes', 'Ben Cole']);
  assert.deepStrictEqual(r.registrations.map((x) => x.student_name), ['Ana Reyes', 'Ben Cole']);
  assert.strictEqual(new Set(r.registrations.map((x) => x.public_ref)).size, 2);
});

test('every seat in a group shares one time and address', () => {
  const day = makeDay();
  const r = hold(day, 2, ['Ana', 'Ben', 'Cara']);
  assert.ok(r.registrations.every((x) => x.slot_start === slot(day, 2)));
  assert.ok(r.registrations.every((x) => x.address === ADDRESS));
});

test('the total is the per-seat price times the headcount', () => {
  const day = makeDay({ price: 8500 });
  const r = hold(day, 0, ['A', 'B', 'C', 'D']);
  // Four people sit in the -5% band, so 8500 becomes 8075 each.
  assert.strictEqual(r.registrations[0].amount_cents, 8075);
  assert.strictEqual(r.totalCents, 8075 * 4);
  assert.ok(r.registrations.every((x) => x.amount_cents === 8075),
    'every seat in a group pays the same');
});

test('a group of one is not treated as a group', () => {
  const day = makeDay();
  assert.strictEqual(hold(day, 0, ['Solo Person']).groupRef, null);
});

test('a group that will not fit takes nothing at all', () => {
  const day = makeDay({ capacity: 4 });
  hold(day, 0, ['One', 'Two']);
  const tooBig = hold(day, 1, ['Three', 'Four', 'Five']);
  assert.strictEqual(tooBig.ok, false);
  assert.strictEqual(tooBig.reason, 'not_enough_seats');
  assert.strictEqual(tooBig.available, 2);
  assert.strictEqual(seats.availability(day.id).taken, 2, 'no partial hold');
});

test('oversized groups are refused', () => {
  const day = makeDay({ capacity: 50 });
  const many = Array.from({ length: seats.MAX_GROUP_SEATS + 1 }, (_, i) => `P${i}`);
  const r = hold(day, 0, many);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'too_many_seats');
});

test('blank attendee names are dropped', () => {
  const day = makeDay();
  assert.strictEqual(hold(day, 0, ['Real Name', '', '   ']).seats, 1);
});

test('one payment confirms every seat', () => {
  const day = makeDay();
  const r = hold(day, 0, ['A', 'B', 'C']);
  const c = seats.confirmPayment({
    publicRef: r.registration.public_ref, provider: 'mock', paymentRef: 'TXN_GROUP',
  });
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.seatsConfirmed, 3);
  for (const row of r.registrations) {
    assert.strictEqual(seats.findByRef(row.public_ref).status, 'confirmed');
  }
});

test('one attendee can be dropped without losing the rest', () => {
  const day = makeDay();
  const r = hold(day, 0, ['A', 'B', 'C']);
  seats.confirmPayment({
    publicRef: r.registration.public_ref, provider: 'mock', paymentRef: 'TXN_G3',
  });

  seats.cancelRegistration(r.registrations[1].public_ref, { reason: 'staff change' });

  assert.strictEqual(seats.findByRef(r.registrations[1].public_ref).status, 'cancelled');
  assert.strictEqual(seats.findByRef(r.registrations[0].public_ref).status, 'confirmed');
  assert.strictEqual(seats.availability(day.id).taken, 2, 'the freed seat returns');
});

test('cancelling the group releases every seat', () => {
  const day = makeDay();
  const r = hold(day, 0, ['A', 'B', 'C', 'D']);
  const res = seats.cancelGroup(r.groupRef, { reason: 'training postponed' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.cancelled, 4);
  assert.strictEqual(seats.availability(day.id).taken, 0);
});

test('the group confirmation email lists everyone', () => {
  const day = makeDay();
  const r = hold(day, 0, ['Ana Reyes', 'Ben Cole'], { organiserName: 'Dana Manager' });
  seats.confirmPayment({
    publicRef: r.registration.public_ref, provider: 'mock', paymentRef: 'TXN_G4',
  });

  const mail = getDb()
    .prepare('SELECT * FROM outbox WHERE registration_id = ?')
    .get(r.registration.id);
  assert.ok(mail, 'expected an email');
  assert.ok(mail.subject.includes('2 seats'), mail.subject);
  assert.ok(mail.body.includes('Ana Reyes') && mail.body.includes('Ben Cole'));
  assert.ok(mail.body.includes('Dana Manager'), 'addressed to the organiser');
  assert.ok(mail.body.includes(ADDRESS), 'and says where to go');
});

console.log('\nper-attendee contact details');

test('attendees inherit the booking contact by default', () => {
  const day = makeDay();
  const r = hold(day, 0, [{ name: 'Ana' }, { name: 'Ben' }],
    { email: 'manager@d.com', phone: '5550001' });
  assert.ok(r.registrations.every((x) => x.student_email === 'manager@d.com'));
  assert.ok(r.registrations.every((x) => x.student_phone === '5550001'));
});

test('an attendee can carry their own email and phone', () => {
  const day = makeDay();
  const r = hold(day, 0,
    [{ name: 'Ana', email: 'ana@own.com', phone: '5559999' }, { name: 'Ben' }],
    { email: 'manager@d.com', phone: '5550001' });
  assert.strictEqual(r.registrations[0].student_email, 'ana@own.com');
  assert.strictEqual(r.registrations[0].student_phone, '5559999');
  assert.strictEqual(r.registrations[1].student_email, 'manager@d.com');
});

test('giving only an email still inherits the phone', () => {
  const day = makeDay();
  const r = hold(day, 0, [{ name: 'Ana', email: 'ana2@own.com' }],
    { email: 'manager@d.com', phone: '5550001' });
  assert.strictEqual(r.registrations[0].student_email, 'ana2@own.com');
  assert.strictEqual(r.registrations[0].student_phone, '5550001');
});

test('attendees with their own email get their own confirmation', () => {
  const day = makeDay();
  const r = hold(day, 0,
    [{ name: 'Ana Organiser' }, { name: 'Ben Cole', email: 'ben@own.com' }],
    { email: 'manager2@d.com' });
  seats.confirmPayment({
    publicRef: r.registration.public_ref, provider: 'mock', paymentRef: 'TXN_PC',
  });

  const mails = getDb().prepare('SELECT * FROM outbox').all();
  assert.strictEqual(mails.filter((m) => m.to_email === 'ben@own.com').length, 1);
  assert.strictEqual(mails.filter((m) => m.to_email === 'manager2@d.com').length, 1);
});

console.log('\nbookkeeping');

test('price is read from the day, never from the caller', () => {
  const day = makeDay({ price: 12345 });
  const r = hold(day, 0, null, { amountCents: 1 });
  // A solo booking carries the +10% band: 12345 -> 13580. The caller's
  // suggested amount is ignored either way.
  assert.strictEqual(r.registration.amount_cents, 13580);
});

test('a cancelled day refuses new bookings', () => {
  const day = makeDay();
  getDb().prepare(`UPDATE classes SET status = 'cancelled' WHERE id = ?`).run(day.id);
  const r = hold(day, 0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'class_cancelled');
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
