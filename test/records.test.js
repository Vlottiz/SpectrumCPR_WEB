'use strict';

/**
 * Customer records: the billing record, card renewals, the automatic
 * reminder, clearing details after 2 years, and days being archived rather
 * than deleted once they hold booking history.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP = path.join(__dirname, 'tmp-records.db');
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.DB_PATH = TMP;

const { getDb, closeDb } = require('../src/db');
const seats = require('../src/seats');
const records = require('../src/records');

let passed = 0;
let failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.log(`  ✗ ${label}\n      ${err.message}`); failed++; }
}

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

/** A class that happened `daysAgo` days ago, with confirmed people on it. */
function pastClass(daysAgo, people, { email = null } = {}) {
  const db = getDb();
  const start = ago(daysAgo);
  const cls = Number(db.prepare(
    `INSERT INTO classes (course_code, title, starts_at, ends_at, location, capacity, price_cents)
     VALUES ('CPR', 'CPR / AED', ?, ?, '', 20, 8500)`).run(start, ago(daysAgo - 0.3)).lastInsertRowid);
  const group = people.length > 1 ? `GRP-${cls}` : null;
  people.forEach((name, i) => {
    db.prepare(
      `INSERT INTO registrations (public_ref, class_id, status, student_name, student_email,
         student_phone, amount_cents, travel_cents, slot_start, address, group_ref, seat_index,
         confirmed_at, payment_provider, payment_ref, consent_at)
       VALUES (?, ?, 'confirmed', ?, ?, '5035550000', 8500, ?, ?, '1 Main St, Hillsboro, OR 97123',
               ?, ?, ?, 'mock', ?, ?)`)
      .run(`SPC-${cls}${i}`, cls, name, email || `${name.split(' ')[0].toLowerCase()}@x.com`,
           i === 0 ? 5000 : 0, start, group, i, start, `TX${cls}${i}`, start);
  });
  return cls;
}

console.log('\nthe billing record');

test('everyone who paid is listed with contact, address and amount', () => {
  pastClass(10, ['Ana Reyes']);
  const row = records.billing().find((r) => r.name === 'Ana Reyes');
  assert.ok(row);
  assert.strictEqual(row.email, 'ana@x.com');
  assert.ok(row.address.includes('Hillsboro'));
  assert.strictEqual(row.seatCents, 8500);
  assert.strictEqual(row.travelCents, 5000);
  assert.strictEqual(row.removed, false);
});

test('someone removed after paying stays on it, marked removed', () => {
  const cls = pastClass(12, ['Ben Cole']);
  seats.cancelRegistration(`SPC-${cls}0`, { reason: 'staff' });
  const row = records.billing().find((r) => r.name === 'Ben Cole');
  assert.ok(row && row.removed && row.removedAt);
});

test('an unpaid hold is not billing', () => {
  const db = getDb();
  const cls = pastClass(14, ['Cara Diaz']);
  db.prepare(`UPDATE registrations SET confirmed_at = NULL, status = 'expired' WHERE class_id = ?`).run(cls);
  assert.ok(!records.billing().some((r) => r.name === 'Cara Diaz'));
});

console.log('\ncard renewals');

test('a card expires 2 years after the class', () => {
  pastClass(100, ['Dee Park']);
  const r = records.renewals().find((x) => x.name === 'Dee Park');
  const expected = new Date(r.classAt);
  expected.setUTCFullYear(expected.getUTCFullYear() + 2);
  assert.strictEqual(r.expiresAt, expected.toISOString());
  assert.ok(r.daysLeft > 600 && r.daysLeft < 640, `${r.daysLeft}`);
});

test('the soonest to expire come first', () => {
  pastClass(700, ['Eve Lund']);
  const list = records.renewals();
  assert.strictEqual(list[0].name, 'Eve Lund');
});

test('a reminder is queued 30 days before expiry, once', () => {
  const db = getDb();
  const before = db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n;
  const sent = records.queueRenewalReminders();
  assert.strictEqual(sent, 1, 'only Eve is inside 30 days');
  const mail = db.prepare('SELECT * FROM outbox ORDER BY id DESC').get();
  assert.strictEqual(mail.to_email, 'eve@x.com');
  assert.ok(/expires/.test(mail.subject) && /Eve Lund/.test(mail.body));
  assert.strictEqual(records.queueRenewalReminders(), 0, 'not twice');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, before + 1);
});

test('a group sharing one inbox gets one email naming everyone', () => {
  pastClass(705, ['Fay One', 'Gus Two', 'Hal Three'], { email: 'boss@daycare.com' });
  assert.strictEqual(records.queueRenewalReminders(), 1);
  const mail = getDb().prepare('SELECT * FROM outbox ORDER BY id DESC').get();
  assert.strictEqual(mail.to_email, 'boss@daycare.com');
  assert.ok(['Fay One', 'Gus Two', 'Hal Three'].every((n) => mail.body.includes(n)), mail.body);
});

console.log('\nafter 2 years');

test('personal details are cleared, amounts stay', () => {
  const cls = pastClass(740, ['Ivy Old']);
  const cleared = records.anonymizeExpired();
  assert.ok(cleared >= 1);
  const row = getDb().prepare('SELECT * FROM registrations WHERE class_id = ?').get(cls);
  assert.strictEqual(row.student_email, '');
  assert.strictEqual(row.student_phone, '');
  assert.strictEqual(row.address, '');
  assert.ok(!row.student_name.includes('Ivy'));
  assert.strictEqual(row.amount_cents, 8500);
  assert.strictEqual(row.payment_ref, `TX${cls}0`);
  assert.ok(row.anonymized_at);
});

test('recent customers are untouched', () => {
  assert.ok(records.billing().some((r) => r.name === 'Ana Reyes' && r.email === 'ana@x.com'));
});

test('cleared people drop off the renewal list', () => {
  assert.ok(!records.renewals().some((r) => r.ref.startsWith('SPC-') && r.name.includes('removed')));
});

console.log('\ndays with history are archived, not deleted');

test('a cancelled day with a removed customer is archived and its records kept', () => {
  const db = getDb();
  const cls = pastClass(-20, ['Jo Future']);   // a class 20 days ahead
  seats.cancelRegistration(`SPC-${cls}0`);
  db.prepare(`UPDATE classes SET status = 'cancelled' WHERE id = ?`).run(cls);
  seats.purgeEmptyCancelledDays();
  const day = db.prepare('SELECT * FROM classes WHERE id = ?').get(cls);
  assert.ok(day, 'the day still exists');
  assert.strictEqual(day.archived, 1);
  assert.ok(records.billing().some((r) => r.name === 'Jo Future' && r.removed));
});

test('a cancelled day nobody ever booked is deleted outright', () => {
  const db = getDb();
  const id = Number(db.prepare(
    `INSERT INTO classes (course_code, title, starts_at, ends_at, location, capacity, price_cents, status)
     VALUES ('CPR', 'CPR / AED', ?, ?, '', 20, 8500, 'cancelled')`).run(ago(-30), ago(-29.7)).lastInsertRowid);
  seats.purgeEmptyCancelledDays();
  assert.strictEqual(db.prepare('SELECT * FROM classes WHERE id = ?').get(id), undefined);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
closeDb();
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* the OS will clear it */ }
}
process.exit(failed === 0 ? 0 : 1);
