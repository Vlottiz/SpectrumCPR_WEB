'use strict';

/**
 * Address lookup parsing. The providers themselves are stubbed — the point is
 * that their responses land in the shape the booking form expects, and that an
 * outage never blocks a booking.
 */

const assert = require('assert');
const addressModule = require('../src/address');

let passed = 0;
let failed = 0;

function test(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  \u2713 ${label}`); passed++; })
    .catch((err) => { console.log(`  \u2717 ${label}\n      ${err.message}`); failed++; });
}

(async () => {
  console.log('\nCensus parsing');

  await test('components become street, city, state and ZIP', () => {
    const parsed = addressModule.fromCensus({
      matchedAddress: '1200 SW MAIN ST, HILLSBORO, OR, 97123',
      addressComponents: {
        fromAddress: '1200', preDirection: 'SW', streetName: 'MAIN',
        suffixType: 'ST', city: 'HILLSBORO', state: 'OR', zip: '97123',
      },
    });
    assert.strictEqual(parsed.street, '1200 SW MAIN ST');
    assert.strictEqual(parsed.city, 'HILLSBORO');
    assert.strictEqual(parsed.state, 'OR');
    assert.strictEqual(parsed.zip, '97123');
  });

  await test('missing pieces leave no double spaces', () => {
    const parsed = addressModule.fromCensus({
      matchedAddress: '900 OAK AVE, PORTLAND, OR, 97204',
      addressComponents: {
        fromAddress: '900', streetName: 'OAK', suffixType: 'AVE',
        city: 'PORTLAND', state: 'OR', zip: '97204',
      },
    });
    assert.strictEqual(parsed.street, '900 OAK AVE');
    assert.ok(!parsed.street.includes('  '));
  });

  await test('an empty component block does not throw', () => {
    const parsed = addressModule.fromCensus({ matchedAddress: 'somewhere' });
    assert.strictEqual(parsed.street, '');
    assert.strictEqual(parsed.label, 'somewhere');
  });

  console.log('\nPhoton parsing');

  await test('a house result becomes a full address', () => {
    const parsed = addressModule.fromPhoton({
      properties: {
        housenumber: '1200', street: 'Southwest Main Street',
        city: 'Hillsboro', state: 'Oregon', postcode: '97123', countrycode: 'US',
      },
    });
    assert.strictEqual(parsed.street, '1200 Southwest Main Street');
    assert.strictEqual(parsed.city, 'Hillsboro');
    assert.strictEqual(parsed.state, 'OR', 'the full state name is abbreviated');
    assert.strictEqual(parsed.zip, '97123');
  });

  await test('a town rather than a city still fills', () => {
    const parsed = addressModule.fromPhoton({
      properties: { housenumber: '5', street: 'Elm St', town: 'Banks', state: 'Oregon' },
    });
    assert.strictEqual(parsed.city, 'Banks');
  });

  await test('a street with no number is still usable', () => {
    const parsed = addressModule.fromPhoton({
      properties: { street: 'Cornell Road', city: 'Hillsboro', state: 'Oregon' },
    });
    assert.strictEqual(parsed.street, 'Cornell Road');
    assert.ok(!parsed.street.startsWith(' '));
  });

  await test('an already-abbreviated state is left alone', () => {
    const parsed = addressModule.fromPhoton({
      properties: { housenumber: '1', street: 'A St', city: 'X', state: 'OR' },
    });
    assert.strictEqual(parsed.state, 'OR');
  });

  await test('Photon results outside the US are dropped', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ features: [
        { properties: { housenumber: '1', street: 'Main St', city: 'Hillsboro',
                        state: 'Oregon', countrycode: 'US' } },
        { properties: { housenumber: '2', street: 'Rue Test', city: 'Paris',
                        state: 'Ile-de-France', countrycode: 'FR' } },
      ] }),
    });
    try {
      const out = await addressModule.suggest('main st');
      assert.strictEqual(out.suggestions.length, 1);
      assert.strictEqual(out.suggestions[0].city, 'Hillsboro');
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('results with no street at all are dropped', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ features: [
        { properties: { name: 'Shute Park', city: 'Hillsboro', countrycode: 'US' } },
      ] }),
    });
    try {
      const out = await addressModule.suggest('shute');
      assert.strictEqual(out.suggestions.length, 0, 'a park is nowhere to drive to');
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('three characters are enough for type-ahead', async () => {
    let called = false;
    const realFetch = global.fetch;
    global.fetch = async () => {
      called = true;
      return { ok: true, json: async () => ({ features: [] }) };
    };
    try {
      await addressModule.suggest('120');
      assert.strictEqual(called, true, 'Photon should be asked from three characters');
    } finally {
      global.fetch = realFetch;
    }
  });

  console.log('\nZIP lookup');

  await test('a ZIP returns its city and state', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ places: [{ 'place name': 'Hillsboro', 'state abbreviation': 'OR' }] }),
    });
    try {
      const out = await addressModule.lookupZip('97123');
      assert.strictEqual(out.city, 'Hillsboro');
      assert.strictEqual(out.state, 'OR');
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('a malformed ZIP asks nothing', async () => {
    let called = false;
    const realFetch = global.fetch;
    global.fetch = async () => { called = true; throw new Error('no'); };
    try {
      assert.strictEqual(await addressModule.lookupZip('abc'), null);
      assert.strictEqual(await addressModule.lookupZip('123'), null);
      assert.strictEqual(called, false);
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('an unknown ZIP returns nothing rather than throwing', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('404'); };
    try {
      assert.strictEqual(await addressModule.lookupZip('00000'), null);
    } finally {
      global.fetch = realFetch;
    }
  });

  console.log('\nfailure handling');

  await test('a very short query asks nothing of the provider', async () => {
    let called = false;
    const realFetch = global.fetch;
    global.fetch = async () => { called = true; throw new Error('should not run'); };
    try {
      const out = await addressModule.suggest('12');
      assert.deepStrictEqual(out.suggestions, []);
      assert.strictEqual(called, false, 'no network call for two characters');
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('a provider outage returns an empty list, not an error', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('network down'); };
    try {
      const out = await addressModule.suggest('1200 SW Main St Hillsboro');
      assert.deepStrictEqual(out.suggestions, []);
      assert.strictEqual(out.error, 'lookup_unavailable');
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('a malformed provider response is survivable', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ nonsense: true }) });
    try {
      const out = await addressModule.suggest('1200 SW Main St Hillsboro');
      assert.deepStrictEqual(out.suggestions, []);
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('a good response comes back mapped', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ features: [{
        properties: {
          housenumber: '1200', street: 'SW Main St', city: 'Hillsboro',
          state: 'Oregon', postcode: '97123', countrycode: 'US',
        },
      }] }),
    });
    try {
      const out = await addressModule.suggest('1200 SW Main St');
      assert.strictEqual(out.suggestions.length, 1);
      assert.strictEqual(out.suggestions[0].zip, '97123');
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('at most five suggestions are returned', async () => {
    const realFetch = global.fetch;
    const many = Array.from({ length: 12 }, (_, i) => ({
      properties: {
        housenumber: String(i), street: 'Test St', city: 'Hillsboro',
        state: 'Oregon', countrycode: 'US',
      },
    }));
    global.fetch = async () => ({ ok: true, json: async () => ({ features: many }) });
    try {
      const out = await addressModule.suggest('test street');
      assert.strictEqual(out.suggestions.length, 5);
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('details are a Google-only concern', async () => {
    // Without a key the provider is Photon, which needs no details step.
    assert.strictEqual(addressModule.PROVIDER, 'photon');
    assert.strictEqual(await addressModule.details('anything'), null);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
