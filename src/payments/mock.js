'use strict';

/**
 * MOCK PAYMENT PROVIDER — DELETE WHEN CONVERGE GOES LIVE
 * ======================================================
 * Fakes the shape of a Converge Lightbox session so the rest of the app can be
 * built and demoed before Elavon issues credentials. It never touches a card,
 * never moves money, and never talks to the network.
 *
 * To remove: set PAYMENT_PROVIDER=converge, delete this file, delete the
 * /mock-checkout route in server.js. Nothing else references it.
 */

const crypto = require('crypto');

const name = 'mock';

/**
 * Converge's real flow requests a session token server-to-server, then hands it
 * to their JS to open the payment modal. We mimic that: a token plus a URL,
 * except the URL is our own throwaway checkout page.
 */
async function createSession({ registration, cls, amountCents, seatCount = 1 }) {
  const token = 'MOCKTOKEN_' + crypto.randomBytes(12).toString('hex').toUpperCase();
  const total = amountCents ?? registration.amount_cents;

  return {
    provider: name,
    mode: 'mock',
    sessionToken: token,
    // Real Converge returns nothing like this — the token goes to PayWithConverge.js.
    checkoutUrl: `/mock-checkout?ref=${encodeURIComponent(registration.public_ref)}`,
    amountCents: total,
    seatCount,
    description: seatCount > 1 ? `${cls.title} — ${seatCount} seats` : cls.title,
    // Visible in the API response so nobody mistakes staging for production.
    warning: 'MOCK PAYMENT — no card is charged and no money moves.',
  };
}

/**
 * Stands in for reading Converge's response fields (ssl_result, ssl_txn_id).
 * The mock checkout page posts back an explicit approve/decline choice.
 */
async function verify(payload) {
  const approved = payload?.outcome === 'approve';

  if (!approved) {
    return { ok: false, reason: 'declined', raw: { mock: true, ...payload } };
  }

  // Derived from the registration rather than random, so replaying a
  // confirmation yields the same reference — which is how a real gateway
  // behaves. Random refs here would fake a duplicate-payment conflict.
  const seed = String(payload?.publicRef || 'unknown');
  const digest = crypto.createHash('sha256').update(seed).digest('hex');

  return {
    ok: true,
    paymentRef: 'MOCKTXN_' + digest.slice(0, 16).toUpperCase(),
    raw: { mock: true, approvedAt: new Date().toISOString(), ...payload },
  };
}

module.exports = { name, createSession, verify };
