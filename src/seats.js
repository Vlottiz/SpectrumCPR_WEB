'use strict';

const crypto = require('crypto');
const { getDb } = require('./db');
const zones = require('./zones');

const HOLD_MINUTES = Number(process.env.HOLD_MINUTES || 20);
const OFFER_HOURS = Number(process.env.OFFER_HOURS || 24);

// Cap on a single group booking. Large enough for a daycare or dental practice,
// small enough that a typo can't reserve a whole day.
const MAX_GROUP_SEATS = Number(process.env.MAX_GROUP_SEATS || 12);

// How long the instructor is on site teaching.
const SESSION_MINUTES = Number(process.env.SESSION_MINUTES || 240);

// Setting up beforehand, packing down and driving to the next customer. Added
// to the session, so a booking occupies 5.5 hours of the calendar even though
// the customer has the instructor for 4.
const BUFFER_MINUTES = Number(process.env.BUFFER_MINUTES || 90);

// Spacing of the offered start times.
const SLOT_STEP_MINUTES = Number(process.env.SLOT_STEP_MINUTES || 30);

const BLOCK_MINUTES = SESSION_MINUTES + BUFFER_MINUTES;

// The business's own timezone. "Per day" limits are counted by the calendar
// date here, not by UTC — a 5pm Pacific visit is 01:00 UTC the next day.
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'America/Los_Angeles';

// ---------------------------------------------------------------- time utils

function nowIso() {
  return new Date().toISOString();
}

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function addHours(iso, hours) {
  return addMinutes(iso, hours * 60);
}

// Unambiguous characters only — these get read over the phone.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeRef() {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (const b of bytes) out += REF_ALPHABET[b % REF_ALPHABET.length];
  return `SPC-${out}`;
}

// ------------------------------------------------------------- availability

/**
 * Seats taken = confirmed rows + unexpired held rows + unexpired offered rows.
 *
 * Expiry is evaluated here against `now` rather than trusting a status column,
 * so an un-swept expired hold never blocks a seat. The sweeper is a tidy-up
 * job, not a correctness dependency.
 */
const TAKEN_SQL = `
  SELECT COUNT(*) AS n FROM registrations
   WHERE class_id = @classId
     AND (
           status = 'confirmed'
        OR (status = 'held'    AND hold_expires_at  > @now)
        OR (status = 'offered' AND offer_expires_at > @now)
     )
`;

function getClass(classId) {
  return getDb().prepare('SELECT * FROM classes WHERE id = ?').get(classId);
}

function availability(classId, now = nowIso()) {
  const db = getDb();
  const cls = getClass(classId);
  if (!cls) return null;

  const taken = db.prepare(TAKEN_SQL).get({ classId, now }).n;
  const waitlist = db
    .prepare(`SELECT COUNT(*) AS n FROM registrations
               WHERE class_id = ? AND status = 'waitlist'`)
    .get(classId).n;

  return {
    classId,
    capacity: cls.capacity,
    taken,
    available: Math.max(0, cls.capacity - taken),
    waitlist,
    isFull: cls.capacity - taken <= 0,
    status: cls.status,
  };
}




// -------------------------------------------------------------- travel zones

