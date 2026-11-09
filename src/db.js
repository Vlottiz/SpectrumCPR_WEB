'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'booking.db');

/**
 * Storage layer, backed by node:sqlite (built into Node 22.5+).
 *
 * Nothing here compiles. The obvious choice, better-sqlite3, is a native addon
 * that ships prebuilt binaries per Node release — and on a Node version newer
 * than its latest build it falls back to compiling from C++, which on Windows
 * means installing Visual Studio just to run the project. node:sqlite avoids
 * that entirely.
 *
 * The db object returned by getDb() keeps the small slice of the
 * better-sqlite3 API this project actually used (prepare / exec / pragma /
 * transaction), so the rest of the codebase didn't have to change.
 *
 * Registration status lifecycle
 * -----------------------------
 *   held       seat is reserved while the student pays. expires at hold_expires_at.
 *   confirmed  payment cleared. occupies a seat permanently.
 *   expired    hold ran out before payment. frees the seat.
 *   cancelled  student or admin cancelled. frees the seat.
 *   waitlist   class was full at signup. not occupying a seat.
 *   offered    a seat opened and we offered it to this waitlist entry.
 *              occupies a seat until offer_expires_at, so it can't be taken
 *              out from under them while they respond.
 *
 * A seat is "taken" when status is confirmed, or when it's an unexpired
 * held/offered row. Expiry is evaluated lazily in the availability query, so
 * seat counts stay correct even if the background sweeper isn't running.
 */

