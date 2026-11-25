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
process.env.PAYMENT_PROVIDER = 'converge';
process.env.ADMIN_TOKEN = 'cv-test';

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

  // Shaped like Elavon's sample Export Script post: no invoice number on it.
  const post = (over = {}) => ({ ssl_txn_id: 'TX-9', ssl_result: '0', ssl_result_message: 'APPROVAL',
    ssl_amount: '220.00', ssl_transaction_type: 'SALE', ssl_card_number: '47**********0084', ...over });
  const req = (body, headers = {}, query = {}) => ({
    body, query, get: (h) => headers[h.toLowerCase()],
  });

  await test('an approval finds its booking from Elavon\'s own record', async () => {
    txns = { 'TX-9': sale({ ssl_txn_id: 'TX-9' }) };
    const n = await converge.webhook(req(post()));
    assert.ok(n.ok, n.reason);
    assert.strictEqual(n.publicRef, REF);
    assert.strictEqual(n.paymentRef, 'TX-9');
    assert.strictEqual(n.alwaysAcknowledge, true);
  });

  await test('a forged post is not acted on (Elavon has no such payment)', async () => {
    txns = {};
    const n = await converge.webhook(req(post({ ssl_invoice_number: REF })));
    assert.ok(!n.ok);
    assert.ok(n.ignore, 'answered 200 so Elavon doesn\'t retry, but nothing is confirmed');
  });

  await test('a decline or error post is acknowledged and confirms nothing', async () => {
    calls = [];
    const n = await converge.webhook(req(post({ ssl_result: '1', ssl_result_message: 'DECLINED' })));
    assert.ok(!n.ok && n.ignore);
    assert.strictEqual(calls.length, 0);
  });

  await test('with a login set, a post without it gets 401 and a login prompt', async () => {
    process.env.CONVERGE_EXPORT_USER = 'elavon';
    process.env.CONVERGE_EXPORT_PASSWORD = 'pa:ss-123';
    txns = { 'TX-9': sale({ ssl_txn_id: 'TX-9' }) };
    const basic = (u, p) => ({ authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` });
    assert.strictEqual((await converge.webhook(req(post()))).status, 401);
    assert.strictEqual((await converge.webhook(req(post(), basic('elavon', 'wrong')))).status, 401);
    assert.ok((await converge.webhook(req(post(), basic('elavon', 'pa:ss-123')))).ok);
    delete process.env.CONVERGE_EXPORT_USER;
    delete process.env.CONVERGE_EXPORT_PASSWORD;
  });

  await test('the Confirmation Text is handed back on every reply', async () => {
    process.env.CONVERGE_EXPORT_CONFIRM = 'SpectrumOK';
    txns = { 'TX-9': sale({ ssl_txn_id: 'TX-9' }) };
    assert.strictEqual((await converge.webhook(req(post()))).ack, 'SpectrumOK');
    assert.strictEqual((await converge.webhook(req(post({ ssl_result: '1' })))).ack, 'SpectrumOK');
    delete process.env.CONVERGE_EXPORT_CONFIRM;
  });

  await test('with a URL key set, a post without it gets 401', async () => {
    process.env.CONVERGE_WEBHOOK_KEY = 's3cret-key';
    assert.strictEqual((await converge.webhook(req(post()))).status, 401);
    assert.ok((await converge.webhook(req(post(), {}, { key: 's3cret-key' }))).ok);
    delete process.env.CONVERGE_WEBHOOK_KEY;
  });

  await test('if Elavon can\'t be reached for the check, it answers 503 so Elavon retries', async () => {
    converge._setFetch(async () => { throw new Error('network down'); });
    const n = await converge.webhook(req(post()));
    assert.strictEqual(n.status, 503);
  });

  console.log('\nthe webhook address, as Elavon sees it');

  const app = require('../src/server');
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  const URL = `http://localhost:${server.address().port}/api/payments/webhook`;
  const send = (fields, headers = {}) => fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
  });
  converge._setFetch(async (url, opts) => {
    const body = Object.fromEntries(new URLSearchParams(String(opts.body)));
    const id = (body.xmldata.match(/<ssl_txn_id>([^<]*)</) || [])[1];
    const t = txns[id];
    return { ok: true, status: 200, text: async () => (t
      ? `<txn>${Object.entries(t).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</txn>`
      : '<txn><errorCode>5000</errorCode></txn>') };
  });
  process.env.CONVERGE_EXPORT_USER = 'elavon';
  process.env.CONVERGE_EXPORT_PASSWORD = 'pw-123';
  process.env.CONVERGE_EXPORT_CONFIRM = 'SpectrumOK';
  const login = { Authorization: `Basic ${Buffer.from('elavon:pw-123').toString('base64')}` };

  await test('no login: 401 with a Basic login prompt', async () => {
    const r = await send(post());
    assert.strictEqual(r.status, 401);
    assert.match(r.headers.get('www-authenticate') || '', /^Basic/);
  });

  await test('a decline: 200 with the Confirmation Text, so Elavon doesn\'t flag a failure', async () => {
    const r = await send(post({ ssl_result: '1', ssl_result_message: 'DECLINED' }), login);
    assert.strictEqual(r.status, 200);
    assert.match(await r.text(), /SpectrumOK/);
    assert.strictEqual(db.prepare('SELECT status FROM registrations WHERE public_ref = ?').get(REF).status, 'held');
  });

  await test('an approval: 200, Confirmation Text, and the booking is confirmed', async () => {
    txns = { 'TX-9': sale({ ssl_txn_id: 'TX-9' }) };
    const r = await send(post(), login);
    const text = await r.text();
    assert.strictEqual(r.status, 200, text);
    assert.match(text, /SpectrumOK/);
    const reg = db.prepare('SELECT status, payment_ref FROM registrations WHERE public_ref = ?').get(REF);
    assert.strictEqual(reg.status, 'confirmed');
    assert.strictEqual(reg.payment_ref, 'TX-9#0');   // one row per seat in a group
  });

  await test('the same approval again (Elavon\'s retry): still 200, nothing doubled', async () => {
    const r = await send(post(), login);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).ok, true);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM events WHERE kind = 'duplicate_payment_suspected'`).get().n, 0);
  });

  await test('a different payment for an already-paid booking is still flagged', async () => {
    txns = { 'TX-7': sale({ ssl_txn_id: 'TX-7' }) };
    const r = await send(post({ ssl_txn_id: 'TX-7' }), login);
    assert.strictEqual(r.status, 200);   // acknowledged, so Elavon doesn't retry hourly
    assert.strictEqual((await r.json()).ok, false);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM events WHERE kind = 'duplicate_payment_suspected'`).get().n, 1);
  });

  server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  closeDb();
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  process.exit(failed ? 1 : 0);
})();