/** "2026-11-16" — the calendar date of an instant, in the business's timezone. */
function localDate(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

/**
 * How many trips into each zone a day allows: { 1: null, 2: 3, 3: 1 }.
 *
 * null is no limit, which is also the default — a day with nothing set
 * should be bookable rather than closed. 0 closes that zone for the day.
 */
function zoneLimitsFor(cls) {
  const out = {};
  for (const z of zones.ZONES) out[z.zone] = null;
  if (!cls || !cls.zone_limits) return out;
  try {
    const parsed = JSON.parse(cls.zone_limits) || {};
    for (const z of zones.ZONES) {
      const v = parsed[z.zone];
      if (Number.isInteger(v) && v >= 0) out[z.zone] = v;
    }
  } catch {
    // Unreadable limits shouldn't close a day; treat it as unlimited.
    console.warn(`[zones] class ${cls.id} has unreadable zone_limits, treating as unlimited`);
  }
  return out;
}

/** Open days that fall on the same calendar date as this one, itself included. */
function sameDateClasses(db, cls) {
  const date = localDate(cls.starts_at);
  const from = addMinutes(cls.starts_at, -36 * 60);
  const to = addMinutes(cls.starts_at, 36 * 60);
  const rows = db
    .prepare(`SELECT * FROM classes
               WHERE (status = 'open' OR id = ?) AND starts_at BETWEEN ? AND ?`)
    .all(cls.id, from, to)
    .filter((c) => localDate(c.starts_at) === date);
  return rows.some((c) => c.id === cls.id) ? rows : [cls, ...rows];
}

/**
 * Trips into one zone still available on a day's date.
 *
 * The limit is per calendar date, not per day row or per time slot: it exists
 * so the instructor isn't sent to opposite edges of Zone 3 on the same day.
 * If two days share a date (say a CPR day and a Babysitter day), their trips
 * are counted together and the stricter limit applies.
 *
 * A trip is one visit — a group of six at one address is one trip.
 *
 *   { zone, date, limit, used, left }   limit and left are null when unlimited
 */
function zoneTripsLeft(classId, zone, { now = nowIso(), db = getDb() } = {}) {
  const cls = getClass(classId);
  if (!cls) return null;

  const siblings = sameDateClasses(db, cls);
  const limits = siblings
    .map((c) => zoneLimitsFor(c)[zone])
    .filter((v) => v !== null && v !== undefined);
  const limit = limits.length ? Math.min(...limits) : null;

  const ids = siblings.map((c) => c.id);
  const used = db
    .prepare(
      `SELECT COUNT(DISTINCT COALESCE(group_ref, public_ref)) AS n
         FROM registrations
        WHERE class_id IN (${ids.map(() => '?').join(',')})
          AND travel_zone = ?
          AND (
                status = 'confirmed'
             OR (status = 'held'    AND hold_expires_at  > ?)
             OR (status = 'offered' AND offer_expires_at > ?)
          )`
    )
    .get(...ids, zone, now, now).n;

  return {
    zone,
    date: localDate(cls.starts_at),
    limit,
    used,
    left: limit === null ? null : Math.max(0, limit - used),
  };
}

/** Pull a ZIP off the end of a one-line address, for callers that only sent that. */
function zipFromAddress(address) {
  const m = String(address || '').match(/\b(\d{5})(?:-\d{4})?\s*$/);
  return m ? m[1] : '';
}

// --------------------------------------------------------------- pricing

/**
 * Group pricing.
 *
 * The cost of a visit is mostly fixed — the drive, unloading manikins and AED
 * trainers, setting up, packing down — and that cost is the same whether one
 * person or eight is trained. So a very small booking carries a surcharge to
 * cover it, and larger groups share it out and pay less each.
 *
 * Tiers are matched by party size, first match winning, so they must be
 * ordered smallest first. adjustPct is applied to the day's base price:
 * positive adds, negative discounts.
 */
const DEFAULT_TIERS = [
  {
    minSize: 1,
    maxSize: 2,
    adjustPct: 10,
    label: 'Small group rate',
    reason: 'A visit costs the same to travel to and set up whether it trains '
          + 'two people or eight, so smaller bookings carry a share of that.',
  },
  {
    minSize: 3,
    maxSize: 4,
    adjustPct: -5,
    label: 'Group discount',
    reason: 'Three or more makes the trip worthwhile, so the per-person price '
          + 'comes down.',
  },
  {
    minSize: 5,
    maxSize: null,          // null = no upper bound
    adjustPct: -10,
    label: 'Large group discount',
    reason: 'Our best rate — one visit, more people trained, less cost each.',
  },
];

/** A day's tiers, or the defaults when it has none of its own. */
function tiersFor(cls) {
  if (!cls || !cls.pricing_tiers) return DEFAULT_TIERS;
  try {
    const parsed = JSON.parse(cls.pricing_tiers);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    // A day with unreadable pricing should still be bookable at the base
    // price rather than failing outright.
    console.warn(`[pricing] class ${cls.id} has unreadable tiers, using defaults`);
  }
  return DEFAULT_TIERS;
}

function matchTier(tiers, partySize) {
  return tiers.find((t) =>
    partySize >= (t.minSize ?? 1) &&
    (t.maxSize === null || t.maxSize === undefined || partySize <= t.maxSize)) || null;
}

/**
 * What a party of this size pays.
 *
 * Rounded per seat rather than on the total, so the price each person is
 * quoted is the price each person is charged — a total split unevenly across
 * a roster is impossible to explain to a customer.
 */
function priceFor(cls, partySize) {
  const base = cls.price_cents;
  const tier = matchTier(tiersFor(cls), partySize);
  const adjustPct = tier ? Number(tier.adjustPct) || 0 : 0;

  const perSeatCents = Math.round(base * (1 + adjustPct / 100));

  return {
    baseCents: base,
    perSeatCents,
    totalCents: perSeatCents * partySize,
    adjustPct,
    savingCents: (base - perSeatCents) * partySize,   // negative when a surcharge
    label: tier ? tier.label : null,
    reason: tier ? tier.reason : null,
  };
}

/** The whole ladder, for showing a customer what a bigger group would cost. */
function priceLadder(cls, maxSize = MAX_GROUP_SEATS) {
  return tiersFor(cls).map((t) => {
    const size = Math.max(1, t.minSize ?? 1);
    const quote = priceFor(cls, size);
    return {
      minSize: t.minSize ?? 1,
      maxSize: t.maxSize ?? null,
      adjustPct: Number(t.adjustPct) || 0,
      perSeatCents: quote.perSeatCents,
      label: t.label,
      reason: t.reason,
    };
  }).filter((t) => t.minSize <= maxSize);
}

// ----------------------------------------------------------------- slots

/**
 * Every start time a day offers, whether or not it's still free.
 *
 * The grid runs from the day's opening time in SLOT_STEP_MINUTES increments,
 * and a start only qualifies if the session itself finishes before closing.
 * The travel buffer is deliberately not required to fit — the instructor
 * driving home after the last session of the day doesn't need to be inside
 * working hours.
 */
function slotGrid(cls) {
  const open = new Date(cls.starts_at).getTime();
  const close = new Date(cls.ends_at).getTime();
  const sessionMs = SESSION_MINUTES * 60_000;
  const stepMs = SLOT_STEP_MINUTES * 60_000;

  const out = [];
  for (let t = open; t + sessionMs <= close; t += stepMs) {
    out.push(new Date(t).toISOString());
  }
  return out;
}

/** Bookings that still hold time on a day's calendar. */
function activeBookings(db, classId, now) {
  return db
    .prepare(
      `SELECT slot_start, group_ref, public_ref, COUNT(*) AS seats
         FROM registrations
        WHERE class_id = @classId
          AND slot_start IS NOT NULL
          AND (
                status = 'confirmed'
             OR (status = 'held'    AND hold_expires_at  > @now)
             OR (status = 'offered' AND offer_expires_at > @now)
          )
        GROUP BY slot_start, COALESCE(group_ref, public_ref)`
    )
    .all({ classId, now });
}

const overlaps = (aStart, bStart) => {
  const a = new Date(aStart).getTime();
  const b = new Date(bStart).getTime();
  const block = BLOCK_MINUTES * 60_000;
  return a < b + block && b < a + block;
};

/**
 * The bookable picture of one day.
 *
 * A slot is offered when nothing else overlaps its block and the day still
 * has room for the party. The instructor is one person in one van, so a
 * booked slot is exclusive — unlike a classroom, nobody else can join it.
 */
function daySlots(classId, { partySize = 1, now = nowIso(), zone = null } = {}) {
  const db = getDb();
  const cls = getClass(classId);
  if (!cls) return null;

  // When the customer's zone is known, a day that has used up its trips into
  // that zone has nothing to offer them, however free its calendar looks.
  const trips = zone ? zoneTripsLeft(classId, zone, { now, db }) : null;
  const zoneFull = Boolean(trips && trips.left === 0);

  const booked = activeBookings(db, classId, now);
  const seatsTaken = booked.reduce((sum, b) => sum + b.seats, 0);
  const seatsLeft = Math.max(0, cls.capacity - seatsTaken);

  const nowMs = new Date(now).getTime();

  const slots = slotGrid(cls).map((start) => {
    const clash = booked.find((b) => overlaps(start, b.slot_start));
    const inPast = new Date(start).getTime() <= nowMs;

    let reason = null;
    if (inPast) reason = 'past';
    else if (clash) reason = 'booked';
    else if (seatsLeft < partySize) reason = seatsLeft === 0 ? 'day_full' : 'not_enough_seats';
    else if (zoneFull) reason = 'zone_full';

    return {
      start,
      end: new Date(new Date(start).getTime() + SESSION_MINUTES * 60_000).toISOString(),
      available: !reason,
      reason,
    };
  });

  return {
    classId,
    opensAt: cls.starts_at,
    closesAt: cls.ends_at,
    sessionMinutes: SESSION_MINUTES,
    bufferMinutes: BUFFER_MINUTES,
    capacity: cls.capacity,
    seatsTaken,
    seatsLeft,
    slots,
    availableSlots: slots.filter((s) => s.available).length,
    zoneTrips: trips,
  };
}

/**
 * Other days offering the same course that can take this party.
 *
 * When a preferred time is given, days offering that exact time come first —
 * somebody who wanted Tuesday at 9am usually wants 9am more than they want
 * Tuesday.
 */
function suggestAlternatives({ classId, preferredTime = null, partySize = 1,
                               zip = null, limit = 4 } = {}) {
  const db = getDb();
  const source = getClass(classId);
  if (!source) return [];

  const now = nowIso();
  const candidates = db
    .prepare(
      `SELECT * FROM classes
        WHERE status = 'open' AND id != ? AND course_code = ? AND ends_at >= ?
        ORDER BY starts_at ASC`
    )
    .all(classId, source.course_code, now);

  // "09:30" from an ISO timestamp, in UTC. The browser sends the preferred
  // time already converted, so both sides are comparing the same thing.
  const hhmm = (iso) => new Date(iso).toISOString().slice(11, 16);
  const wanted = preferredTime ? preferredTime.slice(0, 5) : null;

  // No point offering anything to an address we don't drive to at all.
  let zone = null;
  if (zip) {
    const where = zones.zoneForZip(zip);
    if (!where.ok) return [];
    zone = where.zone;
  }

  const out = [];
  for (const c of candidates) {
    // daySlots marks every time unavailable when the day's trips into their
    // zone are used up, so such a day drops out below.
    const day = daySlots(c.id, { partySize, now, zone });
    if (!day || !day.availableSlots) continue;

    const exact = wanted
      ? day.slots.find((s) => s.available && hhmm(s.start) === wanted)
      : null;

    out.push({
      classId: c.id,
      title: c.title,
      courseCode: c.course_code,
      opensAt: c.starts_at,
      closesAt: c.ends_at,
      priceCents: c.price_cents,
      seatsLeft: day.seatsLeft,
      matchesPreferredTime: Boolean(exact),
      suggestedSlot: (exact || day.slots.find((s) => s.available)).start,
      availableSlots: day.availableSlots,
    });
  }

  // Exact time matches first, then soonest.
  out.sort((a, b) =>
    (b.matchesPreferredTime - a.matchesPreferredTime) ||
    (new Date(a.opensAt) - new Date(b.opensAt)));

  return out.slice(0, limit);
}

// --------------------------------------------------------------- seat holds

/**
 * Reserve a seat for HOLD_MINUTES while the student pays.
 *
 * The count and the insert run inside one BEGIN IMMEDIATE transaction, which
 * takes SQLite's write lock up front. Two people clicking Register on the last
 * seat at the same instant serialise: one gets the hold, the other is told the
 * class is full. This is the bit that a payment-email scraper cannot do,
 * because by the time an email arrives the seat is already gone.
 */
function holdSeat({ classId, name, email, phone = '', notes = '',
                    slotStart = null, address = '', zip = '' }) {
  return holdSeats({ classId, attendees: [name], email, phone, notes, slotStart, address, zip });
}

/**
 * Reserve one or more seats for HOLD_MINUTES while the organiser pays.
 *
 * Each attendee gets their own row: they each need their own name on the
 * roster and their own certification card. The rows share a group_ref, a
 * contact email and phone, and a single payment.
 *
 * All or nothing. If a group of four asks for four seats and only three are
 * free, nobody is held — a half-booked group would leave the organiser paying
 * for staff who can't attend, and the fix would be manual either way.
 *
 * The count and the inserts run inside one BEGIN IMMEDIATE transaction, so
 * two organisers racing for the last seats serialise rather than overselling.
 * A payment-email scraper can't do this: by the time an email arrives the
 * seats are already gone.
 */
function holdSeats({ classId, attendees, email, phone = '', notes = '',
                     organiserName = null, slotStart = null,
                     address = '', addressNotes = '', zip = '' }) {
  const db = getDb();

  // An attendee is either a bare name or { name, email, phone }. Anyone
  // without their own contact details inherits the organiser's, which is the
  // usual case — a manager booking staff who all report to the same inbox.
  const people = (attendees || [])
    .map((a) => (typeof a === 'string' ? { name: a } : (a || {})))
    .map((a) => ({
      name: String(a.name ?? '').trim(),
      email: String(a.email ?? '').trim() || String(email ?? '').trim(),
      phone: String(a.phone ?? '').trim() || String(phone ?? '').trim(),
      ownContact: Boolean(String(a.email ?? '').trim() || String(a.phone ?? '').trim()),
    }))
    .filter((a) => a.name);

  if (!people.length) return { ok: false, reason: 'no_attendees' };
  if (people.length > MAX_GROUP_SEATS) {
    return { ok: false, reason: 'too_many_seats', max: MAX_GROUP_SEATS };
  }
  if (!slotStart) return { ok: false, reason: 'slot_required' };
  if (!String(address).trim()) return { ok: false, reason: 'address_required' };

  const run = db.transaction((args) => {
    const now = nowIso();
    const cls = getClass(args.classId);

    if (!cls) return { ok: false, reason: 'no_such_class' };
    if (cls.status !== 'open') return { ok: false, reason: 'class_cancelled' };

    // Where they are decides whether we go at all, and what the trip costs.
    // Checked here, inside the transaction, as well as on the way in — a
    // booking that slipped past the form must not reserve a slot the
    // instructor won't drive to.
    const where = zones.zoneForZip(args.zip);
    if (!where.ok) {
      return {
        ok: false,
        reason: where.reason === 'zip_invalid' ? 'zip_required' : 'outside_service_area',
        zip: args.zip || null,
        miles: where.miles ?? null,
      };
    }

    const taken = db.prepare(TAKEN_SQL).get({ classId: args.classId, now }).n;
    const available = cls.capacity - taken;

    if (available < args.people.length) {
      return {
        ok: false,
        reason: available <= 0 ? 'full' : 'not_enough_seats',
        available: Math.max(0, available),
        requested: args.people.length,
      };
    }

    // The slot has to be one this day actually offers...
    const grid = slotGrid(cls);
    if (!grid.includes(args.slotStart)) {
      return { ok: false, reason: 'slot_not_offered', slots: grid };
    }
    // ...still in the future...
    if (new Date(args.slotStart).getTime() <= new Date(now).getTime()) {
      return { ok: false, reason: 'slot_in_past' };
    }
    // ...and free. Checked inside the transaction, so two customers clicking
    // the same time serialise instead of both being told yes.
    const clash = activeBookings(db, args.classId, now)
      .find((b) => overlaps(args.slotStart, b.slot_start));
    if (clash) {
      return { ok: false, reason: 'slot_taken', slotStart: args.slotStart };
    }
    // ...and the day still has a trip left into their zone. Inside the
    // transaction too, so two Zone 3 bookings can't both take the last trip.
    const trips = zoneTripsLeft(args.classId, where.zone, { now, db });
    if (trips.left === 0) {
      return {
        ok: false, reason: 'zone_full', zone: where.zone, limit: trips.limit, date: trips.date,
      };
    }

    // Party size sets the per-person price, so it's worked out once here and
    // stamped on every seat.
    const quote = priceFor(cls, args.people.length);

    // Solo bookings keep group_ref NULL so existing queries stay simple.
    const groupRef = args.people.length > 1 ? makeRef().replace('SPC-', 'GRP-') : null;
    const holdExpiresAt = addMinutes(now, HOLD_MINUTES);

    const rows = args.people.map((person, i) => {
      const reg = insertRegistration(db, {
        classId: args.classId,
        status: 'held',
        name: person.name,
        email: person.email,
        phone: person.phone,
        notes: args.notes,
        slotStart: args.slotStart,
        address: args.address,
        addressNotes: args.addressNotes,
        amountCents: quote.perSeatCents,  // per seat; the group pays the sum
        holdExpiresAt,
        offerExpiresAt: null,
        groupRef,
        seatIndex: i,
        organiserName: groupRef ? args.organiserName : null,
        travelZone: where.zone,
        travelMiles: where.miles,
        // One trip, one charge — carried on the organiser's seat only.
        travelCents: i === 0 ? where.feeCents : 0,
      });

      logEvent(db, {
        registrationId: reg.id,
        classId: args.classId,
        kind: groupRef ? 'group_hold_created' : 'hold_created',
        detail: groupRef ? `${groupRef} seat ${i + 1}/${args.people.length}` : `expires ${holdExpiresAt}`,
      });

      return reg;
    });

    return {
      ok: true,
      registration: rows[0],            // the organiser's row drives payment
      registrations: rows,
      groupRef,
      seats: rows.length,
      seatsCents: quote.totalCents,
      travelCents: where.feeCents,
      totalCents: quote.totalCents + where.feeCents,
      travel: {
        zone: where.zone, miles: where.miles, feeCents: where.feeCents,
        city: where.city, state: where.state,
      },
      pricing: quote,
      contactEmail: args.email,
      slotStart: args.slotStart,
      slotEnd: new Date(new Date(args.slotStart).getTime() + SESSION_MINUTES * 60_000).toISOString(),
      address: args.address,
      expiresAt: holdExpiresAt,
      holdMinutes: HOLD_MINUTES,
    };
  });

  return run.immediate({
    classId, people, email, phone, notes, organiserName,
    slotStart, address: String(address).trim(), addressNotes: String(addressNotes).trim(),
    zip: (String(zip || '').trim() || zipFromAddress(address)).slice(0, 5),
  });
}

function insertRegistration(db, r) {
  // public_ref collisions are astronomically unlikely but cheap to handle.
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = makeRef();
    try {
      const info = db
        .prepare(
          `INSERT INTO registrations
             (public_ref, class_id, status, student_name, student_email,
              student_phone, notes, amount_cents, hold_expires_at, offer_expires_at,
              group_ref, seat_index, organiser_name,
              slot_start, address, address_notes,
              travel_zone, travel_miles, travel_cents)
           VALUES
             (@ref, @classId, @status, @name, @email,
              @phone, @notes, @amountCents, @holdExpiresAt, @offerExpiresAt,
              @groupRef, @seatIndex, @organiserName,
              @slotStart, @address, @addressNotes,
              @travelZone, @travelMiles, @travelCents)`
        )
        .run({
          groupRef: null, seatIndex: 0, organiserName: null,
          slotStart: null, address: '', addressNotes: '',
          travelZone: null, travelMiles: null, travelCents: 0,
          ...r, ref,
        });
      return db
        .prepare('SELECT * FROM registrations WHERE id = ?')
        .get(info.lastInsertRowid);
    } catch (err) {
      if (!String(err.message).includes('UNIQUE') || attempt === 4) throw err;
    }
  }
}

