'use strict';

/**
 * Elavon Converge Lightbox adapter, against a pretend Elavon: the session
 * token request, and that a payment is only accepted once Elavon's own
 * record (txnquery) shows it approved, for this booking, for the right amount.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP = path.join(__dirname, 'tmp-converge.db');
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.DB_PATH = TMP;
Object.assign(process.env, {
  CONVERGE_ACCOUNT_ID: '0012345', CONVERGE_USER_ID: 'apiuser', CONVERGE_PIN: 'PIN&<1>',
  CONVERGE_VENDOR_ID: 'VEND01',
});
delete process.env.CONVERGE_ENV;
delete process.env.CONVERGE_WEBHOOK_KEY;

const { getDb, closeDb } = require('../src/db');
const converge = require('../src/payments/converge');

let passed = 0;
let failed = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.log(`  ✗ ${label}\n      ${err.message}`); failed++; }
}

// A held group booking: two seats at $85 plus a $50 trip = $220.00.
const db = getDb();
const cls = Number(db.prepare(
  `INSERT INTO classes (course_code, title, starts_at, ends_at, location, capacity, price_cents)
   VALUES ('CPR', 'CPR / AED', '2027-03-02T16:00:00Z', '2027-03-03T02:00:00Z', '', 10, 8500)`)
  .run().lastInsertRowid);
['Ana Reyes', 'Bo Lin'].forEach((n, i) => db.prepare(
  `INSERT INTO registrations (public_ref, class_id, status, student_name, student_email,
     amount_cents, travel_cents, group_ref, seat_index, consent_at)
   VALUES (?, ?, 'held', ?, 'ana@x.com', 8500, ?, 'GRP-1', ?, '2027-01-01T00:00:00Z')`)
  .run(`SPC-AAA00${i}`, cls, n, i === 0 ? 5000 : 0, i));
const REF = 'SPC-AAA000';

/** Pretend Elavon. `txns` is what txnquery knows about. */
let calls = [];
let txns = {};
let tokenReply = { status: 200, text: 'tok_ABC123' };
converge._setFetch(async (url, opts) => {
  const body = Object.fromEntries(new URLSearchParams(String(opts.body)));
  calls.push({ url, body });
  if (url.endsWith('/transaction_token')) {
    return { ok: tokenReply.status === 200, status: tokenReply.status, text: async () => tokenReply.text };
  }
  const id = (body.xmldata.match(/<ssl_txn_id>([^<]*)</) || [])[1];
  const t = txns[id];
  const xml = t
    ? `<txnlist><ssl_txn_count>1</ssl_txn_count><txn>${Object.entries(t)
      .map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</txn></txnlist>`
    : '<txn><errorCode>5000</errorCode><errorMessage>Not found</errorMessage></txn>';
  return { ok: true, status: 200, text: async () => xml };
});

const sale = (over = {}) => ({
  ssl_txn_id: 'TX-1', ssl_result: '0', ssl_result_message: 'APPROVAL', ssl_trans_status: 'STL',
  ssl_transaction_type: 'SALE', ssl_invoice_number: REF, ssl_amount: '220.00', ...over,
});

