'use strict';

/**
 * ELAVON CONVERGE — LIGHTBOX INTEGRATION
 * ======================================
 * A ready-made example of integration point 2 (see template.js and
 * PAYMENTS.md). Use this if the processor is Elavon Converge; for any other
 * processor, start from template.js instead.
 *
 * Not active yet. Fill in credentials, flip PAYMENT_PROVIDER=converge, and the
 * rest of the app works unchanged — seats.js has no idea which provider is in
 * play.
 *
 * Why Lightbox and not Checkout.js: Lightbox puts the merchant at PCI SAQ A
 * (22 questions). Checkout.js is SAQ A-EP (191 questions) because card fields
 * live on our page. Unless the client specifically needs a fully custom payment
 * form, Lightbox is the far cheaper compliance path.
 *
 * BEFORE THIS WORKS, the client must call Elavon and request:
 *   1. Hosted Payments / Lightbox enabled on the account
 *   2. Account set to eCommerce (NOT Phone/Catalog — this is the usual blocker)
 *   3. An API user with permission to post a session token request
 *   4. Our production domain + server IP added to the allowed list
 *      (Converge Account > Settings > Fraud Prevention Rules > API IP Address
 *       Allowed List — tick the Checkout.js/Lightbox level, not XML)
 *
 * Server requirements Elavon enforces: HTTPS with a valid certificate, and
 * TLS 1.2 or 1.3 with Perfect Forward Secrecy.
 *
 * Endpoints:
 *   demo  https://api.demo.convergepay.com/hosted-payments/transaction_token
 *   prod  https://api.convergepay.com/hosted-payments/transaction_token
 *   JS    https://api.convergepay.com/hosted-payments/PayWithConverge.js
 *
 * Build against demo first. Elavon will assign a Solution Engineer for
 * integration testing before they let the account go live.
 */

const name = 'converge';

const ENDPOINTS = {
  demo: 'https://api.demo.convergepay.com/hosted-payments/transaction_token',
  production: 'https://api.convergepay.com/hosted-payments/transaction_token',
};

function config() {
  const cfg = {
    merchantId: process.env.CONVERGE_MERCHANT_ID,
    userId: process.env.CONVERGE_USER_ID,
    pin: process.env.CONVERGE_PIN,
    env: process.env.CONVERGE_ENV === 'production' ? 'production' : 'demo',
  };

  const missing = Object.entries(cfg)
    .filter(([k, v]) => k !== 'env' && !v)
    .map(([k]) => k);

  if (missing.length) {
    throw new Error(
      `Converge is not configured. Missing: ${missing.join(', ')}. ` +
        `Set these in .env, or run with PAYMENT_PROVIDER=mock while waiting on Elavon.`
    );
  }
  return cfg;
}

/**
 * Step 1 of Lightbox: server-to-server call for an ssl_txn_auth_token.
 * The token is single-use and short-lived. It goes to the browser, which hands
 * it to PayWithConverge.js to open the modal. Card data never touches us.
 */
async function createSession({ registration, cls, amountCents, seatCount = 1 }) {
  const cfg = config();
  // A group booking is one transaction covering every seat.
  const total = amountCents ?? registration.amount_cents;

  const body = new URLSearchParams({
    ssl_merchant_id: cfg.merchantId,
    ssl_user_id: cfg.userId,
    ssl_pin: cfg.pin,
    ssl_transaction_type: 'ccsale',
    ssl_amount: (total / 100).toFixed(2),
    // Our reference travels with the transaction and comes back in the
    // response — this is how a payment maps to a seat without scraping email.
    ssl_invoice_number: registration.public_ref,
    ssl_description: seatCount > 1 ? `${cls.title} (${seatCount} seats)` : cls.title,
    ssl_first_name: registration.student_name.split(' ')[0] || '',
    ssl_last_name: registration.student_name.split(' ').slice(1).join(' ') || '',
    ssl_email: registration.student_email,
  });

  const res = await fetch(ENDPOINTS[cfg.env], {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = (await res.text()).trim();

  // Converge returns a bare token string on success, or an XML error block.
  if (!res.ok || text.startsWith('<')) {
    throw new Error(`Converge token request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return {
    provider: name,
    mode: 'lightbox',
    sessionToken: text,
    scriptUrl:
      cfg.env === 'production'
        ? 'https://api.convergepay.com/hosted-payments/PayWithConverge.js'
        : 'https://api.demo.convergepay.com/hosted-payments/PayWithConverge.js',
    amountCents: total,
    seatCount,
    description: seatCount > 1 ? `${cls.title} — ${seatCount} seats` : cls.title,
  };
}

/**
 * Step 2: read the approval Converge hands back.
 *
 * IMPORTANT: the browser callback is a convenience, not proof of payment — a
 * user can forge a POST to our endpoint. Before going live, either verify the
 * transaction server-side with an XML API txnquery on ssl_txn_id, or configure
 * a Converge Export Script (their webhook) and treat that as the source of
 * truth. Wire that up during integration testing with the Solution Engineer.
 */
async function verify(payload) {
  const result = String(payload?.ssl_result ?? '');
  const message = String(payload?.ssl_result_message ?? '');
  const txnId = payload?.ssl_txn_id;

  // ssl_result === '0' means approved.
  if (result !== '0' || !txnId) {
    return {
      ok: false,
      reason: message || `declined (ssl_result=${result || 'missing'})`,
      raw: payload,
    };
  }

  return { ok: true, paymentRef: String(txnId), raw: payload };
}

module.exports = { name, createSession, verify, ENDPOINTS };