/** Extend a hold that hasn't lapsed yet (student still on the payment screen). */
function extendHold(publicRef, minutes = HOLD_MINUTES) {
  const db = getDb();
  const now = nowIso();
  const reg = findByRef(publicRef);
  if (!reg) return { ok: false, reason: 'not_found' };
  if (reg.status !== 'held') return { ok: false, reason: 'not_held' };
  if (reg.hold_expires_at <= now) return { ok: false, reason: 'expired' };

  const expiresAt = addMinutes(now, minutes);
  db.prepare(
    `UPDATE registrations
        SET hold_expires_at = ?, updated_at = ?
      WHERE id = ?`
  ).run(expiresAt, now, reg.id);

  return { ok: true, expiresAt };
}

// ------------------------------------------------------------ confirm / void

/**
 * Mark a held (or offered) registration paid.
 *
 * Idempotent: replaying the same gateway reference returns the existing
 * confirmation instead of double-booking. Gateways retry, users refresh the
 * return page, webhooks fire twice — all of that has to be safe.
 */
function confirmPayment({ publicRef, provider, paymentRef, raw = null }) {
  const db = getDb();

  const run = db.transaction(() => {
    const now = nowIso();
    const reg = db
      .prepare('SELECT * FROM registrations WHERE public_ref = ?')
      .get(publicRef);

    if (!reg) return { ok: false, reason: 'not_found' };

    if (reg.status === 'confirmed') {
      // Already done. Same payment ref => success; different => flag it.
      if (reg.payment_ref && paymentRef && reg.payment_ref !== paymentRef) {
        logEvent(db, {
          registrationId: reg.id,
          classId: reg.class_id,
          kind: 'duplicate_payment_suspected',
          detail: `existing=${reg.payment_ref} incoming=${paymentRef}`,
        });
        return { ok: false, reason: 'already_confirmed_other_payment', registration: reg };
      }
      return { ok: true, alreadyConfirmed: true, registration: reg };
    }

    if (!['held', 'offered'].includes(reg.status)) {
      return { ok: false, reason: `cannot_confirm_from_${reg.status}`, registration: reg };
    }

    // A lapsed hold is the awkward case: they paid, but their seat timed out.
    // Only take the money if a seat is genuinely still free.
    const deadline = reg.status === 'held' ? reg.hold_expires_at : reg.offer_expires_at;
    if (deadline && deadline <= now) {
      const avail = availability(reg.class_id, now);
      if (avail.available <= 0) {
        logEvent(db, {
          registrationId: reg.id,
          classId: reg.class_id,
          kind: 'paid_after_expiry_no_seat',
          detail: `payment_ref=${paymentRef} — refund required`,
        });
        return {
          ok: false,
          reason: 'expired_and_full',
          registration: reg,
          needsRefund: true,
        };
      }
      logEvent(db, {
        registrationId: reg.id,
        classId: reg.class_id,
        kind: 'hold_lapsed_but_seat_free',
        detail: 'confirmed anyway',
      });
    }

    // One payment covers every seat in a group, so confirm them together.
    // The payment reference is suffixed per row because the unique index on
    // (payment_provider, payment_ref) would otherwise reject the second seat.
    const groupRows = reg.group_ref
      ? db.prepare(`SELECT * FROM registrations
                     WHERE group_ref = ? AND status IN ('held','offered')
                     ORDER BY seat_index ASC`).all(reg.group_ref)
      : [reg];

    for (const row of groupRows) {
      db.prepare(
        `UPDATE registrations
            SET status = 'confirmed',
                payment_provider = @provider,
                payment_ref = @paymentRef,
                payment_raw = @raw,
                hold_expires_at = NULL,
                offer_expires_at = NULL,
                confirmed_at = @now,
                updated_at = @now
          WHERE id = @id`
      ).run({
        id: row.id,
        provider,
        paymentRef: reg.group_ref ? `${paymentRef}#${row.seat_index}` : paymentRef,
        raw: raw ? JSON.stringify(raw) : null,
        now,
      });

      logEvent(db, {
        registrationId: row.id,
        classId: row.class_id,
        kind: 'confirmed',
        detail: reg.group_ref
          ? `${provider}:${paymentRef} (group ${reg.group_ref}, seat ${row.seat_index + 1})`
          : `${provider}:${paymentRef}`,
      });
    }

    const updated = db.prepare('SELECT * FROM registrations WHERE id = ?').get(reg.id);
    // One summary email to the organiser, listing everyone.
    queueConfirmationEmail(db, updated);

    // Attendees who gave their own address also get their own confirmation,
    // since that's the only reason to supply one.
    if (reg.group_ref) {
      for (const row of groupRows) {
        if (row.id !== reg.id && row.student_email
            && row.student_email.toLowerCase() !== reg.student_email.toLowerCase()) {
          queueSeatEmail(db, row);
        }
      }
    }
    return {
      ok: true,
      registration: updated,
      seatsConfirmed: groupRows.length,
      groupRef: reg.group_ref || null,
    };
  });

  return run.immediate();
}

