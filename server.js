'use strict';

const path = require('path');
const express = require('express');
const seats = require('./seats');
const seats_ = seats; // alias used by the admin routes below
const calendar = require('./calendar');
const address = require('./address');
const payments = require('./payments');
const { getDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ORG_NAME = process.env.ORG_NAME || 'Spectrum CPR + First Aid';

// Where index.html lives. Defaults to the folder above this project, so a
// layout with the site and the API side by side works with no configuration.
const SITE_DIR = process.env.SITE_DIR || path.join(__dirname, '..');

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true }));

/**
 * CORS.
 *
 * Needed once the site is hosted somewhere other than this server — a static
 * host for the pages, this API on its own box. Set ALLOWED_ORIGINS to the
 * site's real origin(s) before going live; '*' is fine while everything is
 * local but too loose for production.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (ALLOWED_ORIGINS.includes('*')) {
    res.set('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,x-admin-token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve the website alongside the API so everything is reachable on one
// origin during development. In production the pages are usually on a static
// host instead and this is harmless.
app.use(express.static(SITE_DIR, { extensions: ['html'] }));

// ------------------------------------------------------------------- helpers

function bad(res, status, reason, extra = {}) {
  return res.status(status).json({ ok: false, reason, ...extra });
}

function validEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/** Never send internal ids or raw gateway payloads to the browser. */
function publicRegistration(reg) {
  if (!reg) return null;
  return {
    ref: reg.public_ref,
    status: reg.status,
    name: reg.student_name,
    email: reg.student_email,
    classId: reg.class_id,
    amountCents: reg.amount_cents,
    holdExpiresAt: reg.hold_expires_at,
    offerExpiresAt: reg.offer_expires_at,
    confirmedAt: reg.confirmed_at,
    groupRef: reg.group_ref || null,
    slotStart: reg.slot_start || null,
    address: reg.address || '',
  };
}

function publicClass(c) {
  const day = seats.daySlots(c.id);
  return {
    id: c.id,
    courseCode: c.course_code,
    title: c.title,
    // The day's working window, not one session.
    opensAt: c.starts_at,
    closesAt: c.ends_at,
    startsAt: c.starts_at,        // kept for older callers
    endsAt: c.ends_at,
    priceCents: c.price_cents,
    pricingTiers: seats.priceLadder(c),
    serviceZips: seats.serviceZipsFor(c),
    seatsAvailable: c.seats.available,
    capacity: c.seats.capacity,
    waitlistCount: c.seats.waitlist,
    sessionMinutes: seats.SESSION_MINUTES,
    availableSlots: day ? day.availableSlots : 0,
    // "Full" now means no bookable time left, whether that's seats or clashes.
    isFull: c.seats.isFull || !day || day.availableSlots === 0,
  };
}

/**
 * Check a set of pricing tiers before it reaches the database.
 *
 * The gap that matters is a party size no tier covers — it would silently fall
 * back to the base price, which is neither what the client set nor what the
 * customer was shown.
 */
function validateTiers(tiers) {
  if (tiers === undefined || tiers === null) return null;   // keep the defaults
  if (!Array.isArray(tiers) || !tiers.length) return 'Set at least one price band.';

  const sorted = [...tiers].sort((a, b) => (a.minSize ?? 1) - (b.minSize ?? 1));

  if ((sorted[0].minSize ?? 1) !== 1) {
    return 'The first price band has to start at 1 person.';
  }
  if (sorted[sorted.length - 1].maxSize !== null &&
      sorted[sorted.length - 1].maxSize !== undefined) {
    return 'The last price band needs no upper limit, so every group size is covered.';
  }

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const min = t.minSize ?? 1;
    const max = t.maxSize;

    if (!Number.isInteger(min) || min < 1) return 'Each band must start at a whole number of people.';
    if (max !== null && max !== undefined && (!Number.isInteger(max) || max < min)) {
      return 'A band cannot end before it starts.';
    }
    if (typeof t.adjustPct !== 'number' || Number.isNaN(t.adjustPct)) {
      return 'Each band needs a percentage.';
    }
    if (t.adjustPct < -90 || t.adjustPct > 200) {
      return 'Keep adjustments between -90% and +200%.';
    }
    if (!String(t.reason || '').trim()) {
      return 'Each band needs a short reason — customers are shown it.';
    }

    const next = sorted[i + 1];
    if (next && (max === null || max === undefined)) {
      return 'Only the last band can be open-ended.';
    }
    if (next && (next.minSize ?? 1) !== max + 1) {
      return `Gap in the bands: nothing covers a group of ${max + 1}.`;
    }
  }
  return null;
}