const SCHEMA = `
-- A row here is a TRAINING DAY, not a single class.
--
-- The business travels to the customer, so the instructor publishes a day they
-- are available along with the hours they will work. Customers book a session
-- inside that window at their own address. starts_at / ends_at are therefore
-- the open and close times of the day, not one class's start and finish.
--
-- capacity is how many people the instructor is willing to train that day in
-- total, across every visit — limited by manikins, cards and stamina.
CREATE TABLE IF NOT EXISTS classes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  course_code     TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  starts_at       TEXT    NOT NULL,           -- day opens (ISO 8601 UTC)
  ends_at         TEXT    NOT NULL,           -- day closes
  location        TEXT    NOT NULL DEFAULT '',
  capacity        INTEGER NOT NULL CHECK (capacity > 0),
  price_cents     INTEGER NOT NULL CHECK (price_cents >= 0),

  -- Group pricing, as JSON. A small booking costs the same to drive to and
  -- set up as a full one, so party size moves the per-person price. NULL means
  -- the defaults in seats.js apply.
  pricing_tiers   TEXT,

  -- Legacy: ZIP codes a day would travel to. Replaced by travel zones and no
  -- longer read; kept so older databases don't need the column dropped.
  service_zips    TEXT,

  -- How many trips into each travel zone this day allows, as JSON:
  -- {"1": null, "2": 3, "3": 1}. null or missing means no limit; 0 means the
  -- zone is closed that day. Counted per calendar date, so two days sharing a
  -- date share the limit — see zoneTripsLeft() in seats.js.
  zone_limits     TEXT,

  -- The repeating schedule that created this day, if any. NULL for days
  -- added by hand.
  schedule_id     INTEGER,
  status          TEXT    NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','cancelled')),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_classes_starts_at ON classes (starts_at);

CREATE TABLE IF NOT EXISTS registrations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  public_ref        TEXT    NOT NULL UNIQUE,  -- shown to the student, e.g. SPC-8F3K2Q
  class_id          INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  status            TEXT    NOT NULL
                            CHECK (status IN ('held','confirmed','expired','cancelled','waitlist','offered')),

  student_name      TEXT    NOT NULL,
  student_email     TEXT    NOT NULL,
  student_phone     TEXT    NOT NULL DEFAULT '',
  notes             TEXT    NOT NULL DEFAULT '',

  amount_cents      INTEGER NOT NULL,         -- per-seat price, copied at hold time

  -- Where the instructor is going, and when. Every seat in one booking shares
  -- both: it's one visit to one address.
  slot_start        TEXT,                     -- session start (ISO 8601 UTC)
  address           TEXT    NOT NULL DEFAULT '',
  address_notes     TEXT    NOT NULL DEFAULT '',  -- gate codes, parking, suite

  -- Travel zone of the address and what the trip costs. Every seat in a
  -- booking carries the zone and distance; only the organiser's seat
  -- (seat_index 0) carries the charge, since it's one trip.
  travel_zone       INTEGER,
  travel_miles      REAL,
  travel_cents      INTEGER NOT NULL DEFAULT 0,

  -- Group bookings: one organiser reserves several seats in one payment.
  -- Every seat is still its own row (each attendee needs their own name on
  -- the roster and their own certification card), tied together by group_ref.
  group_ref         TEXT,                     -- NULL for a solo booking
  seat_index        INTEGER NOT NULL DEFAULT 0,  -- 0 = organiser's own seat
  organiser_name    TEXT,                     -- who booked, when not attending


  hold_expires_at   TEXT,                     -- set while status='held'
  offer_expires_at  TEXT,                     -- set while status='offered'

  payment_provider  TEXT,                     -- 'mock' | 'converge'
  payment_ref       TEXT,                     -- Converge ssl_txn_id / order id
  payment_raw       TEXT,                     -- JSON blob of the gateway response

  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  confirmed_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_reg_class_status ON registrations (class_id, status);
-- idx_reg_group is created in migrate(), after the column is guaranteed to
-- exist. Putting it here breaks upgrades: on a database made before group
-- bookings, SCHEMA runs first and the column isn't there yet.
CREATE INDEX IF NOT EXISTS idx_reg_holds        ON registrations (status, hold_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reg_payment_ref
  ON registrations (payment_provider, payment_ref)
  WHERE payment_ref IS NOT NULL;

-- Append-only audit trail. Useful when a student swears they paid.
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  registration_id INTEGER REFERENCES registrations(id) ON DELETE CASCADE,
  class_id        INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL,
  detail          TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Repeating weekly schedules. Each keeps weeks_ahead weeks of days open,
-- adding new ones as time moves on, so the calendar never runs dry.
--
--   courses  JSON [{ "code": "CPR", "title": "CPR / AED", "priceCents": 8500 }]
--   week     JSON, 7 entries Sunday first: { "on": true, "open": "09:00", "close": "17:00" }
--            times are wall-clock in BUSINESS_TZ
--   filled_through  the last date (YYYY-MM-DD) days have been created up to
CREATE TABLE IF NOT EXISTS schedules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  courses         TEXT    NOT NULL,
  week            TEXT    NOT NULL,
  weeks_ahead     INTEGER NOT NULL DEFAULT 8,
  capacity        INTEGER NOT NULL CHECK (capacity > 0),
  pricing_tiers   TEXT,
  zone_limits     TEXT,
  starts_on       TEXT    NOT NULL,
  filled_through  TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Dates a schedule must not recreate: a day from it that was cancelled and
-- cleared. Without this, the next fill would put it straight back.
CREATE TABLE IF NOT EXISTS schedule_skips (
  schedule_id     INTEGER NOT NULL,
  day             TEXT    NOT NULL,           -- YYYY-MM-DD
  course_code     TEXT    NOT NULL,
  PRIMARY KEY (schedule_id, day, course_code)
);

-- Time off: dates the instructor isn't working. Inclusive, YYYY-MM-DD.
CREATE TABLE IF NOT EXISTS time_off (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_on       TEXT    NOT NULL,
  ends_on         TEXT    NOT NULL,
  note            TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- How many trainers are working on a date, where it differs from the usual
-- number (settings.default_trainers). Each trainer can run one visit at a
-- time, so two trainers means two overlapping bookings are fine. 0 means
-- nobody is available that date.
CREATE TABLE IF NOT EXISTS trainer_days (
  day             TEXT    PRIMARY KEY,        -- YYYY-MM-DD
  trainers        INTEGER NOT NULL CHECK (trainers >= 0)
);

-- Small site-wide settings, e.g. min_notice_hours.
CREATE TABLE IF NOT EXISTS settings (
  key             TEXT    PRIMARY KEY,
  value           TEXT    NOT NULL
);

-- Outbound email queue. Nothing sends yet; the client's mail provider
-- plugs in here later. Keeps a record of what *should* have gone out.
CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  registration_id INTEGER REFERENCES registrations(id) ON DELETE SET NULL,
  to_email        TEXT    NOT NULL,
  subject         TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  sent_at         TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
`;

let _db = null;      // the wrapper handed to callers
let _raw = null;     // the underlying DatabaseSync
let _txDepth = 0;

/**
 * Run fn inside a write transaction.
 *
 * BEGIN IMMEDIATE takes SQLite's write lock up front rather than on first
 * write, so a read-then-write sequence (count the seats, then take one) can't
 * interleave with another caller doing the same thing. That is what stops a
 * class being oversold.
 *
 * Nested calls join the outer transaction rather than opening a second one.
 */
function transaction(fn, ...args) {
  const raw = _raw || (getDb(), _raw);

  if (_txDepth > 0) {
    _txDepth++;
    try {
      return fn(...args);
    } finally {
      _txDepth--;
    }
  }

  raw.exec('BEGIN IMMEDIATE');
  _txDepth = 1;
  try {
    const result = fn(...args);
    raw.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      raw.exec('ROLLBACK');
    } catch {
      // Rollback can fail if the transaction already unwound. The original
      // error is the more useful one, so don't mask it.
    }
    throw err;
  } finally {
    _txDepth = 0;
  }
}

