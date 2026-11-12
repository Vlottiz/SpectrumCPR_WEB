'use strict';

/**
 * ============================================================================
 *  PAYMENT INTEGRATION POINT 2 of 5 — PROVIDER ADAPTER TEMPLATE
 * ============================================================================
 *
 * Copy this file to src/payments/<provider>.js, fill in the three functions,
 * and register it in src/payments/index.js (integration point 1). Nothing else
 * in the app needs to change: bookings, seat holds, refunds-needed flags,
 * receipts and records all work from what these functions return.
 *
 * Card data never touches this server. The intended flow is a hosted payment
 * page or a hosted pop-up (PCI SAQ A): the provider collects the card, and we
 * only ever see a token, a transaction reference and an approved/declined.
 *
 * Flow
 * ----
 *   1. Customer books        POST /api/classes/:id/hold
 *                            the seat is held for 20 minutes, then
 *                            createSession() below is called
 *   2. Customer pays         the booking page sends them to `redirectUrl`
 *                            (hosted page) or opens the provider's pop-up
 *                            with `sessionToken` + `scriptUrl`
 *   3. Payment confirmed     either / both of:
 *        a. the provider calls   POST /api/payments/webhook   → webhook()
 *           (server to server — the source of truth)
 *        b. the browser posts    POST /api/registrations/:ref/confirm → verify()
 *           (a hint only; verify() must re-check with the provider's API)
 *   4. Customer returns      to `returnUrl` — the booking page shows their
 *                            confirmation once step 3 has landed
 *
 * Every booking has our reference (registration.public_ref, e.g. SPC-8F3K2Q).
 * Send it to the provider as the invoice / order number so it comes back on
 * the webhook and the payment can be matched to the seat.
 */

const name = 'template';   // stored on each paid booking as payment_provider

/** Read credentials from the environment (set on Render, never in the code). */
function config() {
  const cfg = {
    apiKey: process.env.PAYMENT_API_KEY,
    merchantId: process.env.PAYMENT_MERCHANT_ID,
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET,
    env: process.env.PAYMENT_ENV === 'production' ? 'production' : 'sandbox',
  };
  const missing = Object.entries(cfg).filter(([k, v]) => k !== 'env' && !v).map(([k]) => k);
  if (missing.length) throw new Error(`Payment provider not configured. Missing: ${missing.join(', ')}`);
  return cfg;
}

/**
 * Step 1 → 2: start a payment for one booking.
 *
 *   registration  the organiser's booking row: public_ref, student_name,
 *                 student_email, ... (a group pays once, on this row)
 *   cls           the class: title, starts_at, ...
 *   amountCents   the full amount to charge, in cents — every seat plus the
 *                 travel charge. Never trust an amount from the browser.
 *   seatCount     how many people the payment covers
 *   returnUrl     where to send the customer afterwards
 *                 (https://<site>/?booking=<public_ref>)
 *   notifyUrl     where the provider should post the result
 *                 (https://<site>/api/payments/webhook)
 *
 * Return ONE of:
 *   { provider: name, mode: 'redirect', redirectUrl, amountCents }
 *       hosted payment page: the customer is sent to redirectUrl
 *   { provider: name, mode: 'lightbox', sessionToken, scriptUrl, amountCents }
 *       hosted pop-up loaded from scriptUrl (see index.html, point 5)
 *
 * Throwing releases the held seat and tells the customer payment is
 * unavailable, so a provider outage never strands a seat.
 */
async function createSession({ registration, cls, amountCents, seatCount = 1, returnUrl, notifyUrl }) {
  const cfg = config();
  void cfg; void registration; void cls; void amountCents; void seatCount; void returnUrl; void notifyUrl;
  // e.g.
  //   const res = await fetch(`${API}/checkout/sessions`, {
  //     method: 'POST',
  //     headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
  //     body: JSON.stringify({
  //       amount: amountCents, currency: 'USD',
  //       invoice: registration.public_ref,
  //       description: seatCount > 1 ? `${cls.title} (${seatCount} people)` : cls.title,
  //       email: registration.student_email,
  //       return_url: returnUrl, notify_url: notifyUrl,
  //     }),
  //   });
  //   const data = await res.json();
  //   return { provider: name, mode: 'redirect', redirectUrl: data.url, amountCents };
  throw new Error('Payment provider adapter not written yet (src/payments/template.js).');
}

/**
 * Step 3b: the customer's browser says the payment went through.
 *
 * `payload` is whatever the provider's pop-up or return page handed back, plus
 * publicRef. Treat it as a claim: look the transaction up with the provider's
 * API before saying yes.
 *
 * Return { ok: true, paymentRef, raw } or { ok: false, reason, raw }.
 * paymentRef must be the provider's own transaction id — it's stored on the
 * booking and used to spot duplicate payments.
 */
async function verify(payload) {
  void payload;
  return { ok: false, reason: 'verify() not written yet', raw: null };
}

/**
 * Step 3a (optional but recommended): the provider's server tells ours.
 *
 * `req` is the Express request. req.rawBody holds the exact bytes received,
 * for checking the provider's signature with cfg.webhookSecret.
 *
 * Return { ok: true, publicRef, paymentRef, raw } for an approved payment —
 * publicRef is our booking reference sent as the invoice number in step 1 —
 * or { ok: false, reason } to reject it (bad signature, declined, unknown).
 * Safe to receive twice: a repeat of the same paymentRef is ignored.
 */
async function webhook(req) {
  void req;
  return { ok: false, reason: 'webhook() not written yet' };
}

module.exports = { name, createSession, verify, webhook };
