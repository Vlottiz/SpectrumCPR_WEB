'use strict';

/**
 * Address lookup.
 *
 * Three providers, picked by ADDRESS_PROVIDER or inferred from what's
 * configured:
 *
 *   photon  (default, free, no key)
 *     OpenStreetMap data served by komoot's Photon, which is built for
 *     type-ahead. Suggestions appear from a few characters, which is the
 *     DoorDash-style behaviour, at no cost. House-number coverage is good in
 *     towns and patchier in rural areas, since it's whatever OSM contributors
 *     have mapped. Komoot ask that heavy users self-host.
 *
 *   census  (free, no key)
 *     The US Census Bureau geocoder — authoritative for US addresses and the
 *     better validator, but a geocoder rather than an autocomplete. It wants a
 *     street number and name before it matches, so it behaves like "tidy what
 *     I typed" rather than "guess from three letters".
 *
 *   google  (set GOOGLE_PLACES_KEY)
 *     Places Autocomplete. The most complete coverage and the smoothest
 *     type-ahead. Bills per session.
 *
 * All are proxied through this server rather than called from the browser, so
 * a key never reaches the page and CORS is not in play.
 *
 * Separately, a ZIP code alone can fill city and state — that path needs no
 * street at all and works with every provider.
 */

const PROVIDER = (process.env.ADDRESS_PROVIDER
  || (process.env.GOOGLE_PLACES_KEY ? 'google' : 'photon')).toLowerCase();

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const CENSUS_BENCHMARK = process.env.CENSUS_BENCHMARK || 'Public_AR_Current';

const GOOGLE_AUTOCOMPLETE = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
const GOOGLE_DETAILS = 'https://maps.googleapis.com/maps/api/place/details/json';

const PHOTON_URL = 'https://photon.komoot.io/api/';
const ZIP_URL = 'https://api.zippopotam.us/us/';

// Photon ranks by distance from a bias point, so results near the business
// come first. Defaults to Hillsboro, Oregon.
const BIAS_LAT = Number(process.env.ADDRESS_BIAS_LAT || 45.5229);
const BIAS_LON = Number(process.env.ADDRESS_BIAS_LON || -122.9898);

// Keeps a stray user from turning the booking form into a geocoding bill.
const TIMEOUT_MS = Number(process.env.ADDRESS_TIMEOUT_MS || 4000);

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`lookup failed (${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Census address components -> the shape the booking form expects. */
function fromCensus(match) {
  const c = match.addressComponents || {};
  const street = [
    c.fromAddress,
    c.preQualifier, c.preDirection, c.preType,
    c.streetName,
    c.suffixType, c.suffixDirection, c.suffixQualifier,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  return {
    label: match.matchedAddress,
    street,
    city: c.city || '',
    state: c.state || '',
    zip: c.zip || '',
  };
}

/** Photon GeoJSON feature -> the shape the booking form expects. */
function fromPhoton(feature) {
  const p = feature.properties || {};
  const street = [p.housenumber, p.street || p.name].filter(Boolean).join(' ').trim();
  const city = p.city || p.town || p.village || p.district || '';

  return {
    label: [street || p.name, city, [p.state, p.postcode].filter(Boolean).join(' ')]
      .filter(Boolean).join(', '),
    street,
    city,
    state: US_STATE_ABBR[p.state] || (p.state && p.state.length === 2 ? p.state : ''),
    zip: p.postcode || '',
  };
}

async function photonSuggest(query) {
  const url = `${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=8&lang=en` +
              `&lat=${BIAS_LAT}&lon=${BIAS_LON}`;
  const data = await fetchJson(url);

  return (data.features || [])
    // Photon has no country filter, so US results are kept after the fact.
    .filter((f) => (f.properties || {}).countrycode === 'US')
    // A suggestion with no street is a city or a park, not somewhere to drive.
    .filter((f) => (f.properties || {}).street || (f.properties || {}).housenumber)
    .slice(0, 5)
    .map(fromPhoton);
}

async function censusSuggest(query) {
  const url = `${CENSUS_URL}?address=${encodeURIComponent(query)}` +
              `&benchmark=${encodeURIComponent(CENSUS_BENCHMARK)}&format=json`;
  const data = await fetchJson(url);
  const matches = data?.result?.addressMatches || [];
  return matches.slice(0, 5).map(fromCensus);
}

/**
 * Google returns predictions without components, so a second call is needed
 * for the picked one. Suggestions therefore carry a placeId, and the page asks
 * for details only once the customer chooses.
 */
async function googleSuggest(query) {
  const key = process.env.GOOGLE_PLACES_KEY;
  const url = `${GOOGLE_AUTOCOMPLETE}?input=${encodeURIComponent(query)}` +
              `&types=address&components=country:us&key=${key}`;
  const data = await fetchJson(url);

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Places: ${data.status}`);
  }
  return (data.predictions || []).slice(0, 5).map((p) => ({
    label: p.description,
    placeId: p.place_id,
    street: '',
    city: '',
    state: '',
    zip: '',
  }));
}