/** Five digits, de-duplicated, sorted — so the stored list is predictable. */
function normaliseZips(zips) {
  return [...new Set((zips || [])
    .map((z) => String(z).trim().slice(0, 5))
    .filter((z) => /^\d{5}$/.test(z)))].sort();
}

/**
 * An empty list is allowed and means "anywhere". What isn't allowed is a list
 * of things that aren't ZIP codes, which would silently serve nowhere.
 */
function validateZips(zips) {
  if (zips === undefined || zips === null) return null;
  if (!Array.isArray(zips)) return 'Service area must be a list of ZIP codes.';
  if (!zips.length) return null;

  const bad = zips
    .map((z) => String(z).trim())
    .filter((z) => z && !/^\d{5}(-\d{4})?$/.test(z));
  if (bad.length) return `Not a ZIP code: ${bad.slice(0, 3).join(', ')}`;

  if (!normaliseZips(zips).length) {
    return 'None of those are usable ZIP codes.';
  }
  return null;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return bad(res, 503, 'admin_disabled', {
      hint: 'Set ADMIN_TOKEN in the environment to enable admin routes.',
    });
  }
  const sent = req.get('x-admin-token');
  if (sent !== ADMIN_TOKEN) return bad(res, 401, 'unauthorized');
  next();
}

// -------------------------------------------------------------- public: read

app.get('/api/classes', (req, res) => {
  const includeFull = req.query.includeFull !== 'false';
  const classes = seats.listUpcomingClasses({ includeFull }).map(publicClass);
  res.json({ ok: true, classes });
});

app.get('/api/classes/:id', (req, res) => {
  const cls = seats.getClass(Number(req.params.id));
  if (!cls) return bad(res, 404, 'no_such_class');
  const availability = seats.availability(cls.id);
  res.json({ ok: true, class: publicClass({ ...cls, seats: availability }) });
});

app.get('/api/registrations/:ref', (req, res) => {
  const reg = seats.findByRef(req.params.ref);
  if (!reg) return bad(res, 404, 'not_found');
  res.json({ ok: true, registration: publicRegistration(reg) });
});


/**
 * Bookable times on one day.
 *
 * partySize matters: a day with three seats left can still offer slots to a
 * pair but not to a group of six.
 */
app.get('/api/classes/:id/slots', (req, res) => {
  const classId = Number(req.params.id);
  const partySize = Math.max(1, Number(req.query.partySize) || 1);

  const day = seats.daySlots(classId, { partySize });
  if (!day) return bad(res, 404, 'no_such_class');

  const cls = seats.getClass(classId);
  res.json({
    ok: true,
    class: { id: cls.id, title: cls.title, courseCode: cls.course_code,
             priceCents: cls.price_cents },
    ...day,
  });
});

/**
 * Other days that could take this booking.
 *
 * Offered when a day can't be booked, since somebody who wanted Tuesday at 9am
 * usually wants 9am more than they want Tuesday.
 */
app.get('/api/classes/:id/alternatives', (req, res) => {
  const classId = Number(req.params.id);
  const partySize = Math.max(1, Number(req.query.partySize) || 1);
  const preferredTime = req.query.preferredTime || null;
  const zip = req.query.zip || null;

  if (!seats.getClass(classId)) return bad(res, 404, 'no_such_class');

  res.json({
    ok: true,
    alternatives: seats.suggestAlternatives({ classId, preferredTime, partySize, zip }),
  });
});

/**
 * What a party of this size would pay, and why.
 *
 * Separate from booking so the page can show the price moving as somebody
 * changes the headcount, without reserving anything.
 */
app.get('/api/classes/:id/quote', (req, res) => {
  const cls = seats.getClass(Number(req.params.id));
  if (!cls) return bad(res, 404, 'no_such_class');

  const partySize = Math.max(1, Math.min(seats.MAX_GROUP_SEATS,
    Number(req.query.partySize) || 1));

  res.json({
    ok: true,
    partySize,
    ...seats.priceFor(cls, partySize),
    tiers: seats.priceLadder(cls),
  });
});

// ------------------------------------------------------- public: hold + pay

/**
 * Step 1 of booking: take the seat, THEN open payment.
 *
 * Order matters. Holding first means the student can't pay for a seat that
 * someone else grabbed while they were typing their card number.
 */
