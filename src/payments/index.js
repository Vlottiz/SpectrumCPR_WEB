'use strict';

/**
 * The only place that decides which payment provider is live.
 *
 * PAYMENT_PROVIDER=mock      (default) fake payments, nothing charged
 * PAYMENT_PROVIDER=converge  real Elavon Converge Lightbox
 *
 * Both expose the same two functions, so nothing outside this folder changes
 * when the switch happens.
 */

const PROVIDER = (process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();

const providers = {
  mock: require('./mock'),
  converge: require('./converge'),
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
};
