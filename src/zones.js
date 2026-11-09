'use strict';

/**
 * Travel zones.
 *
 * The instructor drives out from Forest Grove (ZIP 97116). How far the
 * customer is from there, as the crow flies between ZIP code centres, decides
 * their zone, and the zone decides the travel charge:
 *
 *   Zone 1   0 – 25 miles        no travel charge
 *   Zone 2   25.01 – 50 miles    $50
 *   Zone 3   50.01 – 90 miles    $100
 *
 * Anything past 90 miles is outside the area and can't be booked online.
 *
 * Distances are straight-line between ZIP centroids, so no paid maps service
 * is involved. The centroids live in zip-centroids.json, which holds every ZIP
 * within 100 miles of home — a ZIP not in the table is further than that.
 * scripts/build-zip-table.js rebuilds it.
 *
 * The travel charge is per visit, not per person: one trip, one charge,
 * whether the instructor trains one person or twelve.
 */

const HOME_ZIP = process.env.HOME_ZIP || '97116';

// Ordered nearest first; the first zone whose maxMiles covers the distance wins.
const ZONES = [
  { zone: 1, minMiles: 0,     maxMiles: 25, feeCents: 0 },
  { zone: 2, minMiles: 25.01, maxMiles: 50, feeCents: 5000 },
  { zone: 3, minMiles: 50.01, maxMiles: 90, feeCents: 10000 },
];

const MAX_MILES = ZONES[ZONES.length - 1].maxMiles;

let table = null;
function centroids() {
  if (!table) {
    try {
      table = require('./zip-centroids.json');
    } catch {
      // Without the table nobody can be placed in a zone, which blocks every
      // booking — loud in the log, not a crash.
      console.error('[zones] src/zip-centroids.json is missing — run scripts/build-zip-table.js');
      table = {};
    }
  }
  return table;
}

const EARTH_RADIUS_MILES = 3958.8;

/** Great-circle distance in miles. */
function milesBetween(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a));
}

const cleanZip = (zip) => String(zip ?? '').trim().slice(0, 5);

/** The zone a distance falls in, or null when it is past the last one. */
function zoneForMiles(miles) {
  // Compared at two decimals, matching how the bands are written: 25.004
  // miles is 25.00 and so still Zone 1.
  const m = Math.round(miles * 100) / 100;
  return ZONES.find((z) => m <= z.maxMiles) || null;
}

/**
 * Where a ZIP code sits relative to home.
 *
 *   { ok: true, zip, zone, miles, feeCents, city, state }
 *   { ok: false, reason: 'zip_invalid' }
 *   { ok: false, reason: 'outside_area', miles? }
 */
function zoneForZip(zip) {
  const z = cleanZip(zip);
  if (!/^\d{5}$/.test(z)) return { ok: false, reason: 'zip_invalid', zip: z || null };

  const data = centroids();
  const home = data[HOME_ZIP];
  const here = data[z];

  if (!home) return { ok: false, reason: 'outside_area', zip: z };
  if (!here) return { ok: false, reason: 'outside_area', zip: z, miles: null };

  const miles = Math.round(milesBetween(home[0], home[1], here[0], here[1]) * 10) / 10;
  const band = zoneForMiles(miles);
  if (!band) {
    return { ok: false, reason: 'outside_area', zip: z, miles, city: here[2], state: here[3] };
  }
  return {
    ok: true,
    zip: z,
    zone: band.zone,
    miles,
    feeCents: band.feeCents,
    city: here[2] || '',
    state: here[3] || '',
  };
}

/** The zone table, for showing customers and staff. */
function describeZones() {
  return ZONES.map((z) => ({ ...z }));
}

function feeForZone(zone) {
  const band = ZONES.find((z) => z.zone === Number(zone));
  return band ? band.feeCents : null;
}

module.exports = {
  HOME_ZIP,
  ZONES,
  MAX_MILES,
  milesBetween,
  zoneForMiles,
  zoneForZip,
  describeZones,
  feeForZone,
};