/**
 * Cancel every seat in a group at once — an organiser dropping out entirely,
 * or an unpaid group hold being abandoned. To drop one attendee and keep the
 * rest, call cancelRegistration with that seat's own reference.
 */
function cancelGroup(groupRef, { reason = '' } = {}) {
  const db = getDb();
  const now = nowIso();

  const rows = db
    .prepare(`SELECT * FROM registrations
               WHERE group_ref = ? AND status NOT IN ('cancelled','expired')`)
    .all(groupRef);

  if (!rows.length) return { ok: false, reason: 'not_found' };

  for (const row of rows) {
    db.prepare(
      `UPDATE registrations
          SET status = 'cancelled', hold_expires_at = NULL,
              offer_expires_at = NULL, updated_at = ?
        WHERE id = ?`
    ).run(now, row.id);

    logEvent(db, {
      registrationId: row.id,
      classId: row.class_id,
      kind: 'cancelled',
      detail: `group ${groupRef}: ${reason}`,
    });
  }

  const promoted = promoteWaitlist(rows[0].class_id);
  return { ok: true, cancelled: rows.length, promoted };
}

/** Student or admin cancels one seat. Frees it and pulls the waitlist forward. */
function cancelRegistration(publicRef, { reason = '' } = {}) {
  const db = getDb();
  const now = nowIso();
  const reg = findByRef(publicRef);
  if (!reg) return { ok: false, reason: 'not_found' };
  if (['cancelled', 'expired'].includes(reg.status)) {
    return { ok: true, alreadyReleased: true, registration: reg };
  }

  db.prepare(
    `UPDATE registrations
        SET status = 'cancelled', hold_expires_at = NULL,
            offer_expires_at = NULL, updated_at = ?
      WHERE id = ?`
  ).run(now, reg.id);

  logEvent(db, {
    registrationId: reg.id,
    classId: reg.class_id,
    kind: 'cancelled',
    detail: reason,
  });

  const promoted = promoteWaitlist(reg.class_id);
  return { ok: true, promoted };
}