app.post('/api/classes/:id/hold', async (req, res) => {
  const classId = Number(req.params.id);
  const { name, attendees, email, phone = '', notes = '', organiserName,
          slotStart, address = '', addressNotes = '', zip = '' } = req.body || {};

  // One seat sends `name`; a group sends `attendees`, either as plain names or
  // as objects carrying that person's own email and phone.
  const people = Array.isArray(attendees) && attendees.length
    ? attendees.map((a) => (typeof a === 'string' ? { name: a } : (a || {})))
    : [{ name }];

  const cleaned = people.map((a) => ({
    name: String(a.name ?? '').trim(),
    email: String(a.email ?? '').trim(),
    phone: String(a.phone ?? '').trim(),
  }));

  const missing = cleaned.findIndex((a) => a.name.length < 2);
  if (missing !== -1) {
    return bad(res, 400, 'name_required', {
      seat: missing + 1,
      message: cleaned.length > 1
        ? `Please enter a name for attendee ${missing + 1}.`
        : 'Please enter your name.',
    });
  }
  if (cleaned.length > seats.MAX_GROUP_SEATS) {
    return bad(res, 400, 'too_many_seats', { max: seats.MAX_GROUP_SEATS });
  }

  // Per-attendee addresses are optional, but a malformed one would send a
  // confirmation into the void — better to say so than fail silently.
  const badEmail = cleaned.findIndex((a) => a.email && !validEmail(a.email));
  if (badEmail !== -1) {
    return bad(res, 400, 'attendee_email_invalid', {
      seat: badEmail + 1,
      message: `That email for attendee ${badEmail + 1} doesn't look right.`,
    });
  }

  if (!validEmail(email)) {
    return bad(res, 400, 'valid_email_required', {
      message: cleaned.length > 1
        ? 'Please enter a valid email address for the booking.'
        : 'Please enter a valid email address.',
    });
  }

  if (!slotStart) {
    return bad(res, 400, 'slot_required', { message: 'Please choose a time.' });
  }
  // The instructor drives here, so a vague address means a missed appointment.
  if (String(address).trim().length < 8) {
    return bad(res, 400, 'address_required', {
      message: 'Please enter the full address where the training will happen.',
    });
  }

  const day = seats.getClass(classId);
  if (day && !seats.servesZip(day, zip)) {
    return bad(res, 409, 'outside_service_area', {
      serviceZips: seats.serviceZipsFor(day),
      zip: String(zip).trim().slice(0, 5) || null,
      message: String(zip).trim()
        ? `We don't travel to ${String(zip).trim().slice(0, 5)} on this day.`
        : 'Please enter the ZIP code so we can check we cover it.',
    });
  }

  const result = seats.holdSeats({
    classId,
    attendees: cleaned,
    email: String(email).trim(),
    phone: String(phone).trim(),
    notes: String(notes).trim(),
    organiserName: organiserName ? String(organiserName).trim() : null,
    slotStart: String(slotStart),
    address: String(address).trim(),
    addressNotes: String(addressNotes).trim(),
    zip: String(zip).trim().slice(0, 5),
  });

  if (!result.ok) {
    const conflict = ['full', 'not_enough_seats', 'slot_taken'].includes(result.reason);
    const status = conflict ? 409 : 400;
    return bad(res, status, result.reason, {
      canJoinWaitlist: ['full', 'slot_taken', 'not_enough_seats'].includes(result.reason),
      serviceZips: result.serviceZips,
      available: result.available,
      requested: result.requested,
      max: result.max,
      slotStart: result.slotStart,
      message: {
        not_enough_seats: `Only ${result.available} seat${result.available === 1 ? '' : 's'} ` +
                          `left that day — you asked for ${result.requested}.`,
        slot_taken: 'Someone just booked that time. Please pick another.',
        slot_in_past: 'That time has already passed. Please pick another.',
        slot_not_offered: 'That time is not available on this day.',
        full: 'This day is fully booked.',
        outside_service_area: `We don't travel to that ZIP code on this day.`,
      }[result.reason],
      detail: result.reason,
    });
  }

  const cls = seats.getClass(classId);

  let session;
  try {
    session = await payments.createSession({
      registration: result.registration,
      cls,
      // A group pays once for every seat.
      amountCents: result.totalCents,
      seatCount: result.seats,
    });
  } catch (err) {
    // Don't strand seats because the gateway hiccupped.
    if (result.groupRef) {
      seats.cancelGroup(result.groupRef, { reason: `payment session failed: ${err.message}` });
    } else {
      seats.cancelRegistration(result.registration.public_ref, {
        reason: `payment session failed: ${err.message}`,
      });
    }
    console.error('[payments] createSession failed:', err.message);
    return bad(res, 502, 'payment_unavailable', { detail: err.message });
  }

  res.json({
    ok: true,
    registration: publicRegistration(result.registration),
    attendees: result.registrations.map((r) => ({
      ref: r.public_ref, name: r.student_name, seat: r.seat_index + 1,
    })),
    groupRef: result.groupRef,
    seats: result.seats,
    totalCents: result.totalCents,
    slotStart: result.slotStart,
    slotEnd: result.slotEnd,
    address: result.address,
    expiresAt: result.expiresAt,
    holdMinutes: result.holdMinutes,
    payment: session,
  });
});