function wrap(raw) {
  return {
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
    pragma: (stmt) => raw.exec(`PRAGMA ${stmt}`),

    /**
     * better-sqlite3 shape: db.transaction(fn) returns a callable, and that
     * callable also carries .immediate() / .deferred() / .exclusive().
     * Every mode here uses BEGIN IMMEDIATE, which is the strictest of the
     * three and the one this project relies on.
     */
    transaction: (fn) => {
      const wrapped = (...args) => transaction(fn, ...args);
      wrapped.immediate = wrapped;
      wrapped.deferred = wrapped;
      wrapped.exclusive = wrapped;
      return wrapped;
    },
  };
}

function getDb() {
  if (_db) return _db;

  const fs = require('fs');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  _raw = new DatabaseSync(DB_PATH);
  _raw.exec('PRAGMA journal_mode = WAL');
  _raw.exec('PRAGMA foreign_keys = ON');
  // If another connection holds the write lock, wait rather than throwing.
  _raw.exec('PRAGMA busy_timeout = 5000');
  _raw.exec(SCHEMA);
  migrate(_raw);

  _db = wrap(_raw);
  return _db;
}

/**
 * Bring an older database up to date.
 *
 * CREATE TABLE IF NOT EXISTS leaves an existing table alone, so columns added
 * after the first release have to be patched in here. Each step checks before
 * it acts, so running this on an up-to-date database does nothing.
 */
function migrate(raw) {
  const columns = raw.prepare('PRAGMA table_info(registrations)').all().map((c) => c.name);

  const additions = [
    ['group_ref', 'ALTER TABLE registrations ADD COLUMN group_ref TEXT'],
    ['seat_index', 'ALTER TABLE registrations ADD COLUMN seat_index INTEGER NOT NULL DEFAULT 0'],
    ['organiser_name', 'ALTER TABLE registrations ADD COLUMN organiser_name TEXT'],
    ['slot_start', 'ALTER TABLE registrations ADD COLUMN slot_start TEXT'],
    ['address', "ALTER TABLE registrations ADD COLUMN address TEXT NOT NULL DEFAULT ''"],
    ['address_notes', "ALTER TABLE registrations ADD COLUMN address_notes TEXT NOT NULL DEFAULT ''"],
    ['travel_zone', 'ALTER TABLE registrations ADD COLUMN travel_zone INTEGER'],
    ['travel_miles', 'ALTER TABLE registrations ADD COLUMN travel_miles REAL'],
    ['travel_cents', 'ALTER TABLE registrations ADD COLUMN travel_cents INTEGER NOT NULL DEFAULT 0'],
  ];

  const classColumns = raw.prepare('PRAGMA table_info(classes)').all().map((c) => c.name);
  if (!classColumns.includes('pricing_tiers')) {
    raw.exec('ALTER TABLE classes ADD COLUMN pricing_tiers TEXT');
    console.log('[db] added classes.pricing_tiers');
  }
  if (!classColumns.includes('service_zips')) {
    raw.exec('ALTER TABLE classes ADD COLUMN service_zips TEXT');
    console.log('[db] added classes.service_zips');
  }
  if (!classColumns.includes('schedule_id')) {
    raw.exec('ALTER TABLE classes ADD COLUMN schedule_id INTEGER');
    console.log('[db] added classes.schedule_id');
  }
  if (!classColumns.includes('zone_limits')) {
    raw.exec('ALTER TABLE classes ADD COLUMN zone_limits TEXT');
    console.log('[db] added classes.zone_limits');
  }

  for (const [name, sql] of additions) {
    if (!columns.includes(name)) {
      raw.exec(sql);
      console.log(`[db] added registrations.${name}`);
    }
  }

  raw.exec('CREATE INDEX IF NOT EXISTS idx_reg_group ON registrations (group_ref)');
  raw.exec('CREATE INDEX IF NOT EXISTS idx_reg_slot ON registrations (class_id, slot_start)');

  // Bookings made before slots existed have no time of their own; treat them
  // as starting when their day opened so they still occupy the calendar.
  raw.exec(`UPDATE registrations
               SET slot_start = (SELECT starts_at FROM classes WHERE classes.id = registrations.class_id)
             WHERE slot_start IS NULL
               AND status IN ('held','confirmed','offered')`);
}

function closeDb() {
  if (_raw) {
    _raw.close();
    _raw = null;
    _db = null;
    _txDepth = 0;
  }
}

module.exports = { getDb, closeDb, transaction, DB_PATH };