// ------------------------------------------------------------------ waitlist

function joinWaitlist({ classId, name, email, phone = '', notes = '',
                        preferredTime = null, partySize = 1, address = '' }) {
  const db = getDb();
  const cls = getClass(classId);
  if (!cls) return { ok: false, reason: 'no_such_class' };

  const existing = db
    .prepare(
      `SELECT * FROM registrations
        WHERE class_id = ? AND lower(student_email) = lower(?)
          AND status IN ('waitlist','offered','held','confirmed')`
    )
    .get(classId, email);
  if (existing) {
    return { ok: false, reason: 'already_registered', registration: existing };
  }

  const reg = insertRegistration(db, {
    classId,
    status: 'waitlist',
    name,
    email,
    phone,
    // Keep what they asked for, so an offer can come back with a time that
    // actually suits them rather than whatever happens to free up.
    notes: [notes, preferredTime ? `preferred time ${preferredTime}` : '',
            partySize > 1 ? `party of ${partySize}` : '']
      .filter(Boolean).join(' · '),
    amountCents: cls.price_cents,
    holdExpiresAt: null,
    offerExpiresAt: null,
    address,
  });

  logEvent(db, {
    registrationId: reg.id,
    classId,
    kind: 'waitlist_joined',
    detail: '',
  });

  const position = db
    .prepare(
      `SELECT COUNT(*) AS n FROM registrations
        WHERE class_id = ? AND status = 'waitlist' AND created_at <= ?`
    )
    .get(classId, reg.created_at).n;

  return { ok: true, registration: reg, position };
}

