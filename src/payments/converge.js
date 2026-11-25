'use strict';

/**
 * ELAVON CONVERGE — LIGHTBOX INTEGRATION
 * ======================================
 * Integration point 2 filled in for Elavon Converge Lightbox (see template.js
 * and PAYMENTS.md). Switched on with PAYMENT_PROVIDER=converge.
 *
 * Why Lightbox: the card form is Elavon's pop-up, loaded from their server,
 * so card data never touches this site (PCI SAQ A).
 *
 * How a payment is proven
 * -----------------------
 * Nothing the browser or a notice *says* is trusted on its own. Whichever
 * arrives first — the Lightbox approval from the customer's browser
 * (verify) or Elavon's Export Script notice (webhook) — the transaction is
 * looked up with Elavon's own API (txnquery) and only confirmed when:
 *   - Elavon reports it approved,
 *   - its invoice number is this booking's reference, and
 *   - its amount is exactly what the booking costs.
 *
 * Settings (Render environment variables, never in the code)
 * ---------------------------------------------------------
 *   CONVERGE_ACCOUNT_ID   Converge Account ID (ssl_account_id, formerly
 *                         ssl_merchant_id; CONVERGE_MERCHANT_ID still read)
 *   CONVERGE_USER_ID      API user with hosted-payments permission
 *   CONVERGE_PIN          that user's PIN
 *   CONVERGE_VENDOR_ID    ssl_vendor_id, assigned by Elavon for certification
 *   CONVERGE_ENV          'demo' (default) or 'production'
 *
 * Export Script (Converge > Settings > System Setup Support > Export Options;
 * set the Approval, Declined and Error URLs all to
 * https://www.spectrumcpr.org/api/payments/webhook):
 *   CONVERGE_EXPORT_USER      the Authentication Username entered there
 *   CONVERGE_EXPORT_PASSWORD  the Authentication Password entered there
 *   CONVERGE_EXPORT_CONFIRM   the Confirmation Text entered there (letters and
 *                             digits only); it's echoed in every reply, as
 *                             Converge checks for it
 *   CONVERGE_WEBHOOK_KEY      optional extra: the URL can end ?key=<this>
 * Converge counts any reply other than 200 as a failure and, with "Retry
 * failed export scripts" ticked, retries hourly and emails an alert. So
 * declines and other notices needing no action are answered 200; only a
 * failed login (401) or Elavon being unreachable for the lookup (503, so it
 * comes back later) are not.
 *
 * Elavon also needs: the account set to eCommerce, Lightbox enabled, Render's
 * outbound IPs on the API allow-list, and https://www.spectrumcpr.org as an
 * allowed referrer.
 *
 * TO CONFIRM WITH THE SOLUTION ENGINEER (marked "CONFIRM" below): the
 * txnquery status codes for a voided or declined sale, and that
 * ssl_invoice_number comes back on txnquery (Elavon's sample Export Script
 * post doesn't show it). The checks are deliberately strict, so a mismatch
 * fails closed (no booking confirmed) rather than open.
 */

const crypto = require('crypto');

const name = 'converge';

const HOSTS = {
  demo: 'https://api.demo.convergepay.com',
  production: 'https://api.convergepay.com',
};
const ENDPOINTS = {
  demo: `${HOSTS.demo}/hosted-payments/transaction_token`,
  production: `${HOSTS.production}/hosted-payments/transaction_token`,
};
const XML_API = {
  demo: `${HOSTS.demo}/VirtualMerchantDemo/processxml.do`,
  production: `${HOSTS.production}/VirtualMerchant/processxml.do`,
};

// Swappable in tests, so the adapter can be checked without a real account.
let doFetch = (...args) => fetch(...args);
function _setFetch(fn) { doFetch = fn; }

function config() {
  const cfg = {
    accountId: process.env.CONVERGE_ACCOUNT_ID || process.env.CONVERGE_MERCHANT_ID,
    userId: process.env.CONVERGE_USER_ID,
    pin: process.env.CONVERGE_PIN,
  };
  const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(
      `Converge is not configured. Missing: ${missing.join(', ')}. ` +
        'Set them on Render, or keep PAYMENT_PROVIDER=mock while waiting on Elavon.'
    );
  }
  return {
    ...cfg,
    vendorId: process.env.CONVERGE_VENDOR_ID || '',
    env: process.env.CONVERGE_ENV === 'production' ? 'production' : 'demo',
  };
}