/** Student still filling in the form — push the deadline back. */
app.post('/api/registrations/:ref/extend', (req, res) => {
  const result = seats.extendHold(req.params.ref);
  if (!result.ok) return bad(res, 409, result.reason);
  res.json({ ok: true, expiresAt: result.expiresAt });
});

/**
 * Step 2: the gateway says it's paid; confirm the seat.
 *
 * NOTE FOR GO-LIVE: with Converge, treat a browser-supplied payload as a hint,
 * not proof. Verify server-side (txnquery) or accept only Converge's Export
 * Script webhook before confirming. See payments/converge.js.
 */
app.post('/api/registrations/:ref/confirm', async (req, res) => {
  const ref = req.params.ref;
  const reg = seats.findByRef(ref);
  if (!reg) return bad(res, 404, 'not_found');

  // Already paid — a refreshed return page or a retried webhook. Answer
  // success without re-running verification, which could mint a second
  // transaction reference and look like a duplicate payment.
  if (reg.status === 'confirmed') {
    return res.json({
      ok: true,
      alreadyConfirmed: true,
      registration: publicRegistration(reg),
    });
  }

  const verification = await payments.verify({ ...(req.body || {}), publicRef: ref });
  if (!verification.ok) {
    return bad(res, 402, 'payment_not_approved', { detail: verification.reason });
  }

  const result = seats.confirmPayment({
    publicRef: ref,
    provider: payments.name,
    paymentRef: verification.paymentRef,
    raw: verification.raw,
  });

  if (!result.ok) {
    // The unhappy path worth watching: money taken, no seat left.
    if (result.needsRefund) {
      console.error(
        `[REFUND REQUIRED] ${ref} paid ${verification.paymentRef} but the class filled up.`
      );
      return bad(res, 409, 'expired_and_full', {
        needsRefund: true,
        paymentRef: verification.paymentRef,
        message:
          'Your payment went through but the seat expired and the class is now full. ' +
          'We will refund you — please contact us.',
      });
    }
    return bad(res, 409, result.reason);
  }

  res.json({
    ok: true,
    alreadyConfirmed: Boolean(result.alreadyConfirmed),
    registration: publicRegistration(result.registration),
    seatsConfirmed: result.seatsConfirmed || 1,
    groupRef: result.groupRef || null,
  });
});

app.post('/api/registrations/:ref/cancel', (req, res) => {
  const result = seats.cancelRegistration(req.params.ref, {
    reason: String(req.body?.reason || 'student cancelled'),
  });
  if (!result.ok) return bad(res, 404, result.reason);
  res.json({ ok: true, promoted: (result.promoted || []).length });
});

// ------------------------------------------------------------ waitlist flow

app.post('/api/classes/:id/waitlist', (req, res) => {
  const classId = Number(req.params.id);
  const { name, email, phone = '', notes = '',
          preferredTime = null, partySize = 1, address = '' } = req.body || {};

  if (!name || String(name).trim().length < 2) return bad(res, 400, 'name_required');
  if (!validEmail(email)) return bad(res, 400, 'valid_email_required');

  const result = seats.joinWaitlist({
    classId,
    name: String(name).trim(),
    email: String(email).trim(),
    phone: String(phone).trim(),
    notes: String(notes).trim(),
    preferredTime: preferredTime ? String(preferredTime) : null,
    partySize: Math.max(1, Number(partySize) || 1),
    address: String(address).trim(),
  });

  if (!result.ok) {
    return bad(res, result.reason === 'already_registered' ? 409 : 400, result.reason);
  }

  res.json({
    ok: true,
    registration: publicRegistration(result.registration),
    position: result.position,
    // Somewhere else they could go instead of waiting.
    alternatives: seats.suggestAlternatives({
      classId,
      preferredTime: preferredTime ? String(preferredTime) : null,
      partySize: Math.max(1, Number(partySize) || 1),
    }),
  });
});

/** Waitlisted student clicked the "claim your seat" link. */
app.post('/api/registrations/:ref/accept-offer', async (req, res) => {
  const result = seats.acceptOffer(req.params.ref);
  if (!result.ok) return bad(res, 409, result.reason);

  const cls = seats.getClass(result.registration.class_id);

  let session;
  try {
    session = await payments.createSession({ registration: result.registration, cls });
  } catch (err) {
    return bad(res, 502, 'payment_unavailable', { detail: err.message });
  }

  res.json({
    ok: true,
    registration: publicRegistration(result.registration),
    expiresAt: result.expiresAt,
    holdMinutes: result.holdMinutes,
    payment: session,
  });
});

