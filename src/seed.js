'use strict';

const { getDb } = require('./db');

/**
 * Sample training days so the API has something to serve during development.
 *
 * Each row is a day the instructor is available and the hours they'll work.
 * Customers book two-hour sessions inside that window at their own address.
 * Prices are placeholders — the client sets real ones.
 */

function daysFromNow(n, hour, minute = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

// 16:00–02:00 UTC, which is 9am–7pm Pacific in summer and 8am–6pm in winter —
// a fixed UTC offset drifts with daylight saving. Sample data only; the client
// sets real hours per day in the admin page, entering them in local time.
const WORKDAY = { open: 16, close: 26 };

const CLASSES = [
  {
    course_code: 'CPR', title: 'CPR / AED',
    starts_at: daysFromNow(5, WORKDAY.open), ends_at: daysFromNow(5, WORKDAY.close),
    location: '', capacity: 20, price_cents: 8500,
  },
  {
    course_code: 'HEARTSAVER', title: 'Heartsaver CPR / AED / First Aid',
    starts_at: daysFromNow(8, WORKDAY.open), ends_at: daysFromNow(8, WORKDAY.close),
    location: '', capacity: 24, price_cents: 9500,
  },
  {
    course_code: 'BABYSIT', title: 'Babysitter Safety',
    starts_at: daysFromNow(12, WORKDAY.open), ends_at: daysFromNow(12, WORKDAY.close),
    location: '', capacity: 24, price_cents: 5500,
  },
  // A second CPR day, so "another day" suggestions have somewhere to point.
  {
    course_code: 'CPR', title: 'CPR / AED',
    starts_at: daysFromNow(19, WORKDAY.open), ends_at: daysFromNow(19, WORKDAY.close),
    location: '', capacity: 20, price_cents: 8500,
  },
];

function seed() {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) AS n FROM classes').get().n;

  if (existing > 0 && !process.argv.includes('--force')) {
    console.log(`${existing} training days already exist. Use --force to add the sample set anyway.`);
    return;
  }

  const insert = db.prepare(
    `INSERT INTO classes
       (course_code, title, starts_at, ends_at, location, capacity, price_cents)
     VALUES (@course_code, @title, @starts_at, @ends_at, @location, @capacity, @price_cents)`
  );

  const many = db.transaction((rows) => rows.forEach((r) => insert.run(r)));
  many(CLASSES);

  console.log(`Seeded ${CLASSES.length} training days.`);
  for (const c of db.prepare('SELECT id, title, starts_at, ends_at FROM classes').all()) {
    const day = new Date(c.starts_at).toISOString().slice(0, 10);
    const open = new Date(c.starts_at).toISOString().slice(11, 16);
    const close = new Date(c.ends_at).toISOString().slice(11, 16);
    console.log(`  ${c.id}  ${day}  ${open}-${close} UTC  ${c.title}`);
  }
}

if (require.main === module) seed();

module.exports = { seed, CLASSES };