/**
 * Offer any free seats to the longest-waiting people.
 *
 * An offer holds the seat for OFFER_HOURS so it can't be bought out from under
 * someone who's asleep when a cancellation lands at 2am.
 */
function promoteWaitlist(classId) {
  const db = getDb();

  const run = db.transaction(() => {
    const now = nowIso();
    const avail = availability(classId, now);
    if (!avail || avail.available <= 0) return [];

    const candidates = db
      .prepare(
        `SELECT * FROM registrations
          WHERE class_id = ? AND status = 'waitlist'
          ORDER BY created_at ASC, id ASC
          LIMIT ?`
      )
      .all(classId, avail.available);

    const promoted = [];
    for (const c of candidates) {
      const offerExpiresAt = addHours(now, OFFER_HOURS);
      db.prepare(
        `UPDATE registrations
            SET status = 'offered', offer_expires_at = ?, updated_at = ?
          WHERE id = ?`
      ).run(offerExpiresAt, now, c.id);

      logEvent(db, {
        registrationId: c.id,
        classId,
        kind: 'waitlist_offered',
        detail: `expires ${offerExpiresAt}`,
      });

      const updated = db.prepare('SELECT * FROM registrations WHERE id = ?').get(c.id);
      queueOfferEmail(db, updated, offerExpiresAt);
      promoted.push(updated);
    }
    return promoted;
  });

  return run.immediate();
}