// --------------------------------------------------------------------- admin

app.get('/api/admin/classes/:id/roster', requireAdmin, (req, res) => {
  const classId = Number(req.params.id);
  const cls = seats.getClass(classId);
  if (!cls) return bad(res, 404, 'no_such_class');
  res.json({
    ok: true,
    class: { id: cls.id, title: cls.title, startsAt: cls.starts_at },
    seats: seats.availability(classId),
    roster: seats.roster(classId),
  });
});

app.post('/api/admin/classes', requireAdmin, (req, res) => {
  const {
    courseCode, title, startsAt, endsAt,
    location = '', capacity, priceCents, pricingTiers, serviceZips,
  } = req.body || {};

  if (!courseCode || !title || !startsAt || !endsAt) {
    return bad(res, 400, 'courseCode, title, startsAt and endsAt are required');
  }
  if (!Number.isInteger(capacity) || capacity < 1) return bad(res, 400, 'capacity_invalid');
  if (!Number.isInteger(priceCents) || priceCents < 0) return bad(res, 400, 'priceCents_invalid');

  const tierError = validateTiers(pricingTiers);
  if (tierError) return bad(res, 400, 'pricing_invalid', { message: tierError });

  const zipError = validateZips(serviceZips);
  if (zipError) return bad(res, 400, 'service_area_invalid', { message: zipError });

  const info = getDb()
    .prepare(
      `INSERT INTO classes
         (course_code, title, starts_at, ends_at, location, capacity, price_cents,
          pricing_tiers, service_zips)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(courseCode, title, startsAt, endsAt, location, capacity, priceCents,
         pricingTiers ? JSON.stringify(pricingTiers) : null,
         serviceZips && serviceZips.length ? JSON.stringify(normaliseZips(serviceZips)) : null);

  res.status(201).json({ ok: true, classId: info.lastInsertRowid });
});

app.post('/api/admin/classes/:id/cancel', requireAdmin, (req, res) => {
  const classId = Number(req.params.id);
  getDb().prepare(`UPDATE classes SET status = 'cancelled' WHERE id = ?`).run(classId);
  res.json({ ok: true });
});

/** What would have been emailed. Replace with a real mail provider later. */
app.get('/api/admin/outbox', requireAdmin, (req, res) => {
  const rows = getDb()
    .prepare('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 100')
    .all();
  res.json({ ok: true, outbox: rows });
});

app.post('/api/admin/sweep', requireAdmin, (req, res) => {
  res.json({ ok: true, ...seats.sweepExpired() });
});


/** Every class, including past and cancelled, for the admin table. */
app.get('/api/admin/classes', requireAdmin, (req, res) => {
  // Same order as the booking page — soonest first — so a day can be found in
  // the same place on both screens. Days that have already happened sit below
  // the upcoming ones rather than burying them at the top.
  const now = new Date().toISOString();
  const rows = getDb()
    .prepare(`SELECT * FROM classes
               ORDER BY (ends_at < ?) ASC, starts_at ASC`)
    .all(now);

  res.json({
    ok: true,
    classes: rows.map((c) => {
      const seats = seats_.availability(c.id);
      return {
        id: c.id,
        courseCode: c.course_code,
        title: c.title,
        startsAt: c.starts_at,
        endsAt: c.ends_at,
        location: c.location,
        capacity: c.capacity,
        priceCents: c.price_cents,
        status: c.status,
        pricingTiers: seats_.tiersFor(c),
        serviceZips: seats_.serviceZipsFor(c),
        taken: seats.taken,
        available: seats.available,
        waitlist: seats.waitlist,
        confirmed: getDb()
          .prepare(`SELECT COUNT(*) AS n FROM registrations
                     WHERE class_id = ? AND status = 'confirmed'`)
          .get(c.id).n,
        availableSlots: (seats_.daySlots(c.id) || {}).availableSlots || 0,
        bookedSlots: (() => {
          const d = seats_.daySlots(c.id);
          if (!d) return 0;
          // Slots lost to bookings, not to the day simply being over.
          return d.slots.filter((s) => s.reason === 'booked').length;
        })(),
        groups: getDb()
          .prepare(`SELECT COUNT(DISTINCT group_ref) AS n FROM registrations
                     WHERE class_id = ? AND group_ref IS NOT NULL
                       AND status IN ('confirmed','held','offered')`)
          .get(c.id).n,
      };
    }),
  });
});

/**
 * Edit a class. Only the fields sent are changed.
 *
 * Capacity can't drop below the seats already spoken for — that would mean
 * telling someone who paid that their seat no longer exists.
 */
app.post('/api/admin/classes/:id/update', requireAdmin, (req, res) => {
  const classId = Number(req.params.id);
  const cls = seats_.getClass(classId);
  if (!cls) return bad(res, 404, 'no_such_class');

  const { title, courseCode, startsAt, endsAt, location, capacity, priceCents, status,
          pricingTiers, serviceZips } = req.body || {};

  if (capacity !== undefined) {
    if (!Number.isInteger(capacity) || capacity < 1) return bad(res, 400, 'capacity_invalid');
    const taken = seats_.availability(classId).taken;
    if (capacity < taken) {
      return bad(res, 409, 'capacity_below_booked', {
        taken,
        message: `${taken} seat${taken === 1 ? ' is' : 's are'} already taken. ` +
                 `Capacity cannot go below that.`,
      });
    }
  }

  if (priceCents !== undefined && (!Number.isInteger(priceCents) || priceCents < 0)) {
    return bad(res, 400, 'price_invalid');
  }
  if (status !== undefined && !['open', 'cancelled'].includes(status)) {
    return bad(res, 400, 'status_invalid');
  }
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
    return bad(res, 400, 'end_before_start');
  }

  const tierError = validateTiers(pricingTiers);
  if (tierError) return bad(res, 400, 'pricing_invalid', { message: tierError });

  const zipError = validateZips(serviceZips);
  if (zipError) return bad(res, 400, 'service_area_invalid', { message: zipError });

  const fields = {
    title, course_code: courseCode, starts_at: startsAt, ends_at: endsAt,
    location, capacity, price_cents: priceCents, status,
    pricing_tiers: pricingTiers === undefined ? undefined : JSON.stringify(pricingTiers),
    service_zips: serviceZips === undefined
      ? undefined
      : (serviceZips && serviceZips.length ? JSON.stringify(normaliseZips(serviceZips)) : null),
  };

  const setters = [];
  const values = {};
  for (const [col, val] of Object.entries(fields)) {
    if (val !== undefined) {
      setters.push(`${col} = @${col}`);
      values[col] = val;
    }
  }
  if (!setters.length) return bad(res, 400, 'nothing_to_update');

  getDb()
    .prepare(`UPDATE classes SET ${setters.join(', ')} WHERE id = @id`)
    .run({ ...values, id: classId });

  // Raising capacity may free seats the waitlist should get first.
  const promoted = seats_.promoteWaitlist(classId);

  res.json({ ok: true, promoted: promoted.length });
});

/** Admin-side cancellation of one student's registration. */
app.post('/api/admin/registrations/:ref/cancel', requireAdmin, (req, res) => {
  const result = seats_.cancelRegistration(req.params.ref, {
    reason: String(req.body?.reason || 'cancelled by staff'),
  });
  if (!result.ok) return bad(res, 404, result.reason);
  res.json({ ok: true, promoted: (result.promoted || []).length });
});

/** Cancel every seat in a group booking. */
app.post('/api/admin/groups/:groupRef/cancel', requireAdmin, (req, res) => {
  const result = seats_.cancelGroup(req.params.groupRef, {
    reason: String(req.body?.reason || 'cancelled by staff'),
  });
  if (!result.ok) return bad(res, 404, result.reason);
  res.json({ ok: true, cancelled: result.cancelled, promoted: (result.promoted || []).length });
});

/** Mark a registration paid without a card — cash or cheque on the day. */
app.post('/api/admin/registrations/:ref/mark-paid', requireAdmin, (req, res) => {
  const ref = req.params.ref;
  const note = String(req.body?.note || 'manual');
  const result = seats_.confirmPayment({
    publicRef: ref,
    provider: 'manual',
    paymentRef: `MANUAL_${ref}_${Date.now()}`,
    raw: { manual: true, note, at: new Date().toISOString() },
  });
  if (!result.ok) return bad(res, 409, result.reason, result);
  res.json({ ok: true, registration: publicRegistration(result.registration) });
});

/** Quick numbers for the dashboard header. */
app.get('/api/admin/summary', requireAdmin, (req, res) => {
  const db = getDb();
  const now = new Date().toISOString();

  const upcoming = db
    .prepare(`SELECT COUNT(*) AS n FROM classes WHERE status='open' AND ends_at >= ?`)
    .get(now).n;
  const confirmed = db
    .prepare(`SELECT COUNT(*) AS n FROM registrations r
                JOIN classes c ON c.id = r.class_id
               WHERE r.status='confirmed' AND c.ends_at >= ?`)
    .get(now).n;
  const waiting = db
    .prepare(`SELECT COUNT(*) AS n FROM registrations r
                JOIN classes c ON c.id = r.class_id
               WHERE r.status='waitlist' AND c.ends_at >= ?`)
    .get(now).n;
  const revenue = db
    .prepare(`SELECT COALESCE(SUM(r.amount_cents),0) AS c FROM registrations r
                JOIN classes c ON c.id = r.class_id
               WHERE r.status='confirmed' AND c.ends_at >= ?`)
    .get(now).c;

  res.json({ ok: true, upcomingClasses: upcoming, confirmedStudents: confirmed,
             waitlisted: waiting, expectedRevenueCents: revenue });
});


// ----------------------------------------------------------- address lookup

/**
 * Suggestions for a partially typed address.
 *
 * Proxied rather than called from the page, so any API key stays on the server
 * and the browser never meets a CORS wall. Failures come back as an empty list
 * rather than an error — the customer can always type it out by hand.
 */
app.get('/api/address/suggest', async (req, res) => {
  const result = await address.suggest(req.query.q);
  res.json({ ok: true, ...result });
});

/**
 * City and state from a ZIP.
 *
 * Independent of the suggestion provider, so it works even when street
 * matching is unavailable or the customer just knows their ZIP.
 */
app.get('/api/address/zip', async (req, res) => {
  const found = await address.lookupZip(req.query.zip);
  if (!found) return bad(res, 404, 'zip_not_found');
  res.json({ ok: true, ...found });
});

/** Components for a chosen Google prediction. Not needed for Census. */
app.get('/api/address/details', async (req, res) => {
  const placeId = String(req.query.placeId || '');
  if (!placeId) return bad(res, 400, 'place_id_required');
  const result = await address.details(placeId);
  if (!result) return bad(res, 404, 'not_found');
  res.json({ ok: true, address: result });
});

// ------------------------------------------------------------------ calendar

/**
 * Downloadable .ics for a confirmed registration. Works with Apple Calendar,
 * Outlook, Thunderbird and phone calendars.
 */
app.get('/api/registrations/:ref/calendar.ics', (req, res) => {
  const reg = seats.findByRef(req.params.ref);
  if (!reg) return bad(res, 404, 'not_found');
  if (reg.status !== 'confirmed') return bad(res, 409, 'not_confirmed');

  const cls = seats.getClass(reg.class_id);
  const ics = calendar.buildIcs({
    cls, registration: reg, orgName: ORG_NAME, sessionMinutes: seats.SESSION_MINUTES,
  });

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${reg.public_ref}.ics"`);
  res.send(ics);
});

