'use strict';

/**
 * ============================================================================
 *  PAYMENT INTEGRATION POINT 1 of 5 — WHICH PROVIDER IS LIVE
 * ============================================================================
 *
 * The only place that decides which payment provider is live, chosen by the
 * PAYMENT_PROVIDER environment variable (set on Render):
 *
 *   PAYMENT_PROVIDER=mock      (default) fake payments, nothing charged
 *   PAYMENT_PROVIDER=converge  Elavon Converge Lightbox (converge.js)
 *
 * To add a processor: copy template.js (integration point 2) to
 * <provider>.js, fill it in, add it to `providers` below, and set
 * PAYMENT_PROVIDER to its name. Every provider exposes the same functions —
 * createSession, verify and optionally webhook — so nothing outside this
 * folder changes when the switch happens.
 *
 * Full guide: PAYMENTS.md at the top of the repository.
 */

const PROVIDER = (process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();

const providers = {
  mock: require('./mock'),
  converge: require('./converge'),
  // yourprovider: require('./yourprovider'),   // ← add a new processor here
};

const active = providers[PROVIDER];

if (!active) {
  throw new Error(
    `Unknown PAYMENT_PROVIDER "${PROVIDER}". Expected one of: ${Object.keys(providers).join(', ')}`
  );
}

const isMock = PROVIDER === 'mock';

if (isMock) {
  console.warn(
    '\n  ⚠  PAYMENT PROVIDER: MOCK — no cards are charged, no money moves.' +
      '\n     Set PAYMENT_PROVIDER=converge once Elavon credentials are in place.\n'
  );
}

module.exports = {
  name: active.name,
  isMock,
  createSession: active.createSession,
  verify: active.verify,
  // Server-to-server payment notice, for providers that send one.
  webhook: typeof active.webhook === 'function' ? active.webhook : null,
};
