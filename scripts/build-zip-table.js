'use strict';

/**
 * Rebuilds src/zip-centroids.json — the ZIP code locations used to work out
 * which travel zone a customer is in.
 *
 * Only needed if the home ZIP or the outer zone edge ever changes. The data
 * comes from the `zipcodes` npm package (BSD licence). It's read as plain text
 * rather than loaded as code, and isn't a runtime dependency:
 *
 *   npm pack zipcodes && tar xzf zipcodes-*.tgz
 *   node scripts/build-zip-table.js package/lib/codes.js [radiusMiles]
 *
 * Every ZIP within the radius (default 100 miles) of the home ZIP is kept, so
 * a ZIP missing from the table is simply further away than that.
 */

const fs = require('fs');
const path = require('path');
const { HOME_ZIP, milesBetween } = require('../src/zones');

const source = process.argv[2];
const RADIUS_MILES = Number(process.argv[3] || 100);
if (!source) {
  console.error('usage: node scripts/build-zip-table.js <path to zipcodes/lib/codes.js> [radiusMiles]');
  process.exit(1);
}

const text = fs.readFileSync(source, 'utf8');
const ROW = /"zip":"(\d{5})","latitude":(-?[\d.]+),"longitude":(-?[\d.]+),"city":"([^"]*)","state":"([A-Z]{2})","country":"US"/g;

const all = {};
for (const m of text.matchAll(ROW)) {
  all[m[1]] = { lat: Number(m[2]), lon: Number(m[3]), city: m[4], state: m[5] };
}

const home = all[HOME_ZIP];
if (!home) throw new Error(`Home ZIP ${HOME_ZIP} is not in ${source}`);

const out = {};
for (const [zip, z] of Object.entries(all).sort(([a], [b]) => a.localeCompare(b))) {
  if (milesBetween(home.lat, home.lon, z.lat, z.lon) <= RADIUS_MILES) {
    out[zip] = [Number(z.lat.toFixed(4)), Number(z.lon.toFixed(4)), z.city, z.state];
  }
}

const file = path.join(__dirname, '..', 'src', 'zip-centroids.json');
fs.writeFileSync(file, JSON.stringify(out) + '\n');
console.log(`Read ${Object.keys(all).length} ZIPs; wrote ${Object.keys(out).length} within ` +
            `${RADIUS_MILES} miles of ${HOME_ZIP} to ${file}`);