/** Links for the confirmation screen: Google in the browser, .ics for the rest. */
app.get('/api/registrations/:ref/calendar-links', (req, res) => {
  const reg = seats.findByRef(req.params.ref);
  if (!reg) return bad(res, 404, 'not_found');
  if (reg.status !== 'confirmed') return bad(res, 409, 'not_confirmed');

  const cls = seats.getClass(reg.class_id);
  res.json({
    ok: true,
    google: calendar.buildGoogleUrl({
      cls, registration: reg, orgName: ORG_NAME, sessionMinutes: seats.SESSION_MINUTES,
    }),
    ics: `/api/registrations/${reg.public_ref}/calendar.ics`,
  });
});

// ==========================================================================
// MOCK CHECKOUT — DELETE THIS BLOCK WHEN CONVERGE GOES LIVE
// ==========================================================================
if (payments.isMock) {
  app.get('/mock-checkout', (req, res) => {
    const reg = seats.findByRef(String(req.query.ref || ''));
    if (!reg) return res.status(404).send('Unknown registration.');
    const cls = seats.getClass(reg.class_id);
    const amount = (reg.amount_cents / 100).toFixed(2);

    res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock checkout</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:460px;margin:8vh auto;padding:0 24px;color:#141821}
  .warn{background:#fff8e1;border:1px solid #e8cf7a;color:#5c4a10;padding:12px 16px;border-radius:2px;font-size:14px}
  h1{font-size:22px;margin:24px 0 4px}
  .muted{color:#4a5261;font-size:14px}
  .amt{font-size:34px;font-weight:700;margin:18px 0}
  button{font:inherit;font-weight:600;padding:12px 20px;border:0;border-radius:2px;cursor:pointer;margin-right:8px}
  .go{background:#d8202f;color:#fff}
  .no{background:none;border:1.5px solid #141821;color:#141821}
  #out{margin-top:20px;font-size:14px}
</style></head><body>
  <div class="warn"><b>Mock checkout.</b> No card is charged. This page disappears when Elavon Converge goes live.</div>
  <h1>${cls.title}</h1>
  <div class="muted">${cls.starts_at} · ${cls.location}</div>
  <div class="amt">$${amount}</div>
  <div class="muted">Reference ${reg.public_ref}<br>Seat held until ${reg.hold_expires_at}</div>
  <p style="margin-top:24px">
    <button class="go" onclick="done('approve')">Simulate approval</button>
    <button class="no" onclick="done('decline')">Simulate decline</button>
  </p>
  <div id="out"></div>
<script>
async function done(outcome){
  const r = await fetch('/api/registrations/${reg.public_ref}/confirm', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ outcome })
  });
  const data = await r.json();
  document.getElementById('out').innerHTML = data.ok
    ? '<b style="color:#2a9d4e">Confirmed.</b> Reference ' + data.registration.ref
    : '<b style="color:#d8202f">Not confirmed:</b> ' + (data.detail || data.reason);
}
</script></body></html>`);
  });
}
// ======================================================= END MOCK CHECKOUT ==

// ------------------------------------------------------------------ startup

/**
 * What this build can do. The booking page checks this on load, so a page and
 * a server from different builds announce themselves instead of failing with
 * a confusing error halfway through a booking.
 */
const FEATURES = ['calendar', 'admin', 'groups', 'attendee-contacts', 'slots', 'travel', 'address-lookup', 'group-pricing', 'service-area'];

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    provider: payments.name,
    mock: payments.isMock,
    features: FEATURES,
  });
});

app.use((err, req, res, _next) => {
  // body-parser throws this on malformed JSON, which mostly means a hand-typed
  // curl with mangled quoting. A clean 400 beats a stack trace in the log.
  if (err?.type === 'entity.parse.failed') {
    return bad(res, 400, 'invalid_json', {
      hint: 'Request body was not valid JSON.',
    });
  }
  if (err?.type === 'entity.too.large') return bad(res, 413, 'body_too_large');

  console.error('[unhandled]', err);
  bad(res, 500, 'server_error');
});

/**
 * Refuse to start on a half-updated copy.
 *
 * These files change as a set. Copying only some of them produces errors that
 * point nowhere near the real cause — a group booking rejected as
 * "name_required", say — so check up front and name the stale file.
 */
function checkBuild() {
  const db = require('./db');
  const problems = [];

  if (typeof seats.holdSeats !== 'function') {
    problems.push('src/seats.js is out of date (no holdSeats — group bookings missing)');
  }
  if (typeof db.transaction !== 'function') {
    problems.push('src/db.js is out of date (no transaction helper)');
  }
  if (typeof seats.cancelGroup !== 'function') {
    problems.push('src/seats.js is out of date (no cancelGroup)');
  }
  if (typeof seats.daySlots !== 'function') {
    problems.push('src/seats.js is out of date (no daySlots — time slots missing)');
  }

  try {
    const cols = getDb().prepare('PRAGMA table_info(registrations)').all().map((c) => c.name);
    if (!cols.includes('group_ref')) {
      problems.push('the database is missing group columns — src/db.js did not migrate it');
    }
    if (!cols.includes('slot_start')) {
      problems.push('the database is missing slot columns — src/db.js did not migrate it');
    }
  } catch (err) {
    problems.push(`could not read the database: ${err.message}`);
  }

  if (problems.length) {
    console.error('\n  ✗ This copy is only half updated:\n');
    for (const p of problems) console.error(`      - ${p}`);
    console.error('\n  Copy the latest src/db.js, src/seats.js and src/server.js together,');
    console.error('  then start again. They change as a set.\n');
    process.exit(1);
  }
}

if (require.main === module) {
  getDb();
  checkBuild();

  // Housekeeping: expire lapsed holds and move the waitlist along.
  const sweepMs = Number(process.env.SWEEP_INTERVAL_MS || 60_000);
  setInterval(() => {
    try {
      const r = seats.sweepExpired();
      if (r.expiredHolds || r.expiredOffers || r.promoted) {
        console.log('[sweep]', r);
      }
    } catch (err) {
      console.error('[sweep] failed:', err.message);
    }
  }, sweepMs).unref();

  app.listen(PORT, () => {
    console.log(`Spectrum booking API on http://localhost:${PORT}`);
    console.log(`Serving the site from: ${SITE_DIR}`);
    console.log(`Payment provider: ${payments.name}`);
    console.log(`Address lookup:   ${address.PROVIDER}` +
      (address.PROVIDER === 'census'
        ? ' (free; set GOOGLE_PLACES_KEY for type-ahead)' : ''));
    console.log(`Hold window: ${seats.HOLD_MINUTES} minutes`);
  });
}

module.exports = app;