/**
 * Convert an accepted waitlist offer into a normal payment hold.
 * Their seat is already reserved, so this can't fail on capacity.
 */
function acceptOffer(publicRef) {
  const db = getDb();
  const now = nowIso();
  const reg = findByRef(publicRef);

  if (!reg) return { ok: false, reason: 'not_found' };
  if (reg.status !== 'offered') return { ok: false, reason: `not_offered_${reg.status}` };
  if (reg.offer_expires_at && reg.offer_expires_at <= now) {
    return { ok: false, reason: 'offer_expired' };
  }

  const holdExpiresAt = addMinutes(now, HOLD_MINUTES);
  db.prepare(
    `UPDATE registrations
        SET status = 'held', hold_expires_at = ?, offer_expires_at = NULL, updated_at = ?
      WHERE id = ?`
  ).run(holdExpiresAt, now, reg.id);

  logEvent(db, {
    registrationId: reg.id,
    classId: reg.class_id,
    kind: 'offer_accepted',
    detail: `hold until ${holdExpiresAt}`,
  });

  return {
    ok: true,
    registration: findByRef(publicRef),
    expiresAt: holdExpiresAt,
    holdMinutes: HOLD_MINUTES,
  };
}

// ------------------------------------------------------------------- sweeper

/**
 * Tidy-up pass: flip lapsed holds/offers to expired, then re-offer the seats.
 * Seat counts are already correct without this (see TAKEN_SQL) — the sweeper
 * exists so the data reads truthfully and the waitlist actually moves.
 */
function sweepExpired() {
  const db = getDb();
  const now = nowIso();

  const lapsedHolds = db
    .prepare(
      `SELECT * FROM registrations
        WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?`
    )
    .all(now);

  const lapsedOffers = db
    .prepare(
      `SELECT * FROM registrations
        WHERE status = 'offered' AND offer_expires_at IS NOT NULL AND offer_expires_at <= ?`
    )
    .all(now);

  const touchedClasses = new Set();

  for (const r of [...lapsedHolds, ...lapsedOffers]) {
    db.prepare(
      `UPDATE registrations
          SET status = 'expired', hold_expires_at = NULL,
              offer_expires_at = NULL, updated_at = ?
        WHERE id = ?`
    ).run(now, r.id);

    logEvent(db, {
      registrationId: r.id,
      classId: r.class_id,
      kind: r.status === 'held' ? 'hold_expired' : 'offer_expired',
      detail: '',
    });

    touchedClasses.add(r.class_id);
  }

  const promoted = [];
  for (const classId of touchedClasses) {
    promoted.push(...promoteWaitlist(classId));
  }

  return {
    expiredHolds: lapsedHolds.length,
    expiredOffers: lapsedOffers.length,
    promoted: promoted.length,
  };
}

// -------------------------------------------------------------------- lookup

function findByRef(publicRef) {
  return getDb()
    .prepare('SELECT * FROM registrations WHERE public_ref = ?')
    .get(publicRef);
}

/**
 * What one booking costs in full: every seat plus the trip.
 *
 * Seats are summed from the rows rather than recomputed, so a booking keeps
 * the price it was quoted even if the day's prices change later.
 */
function bookingTotals(reg) {
  if (!reg) return null;
  const rows = reg.group_ref
    ? getDb().prepare(`SELECT amount_cents, travel_cents FROM registrations
                        WHERE group_ref = ? AND status NOT IN ('cancelled','expired')`)
        .all(reg.group_ref)
    : [reg];
  const seatsCents = rows.reduce((sum, r) => sum + (r.amount_cents || 0), 0);
  const travelCents = rows.reduce((sum, r) => sum + (r.travel_cents || 0), 0);
  return {
    seats: rows.length,
    seatsCents,
    travelCents,
    travelZone: reg.travel_zone ?? null,
    totalCents: seatsCents + travelCents,
  };
}