(async () => {
  console.log('\nstarting a Lightbox payment');

  await test('asks Elavon for a token with the account ID, vendor ID, amount and booking reference', async () => {
    calls = [];
    const s = await converge.createSession({
      registration: { public_ref: REF, student_name: 'Ana Maria Reyes', student_email: 'ana@x.com' },
      cls: { title: 'CPR / AED' }, amountCents: 22000, seatCount: 2,
    });
    const b = calls[0].body;
    assert.strictEqual(calls[0].url, 'https://api.demo.convergepay.com/hosted-payments/transaction_token');
    assert.strictEqual(b.ssl_account_id, '0012345');
    assert.strictEqual(b.ssl_merchant_id, undefined);
    assert.strictEqual(b.ssl_vendor_id, 'VEND01');
    assert.strictEqual(b.ssl_transaction_type, 'ccsale');
    assert.strictEqual(b.ssl_amount, '220.00');
    assert.strictEqual(b.ssl_invoice_number, REF);
    assert.strictEqual(b.ssl_last_name, 'Maria Reyes');
    assert.strictEqual(s.mode, 'lightbox');
    assert.strictEqual(s.sessionToken, 'tok_ABC123');
    assert.strictEqual(s.scriptUrl, 'https://api.demo.convergepay.com/hosted-payments/PayWithConverge.js');
  });

  await test('an error from Elavon stops the payment (and frees the seat)', async () => {
    tokenReply = { status: 200, text: '<txn><errorCode>4025</errorCode></txn>' };
    await assert.rejects(() => converge.createSession({
      registration: { public_ref: REF, student_name: 'A', student_email: '' },
      cls: { title: 'CPR' }, amountCents: 100,
    }), /4025/);
    tokenReply = { status: 200, text: 'tok_ABC123' };
  });

  await test('production uses the live addresses', async () => {
    process.env.CONVERGE_ENV = 'production';
    calls = [];
    const s = await converge.createSession({
      registration: { public_ref: REF, student_name: 'A', student_email: '' },
      cls: { title: 'CPR' }, amountCents: 100,
    });
    assert.ok(calls[0].url.startsWith('https://api.convergepay.com/'));
    assert.ok(s.scriptUrl.startsWith('https://api.convergepay.com/'));
    delete process.env.CONVERGE_ENV;
  });

  await test('missing credentials are named, never guessed', async () => {
    const saved = process.env.CONVERGE_PIN;
    delete process.env.CONVERGE_PIN;
    await assert.rejects(() => converge.createSession({
      registration: { public_ref: REF, student_name: 'A' }, cls: { title: 'x' }, amountCents: 1,
    }), /Missing: pin/);
    process.env.CONVERGE_PIN = saved;
  });

  console.log('\nthe browser says it was approved (checked with Elavon)');

  await test('a real approval for this booking and amount is accepted', async () => {
    txns = { 'TX-1': sale() };
    calls = [];
    const v = await converge.verify({ ssl_result: '0', ssl_txn_id: 'TX-1', publicRef: REF });
    assert.ok(v.ok, v.reason);
    assert.strictEqual(v.paymentRef, 'TX-1');
    assert.strictEqual(calls[0].url, 'https://api.demo.convergepay.com/VirtualMerchantDemo/processxml.do');
    assert.match(calls[0].body.xmldata, /<ssl_transaction_type>txnquery<\/ssl_transaction_type>/);
    assert.match(calls[0].body.xmldata, /<ssl_pin>PIN&amp;&lt;1&gt;<\/ssl_pin>/);
  });

  await test('a made-up approval Elavon has never heard of is refused', async () => {
    txns = {};
    const v = await converge.verify({ ssl_result: '0', ssl_txn_id: 'FAKE', publicRef: REF });
    assert.ok(!v.ok);
    assert.match(v.reason, /5000/);
  });

  await test('a payment for a smaller amount is refused', async () => {
    txns = { 'TX-1': sale({ ssl_amount: '1.00' }) };
    const v = await converge.verify({ ssl_result: '0', ssl_txn_id: 'TX-1', publicRef: REF });
    assert.ok(!v.ok);
    assert.match(v.reason, /amount/);
  });

  await test('someone else\'s payment can\'t be used for this booking', async () => {
    txns = { 'TX-1': sale({ ssl_invoice_number: 'SPC-OTHER1' }) };
    const v = await converge.verify({ ssl_result: '0', ssl_txn_id: 'TX-1', publicRef: REF });
    assert.ok(!v.ok);
    assert.match(v.reason, /invoice/);
  });

  await test('a declined or voided sale is refused', async () => {
    txns = { 'TX-1': sale({ ssl_result: '1', ssl_result_message: 'DECLINED' }) };
    assert.ok(!(await converge.verify({ ssl_txn_id: 'TX-1', publicRef: REF })).ok);
    txns = { 'TX-1': sale({ ssl_trans_status: 'VID' }) };
    assert.ok(!(await converge.verify({ ssl_txn_id: 'TX-1', publicRef: REF })).ok);
  });

  await test('a decline from the pop-up is refused without asking Elavon', async () => {
    calls = [];
    const v = await converge.verify({ ssl_result: '1', ssl_result_message: 'DECLINED', publicRef: REF });
    assert.ok(!v.ok);
    assert.strictEqual(calls.length, 0);
  });

  await test('if Elavon can\'t be reached, nothing is confirmed', async () => {
    const real = converge._setFetch;
    real(async () => { throw new Error('network down'); });
    const v = await converge.verify({ ssl_result: '0', ssl_txn_id: 'TX-1', publicRef: REF });
    assert.ok(!v.ok);
    assert.match(v.reason, /could not check/);
  });

  console.log('\nElavon\'s Export Script notice');

  // Restore pretend Elavon (the previous test broke it on purpose).
  converge._setFetch(async (url, opts) => {
    const body = Object.fromEntries(new URLSearchParams(String(opts.body)));
    const id = (body.xmldata.match(/<ssl_txn_id>([^<]*)</) || [])[1];
    const t = txns[id];
    return { ok: true, status: 200, text: async () => (t
      ? `<txnlist><txn>${Object.entries(t).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</txn></txnlist>`
      : '<txn><errorCode>5000</errorCode></txn>') };
  });

  await test('a notice for a real approved payment names the booking', async () => {
    txns = { 'TX-9': sale({ ssl_txn_id: 'TX-9' }) };
    const n = await converge.webhook({ query: {}, body: { ssl_txn_id: 'TX-9', ssl_invoice_number: REF, ssl_result: '0' } });
    assert.ok(n.ok, n.reason);
    assert.strictEqual(n.publicRef, REF);
    assert.strictEqual(n.paymentRef, 'TX-9');
  });

  await test('a forged notice is refused because Elavon has no such payment', async () => {
    txns = {};
    const n = await converge.webhook({ query: {}, body: { ssl_txn_id: 'TX-X', ssl_invoice_number: REF, ssl_result: '0' } });
    assert.ok(!n.ok);
  });

  await test('with a webhook key set, a notice without it is turned away', async () => {
    process.env.CONVERGE_WEBHOOK_KEY = 's3cret-key';
    txns = { 'TX-9': sale({ ssl_txn_id: 'TX-9' }) };
    const body = { ssl_txn_id: 'TX-9', ssl_invoice_number: REF, ssl_result: '0' };
    assert.ok(!(await converge.webhook({ query: {}, body })).ok);
    assert.ok(!(await converge.webhook({ query: { key: 'wrong' }, body })).ok);
    assert.ok((await converge.webhook({ query: { key: 's3cret-key' }, body })).ok);
    delete process.env.CONVERGE_WEBHOOK_KEY;
  });

  await test('a notice about a decline confirms nothing', async () => {
    const n = await converge.webhook({ query: {}, body: { ssl_txn_id: 'TX-9', ssl_invoice_number: REF, ssl_result: '1' } });
    assert.ok(!n.ok);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  closeDb();
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  process.exit(failed ? 1 : 0);
})();