/** The account fields every Converge request starts with. */
function credentials(cfg) {
  const out = { ssl_account_id: cfg.accountId, ssl_user_id: cfg.userId, ssl_pin: cfg.pin };
  if (cfg.vendorId) out.ssl_vendor_id = cfg.vendorId;
  return out;
}

const toDollars = (cents) => (cents / 100).toFixed(2);
const toCents = (dollars) => Math.round(Number(String(dollars).replace(/[^0-9.]/g, '')) * 100);

/** What this booking should have been charged, worked out from our records. */
function expectedCents(publicRef) {
  const seats = require('../seats');   // loaded late: seats.js needs the database
  const reg = seats.findByRef(publicRef);
  return reg ? seats.bookingTotals(reg).totalCents : null;
}

// --------------------------------------------------------------------------
//  Step 1: a Lightbox session token
// --------------------------------------------------------------------------

/**
 * Server-to-server call for an ssl_txn_auth_token (single use, valid 15
 * minutes). The browser hands it to PayWithConverge.js to open the pop-up.
 */
async function createSession({ registration, cls, amountCents, seatCount = 1 }) {
  const cfg = config();
  const total = amountCents ?? registration.amount_cents;
  const names = String(registration.student_name || '').trim().split(/\s+/);

  const body = new URLSearchParams({
    ...credentials(cfg),
    ssl_transaction_type: 'ccsale',
    ssl_amount: toDollars(total),
    // Our reference travels with the payment and comes back on the approval,
    // the Export Script notice and txnquery: it's how money maps to a seat.
    ssl_invoice_number: registration.public_ref,
    ssl_description: seatCount > 1 ? `${cls.title} (${seatCount} people)` : cls.title,
    ssl_first_name: names[0] || '',
    ssl_last_name: names.slice(1).join(' '),
    ssl_email: registration.student_email || '',
  });

  const res = await doFetch(ENDPOINTS[cfg.env], {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = (await res.text()).trim();

  // A bare token on success; an XML or HTML error otherwise.
  if (!res.ok || !text || text.startsWith('<') || /\s/.test(text)) {
    throw new Error(`Converge token request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return {
    provider: name,
    mode: 'lightbox',
    sessionToken: text,
    scriptUrl: `${HOSTS[cfg.env]}/hosted-payments/PayWithConverge.js`,
    amountCents: total,
    seatCount,
    description: seatCount > 1 ? `${cls.title} — ${seatCount} people` : cls.title,
  };
}

// --------------------------------------------------------------------------
//  Looking a payment up with Elavon (txnquery)
// --------------------------------------------------------------------------

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const xmlUnescape = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Converge's XML replies are flat: <txn><field>value</field>...</txn>. */
function parseTxns(xml) {
  const blocks = String(xml).match(/<txn>[\s\S]*?<\/txn>/g) || [];
  return blocks.map((block) => {
    const out = {};
    for (const m of block.matchAll(/<([A-Za-z0-9_]+)>([^<]*)<\/\1>/g)) out[m[1]] = xmlUnescape(m[2].trim());
    return out;
  });
}

async function queryTransaction(txnId) {
  const cfg = config();
  const fields = { ...credentials(cfg), ssl_transaction_type: 'txnquery', ssl_txn_id: txnId };
  const xml = `<txn>${Object.entries(fields)
    .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('')}</txn>`;

  const res = await doFetch(XML_API[cfg.env], {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ xmldata: xml }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Converge txnquery failed (${res.status})`);
  return parseTxns(text).find((t) => t.ssl_txn_id === String(txnId) || t.errorCode) || null;
}

// CONFIRM: statuses that mean the sale was reversed or never went through.
const DEAD_STATUSES = new Set(['VID', 'VOID', 'VOIDED', 'DEC', 'DECLINED', 'FPR', 'PRE', 'ERR']);

/**
 * Is Elavon's own record of this transaction a good payment for this booking?
 * Returns null when it is, or the reason it isn't.
 */
function problemWith(txn, publicRef) {
  if (!txn) return 'transaction not found at Elavon';
  if (txn.errorCode) return `Elavon error ${txn.errorCode}: ${txn.errorMessage || txn.errorName || ''}`.trim();

  const approved = txn.ssl_result !== undefined
    ? txn.ssl_result === '0'
    : /^APPROV/i.test(txn.ssl_result_message || '');
  if (!approved) return `not approved (${txn.ssl_result_message || 'no result'})`;
  if (txn.ssl_trans_status && DEAD_STATUSES.has(txn.ssl_trans_status.toUpperCase())) {
    return `transaction status ${txn.ssl_trans_status}`;
  }
  if (txn.ssl_transaction_type && !/sale/i.test(txn.ssl_transaction_type)) {
    return `not a sale (${txn.ssl_transaction_type})`;
  }
  if (txn.ssl_invoice_number !== publicRef) {
    return `invoice ${txn.ssl_invoice_number || '(none)'} is not booking ${publicRef}`;
  }
  const want = expectedCents(publicRef);
  if (want == null) return `booking ${publicRef} not found`;
  if (toCents(txn.ssl_amount) !== want) {
    return `amount ${txn.ssl_amount} does not match ${toDollars(want)}`;
  }
  return null;
}

/** Look the payment up and decide. Never throws: a failure is a "no". */
async function check(txnId, publicRef, raw) {
  let txn;
  try {
    txn = await queryTransaction(txnId);
  } catch (err) {
    return { ok: false, reason: `could not check with Elavon: ${err.message}`, raw };
  }
  const problem = problemWith(txn, publicRef);
  if (problem) return { ok: false, reason: problem, raw: { claimed: raw, elavon: txn } };
  return { ok: true, paymentRef: String(txnId), raw: { claimed: raw, elavon: txn } };
}

// --------------------------------------------------------------------------
//  Step 2a: the customer's browser says the Lightbox approved it
// --------------------------------------------------------------------------

/**
 * `payload` is what PayWithConverge's onApproval handed back, plus our
 * publicRef. Treated as a claim and checked with Elavon before saying yes.
 */
async function verify(payload) {
  const txnId = payload?.ssl_txn_id;
  const result = payload?.ssl_result;
  if (result !== undefined && String(result) !== '0') {
    return { ok: false, reason: payload?.ssl_result_message || 'declined', raw: payload };
  }
  if (!txnId) return { ok: false, reason: 'no transaction id', raw: payload };
  return check(String(txnId), String(payload.publicRef), payload);
}

// --------------------------------------------------------------------------
//  Step 2b: Elavon's Export Script notice (server to server)
// --------------------------------------------------------------------------

function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The Export Script's login, if one is set: HTTP Basic authentication. */
function loggedIn(req) {
  const user = process.env.CONVERGE_EXPORT_USER;
  const pass = process.env.CONVERGE_EXPORT_PASSWORD;
  if (!user && !pass) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.get ? req.get('authorization') || '' : req.headers?.authorization || '');
  if (!m) return false;
  const [u, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  // Compare both, always, so timing gives nothing away.
  const okUser = sameSecret(u, user || '');
  const okPass = sameSecret(rest.join(':'), pass || '');
  return okUser && okPass;
}

/**
 * An Export Script post: form-encoded ssl_* fields for an approval, decline
 * or error (Elavon's sample: ssl_result, ssl_result_message, ssl_txn_id,
 * ssl_amount, ssl_transaction_type, ... — new fields may appear and are
 * ignored). The post itself isn't trusted: the transaction it names is looked
 * up with txnquery, and Elavon's record says which booking it pays for.
 */
async function webhook(req) {
  const ack = process.env.CONVERGE_EXPORT_CONFIRM || undefined;
  const wantKey = process.env.CONVERGE_WEBHOOK_KEY;
  if (wantKey && !sameSecret(req.query?.key, wantKey)) return { ok: false, status: 401, reason: 'bad key' };
  if (!loggedIn(req)) return { ok: false, status: 401, reason: 'login required' };

  const body = req.body || {};
  const txnId = body.ssl_txn_id;
  const done = (reason) => ({ ok: false, ignore: true, reason, ack });
  if (!txnId) return done('no ssl_txn_id');
  if (String(body.ssl_result ?? '') !== '0') return done(`not an approval (${body.ssl_result_message || 'no result'})`);

  let txn;
  try {
    txn = await queryTransaction(String(txnId));
  } catch (err) {
    // Elavon will post it again within the hour.
    return { ok: false, status: 503, reason: `could not check with Elavon: ${err.message}` };
  }
  const publicRef = (txn && txn.ssl_invoice_number) || body.ssl_invoice_number;
  if (!publicRef) return done('no booking reference on the transaction');
  const problem = problemWith(txn, String(publicRef));
  if (problem) {
    console.error(`[payments] Export Script for ${txnId} not accepted: ${problem}`);
    return done(problem);
  }
  return {
    ok: true, publicRef: String(publicRef), paymentRef: String(txnId),
    raw: { claimed: body, elavon: txn }, ack, alwaysAcknowledge: true,
  };
}

module.exports = {
  name, createSession, verify, webhook, queryTransaction,
  ENDPOINTS, XML_API, _setFetch, _parseTxns: parseTxns,
};