async function googleDetails(placeId) {
  const key = process.env.GOOGLE_PLACES_KEY;
  const url = `${GOOGLE_DETAILS}?place_id=${encodeURIComponent(placeId)}` +
              `&fields=address_component,formatted_address&key=${key}`;
  const data = await fetchJson(url);
  if (data.status !== 'OK') throw new Error(`Places details: ${data.status}`);

  const parts = data.result.address_components || [];
  const get = (type, short = false) => {
    const hit = parts.find((p) => p.types.includes(type));
    return hit ? (short ? hit.short_name : hit.long_name) : '';
  };

  const street = [get('street_number'), get('route')].filter(Boolean).join(' ');
  return {
    label: data.result.formatted_address,
    street,
    city: get('locality') || get('sublocality') || get('postal_town'),
    state: get('administrative_area_level_1', true),
    zip: get('postal_code'),
  };
}

// Photon returns full state names; the form wants the postal abbreviation.
const US_STATE_ABBR = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS',
  Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
  Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI',
  Wyoming: 'WY', 'District of Columbia': 'DC',
};

/**
 * City and state for a ZIP code.
 *
 * Worth having on its own: somebody who knows their ZIP gets two fields filled
 * instantly, with no street matching involved and nothing to pay.
 */
async function lookupZip(zip) {
  const clean = String(zip || '').trim().slice(0, 5);
  if (!/^\d{5}$/.test(clean)) return null;

  try {
    const data = await fetchJson(ZIP_URL + clean);
    const place = (data.places || [])[0];
    if (!place) return null;
    return {
      city: place['place name'] || '',
      state: place['state abbreviation'] || '',
      zip: clean,
    };
  } catch (err) {
    console.warn('[address] ZIP lookup failed:', err.message);
    return null;
  }
}

/** Suggestions for a partially typed address. Never throws. */
async function suggest(query) {
  const q = String(query || '').trim();
  // Photon can work from three characters; Census needs a fuller address.
  const minimum = PROVIDER === 'census' ? 5 : 3;
  if (q.length < minimum) return { provider: PROVIDER, suggestions: [] };

  try {
    const suggestions =
      PROVIDER === 'google' ? await googleSuggest(q)
      : PROVIDER === 'census' ? await censusSuggest(q)
      : await photonSuggest(q);
    return { provider: PROVIDER, suggestions };
  } catch (err) {
    // A lookup outage must not block a booking — the customer can still type
    // the address by hand.
    console.warn('[address] lookup failed:', err.message);
    return { provider: PROVIDER, suggestions: [], error: 'lookup_unavailable' };
  }
}

/** Fill in the components for a Google prediction. */
async function details(placeId) {
  if (PROVIDER !== 'google') return null;
  try {
    return await googleDetails(placeId);
  } catch (err) {
    console.warn('[address] details failed:', err.message);
    return null;
  }
}

module.exports = { suggest, details, lookupZip, PROVIDER, fromCensus, fromPhoton };