function listUpcomingClasses({ includeFull = true, from = nowIso() } = {}) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM classes
        WHERE status = 'open' AND ends_at >= ?
        ORDER BY starts_at ASC`
    )
    .all(from);

  return rows
    .map((c) => ({ ...c, seats: availability(c.id, from) }))
    .filter((c) => (includeFull ? true : !c.seats.isFull));
}

/**
 * The visits booked on a day, in time order: when, where, who and how many.
 * One row per visit — a group of four at one address is one visit.
 */
function dayVisits(classId, now = nowIso()) {
  return getDb()
    .prepare(
      `SELECT slot_start, address, travel_zone, travel_miles,
              COALESCE(group_ref, public_ref) AS visit_ref,
              COUNT(*) AS people,
              MAX(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS paid,
              COALESCE(MAX(organiser_name),
                       MAX(CASE WHEN seat_index = 0 THEN student_name END)) AS contact
         FROM registrations
        WHERE class_id = @classId
          AND slot_start IS NOT NULL
          AND (
                status = 'confirmed'
             OR (status = 'held'    AND hold_expires_at  > @now)
             OR (status = 'offered' AND offer_expires_at > @now)
          )
        GROUP BY slot_start, COALESCE(group_ref, public_ref)
        ORDER BY slot_start ASC`
    )
    .all({ classId, now })
    .map((v) => ({
      slotStart: v.slot_start,
      slotEnd: addMinutes(v.slot_start, SESSION_MINUTES),
      address: v.address,
      zone: v.travel_zone,
      miles: v.travel_miles,
      people: v.people,
      paid: Boolean(v.paid),
      contact: v.contact || '',
    }));
}

function roster(classId) {
  return getDb()
    .prepare(
      `SELECT public_ref, student_name, student_email, student_phone,
              status, amount_cents, confirmed_at, created_at,
              group_ref, seat_index, organiser_name,
              slot_start, address, address_notes, notes,
              travel_zone, travel_miles, travel_cents
         FROM registrations
        WHERE class_id = ? AND status IN ('confirmed','held','offered','waitlist')
        ORDER BY
          slot_start IS NULL, slot_start ASC,
          CASE status
            WHEN 'confirmed' THEN 0 WHEN 'held' THEN 1
            WHEN 'offered'   THEN 2 ELSE 3
          END,
          created_at ASC, seat_index ASC`
    )
    .all(classId);
}

// -------------------------------------------------------------------- outbox

function logEvent(db, { registrationId, classId, kind, detail }) {
  db.prepare(
    `INSERT INTO events (registration_id, class_id, kind, detail)
     VALUES (?, ?, ?, ?)`
  ).run(registrationId ?? null, classId ?? null, kind, detail ?? '');
}

function queueConfirmationEmail(db, reg) {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(reg.class_id);

  const group = reg.group_ref
    ? db.prepare(`SELECT student_name, public_ref FROM registrations
                   WHERE group_ref = ? AND status = 'confirmed'
                   ORDER BY seat_index ASC`).all(reg.group_ref)
    : null;

  const greeting = reg.organiser_name || reg.student_name;
  const when = reg.slot_start || cls.starts_at;
  const where = reg.address || cls.location;

  const totals = bookingTotals(reg);
  const dollars = (c) => `$${(c / 100).toFixed(2)}`;
  const charges = reg.travel_zone ? [
    ``,
    `Classes: ${dollars(totals.seatsCents)}`,
    `Travel (Zone ${reg.travel_zone}): ${totals.travelCents ? dollars(totals.travelCents) : 'no charge'}`,
    `Total:   ${dollars(totals.totalCents)}`,
  ] : [];

  const body = group && group.length > 1
    ? [
        `Hi ${greeting},`,
        ``,
        `${group.length} seats are confirmed for ${cls.title}.`,
        `When:  ${when}`,
        `Where: ${where}`,
        ``,
        `Attending:`,
        ...group.map((g, i) => `  ${i + 1}. ${g.student_name} — ${g.public_ref}`),
        ...charges,
        ``,
        `Group reference: ${reg.group_ref}`,
        ``,
        `We come to you. Have everyone ready in comfortable clothes with floor`,
        `space for compressions. Each person receives their own card.`,
      ]
    : [
        `Hi ${reg.student_name},`,
        ``,
        `You're confirmed for ${cls.title}.`,
        `When:  ${when}`,
        `Where: ${where}`,
        `Confirmation: ${reg.public_ref}`,
        ...charges,
        ``,
        `We come to you. Wear comfortable clothes and have floor space ready.`,
      ];

  db.prepare(
    `INSERT INTO outbox (registration_id, to_email, subject, body) VALUES (?, ?, ?, ?)`
  ).run(
    reg.id,
    reg.student_email,
    group && group.length > 1
      ? `${group.length} seats confirmed — ${cls.title}`
      : `You're registered — ${cls.title}`,
    body.join('\n')
  );
}

/** Confirmation for one attendee who supplied their own email address. */
function queueSeatEmail(db, reg) {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(reg.class_id);
  db.prepare(
    `INSERT INTO outbox (registration_id, to_email, subject, body) VALUES (?, ?, ?, ?)`
  ).run(
    reg.id,
    reg.student_email,
    `You're registered — ${cls.title}`,
    [
      `Hi ${reg.student_name},`,
      ``,
      `A seat has been booked for you on ${cls.title}.`,
      `When:  ${reg.slot_start || cls.starts_at}`,
      `Where: ${reg.address || cls.location}`,
      `Your confirmation: ${reg.public_ref}`,
      ``,
      `Arrive 10 minutes early and wear comfortable clothes.`,
    ].join('\n')
  );
}

function queueOfferEmail(db, reg, expiresAt) {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(reg.class_id);
  db.prepare(
    `INSERT INTO outbox (registration_id, to_email, subject, body) VALUES (?, ?, ?, ?)`
  ).run(
    reg.id,
    reg.student_email,
    `A seat opened up — ${cls.title}`,
    [
      `Hi ${reg.student_name},`,
      ``,
      `A time opened up for ${cls.title} on ${cls.starts_at.slice(0, 10)}.`,
      `It's reserved for you until ${expiresAt}.`,
      ``,
      `Claim it here: [OFFER_LINK]/offer/${reg.public_ref}`,
    ].join('\n')
  );
}

module.exports = {
  BUSINESS_TZ,
  localDate,
  zoneLimitsFor,
  zoneTripsLeft,
  zipFromAddress,
  bookingTotals,
  DEFAULT_TIERS,
  priceFor,
  priceLadder,
  tiersFor,
  HOLD_MINUTES,
  OFFER_HOURS,
  MAX_GROUP_SEATS,
  SESSION_MINUTES,
  BUFFER_MINUTES,
  SLOT_STEP_MINUTES,
  BLOCK_MINUTES,
  daySlots,
  slotGrid,
  suggestAlternatives,
  holdSeats,
  nowIso,
  addMinutes,
  availability,
  holdSeat,
  extendHold,
  confirmPayment,
  cancelRegistration,
  cancelGroup,
  joinWaitlist,
  promoteWaitlist,
  acceptOffer,
  sweepExpired,
  findByRef,
  getClass,
  listUpcomingClasses,
  roster,
  dayVisits,
};
