'use strict';

/**
 * Repeating weekly schedules and time off.
 *
 * A schedule is "these hours, these weekdays, these courses, always N weeks
 * ahead". fillSchedules() turns it into ordinary training days, one per course
 * per open date, and keeps topping the calendar up as time moves on — it runs
 * at startup and with every sweep, so the owners set their hours once and the
 * booking page never runs dry.
 *
 * Days it makes are normal days: they can be edited, cancelled or booked like
 * any other. A cancelled-and-cleared day is remembered in schedule_skips so the
 * next fill doesn't put it back.
 *
 * Time off blocks dates: no schedule fills them, unbooked days already there
 * are removed, and booked ones are left for staff to deal with.
 *
 * Schedule hours are wall-clock times in BUSINESS_TZ, converted per date, so
 * 9:00 stays 9:00 on both sides of a daylight saving change.
 */

const { getDb } = require('./db');
const seats = require('./seats');

const TZ = seats.BUSINESS_TZ;
const MAX_WEEKS_AHEAD = 26;

// ------------------------------------------------------------- date helpers

/** Calendar date arithmetic on "YYYY-MM-DD", free of any timezone. */
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekday(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Offset of a timezone from UTC at an instant, in ms (Pacific is negative). */
function tzOffsetMs(instant, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
                         +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** "2026-11-16" + "09:00" in the business's timezone -> UTC ISO string. */
function zonedToUtc(ymd, hhmm, tz = TZ) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, h, min);
  let t = wall - tzOffsetMs(new Date(wall), tz);
  // Near a clock change the first guess can use the wrong side's offset.
  const again = wall - tzOffsetMs(new Date(t), tz);
  if (again !== t) t = again;
  return new Date(t).toISOString();
}

const today = (now = new Date().toISOString()) => seats.localDate(now);

// ----------------------------------------------------------------- reading

function parseSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    courses: JSON.parse(row.courses),
    week: JSON.parse(row.week),
    weeksAhead: row.weeks_ahead,
    capacity: row.capacity,
    pricingTiers: row.pricing_tiers ? JSON.parse(row.pricing_tiers) : null,
    zoneLimits: row.zone_limits ? JSON.parse(row.zone_limits) : null,
    startsOn: row.starts_on,
    filledThrough: row.filled_through,
    active: Boolean(row.active),
  };
}

function getSchedule(id) {
  return parseSchedule(getDb().prepare('SELECT * FROM schedules WHERE id = ?').get(id));
}

function listSchedules() {
  return getDb().prepare('SELECT * FROM schedules ORDER BY id').all().map(parseSchedule);
}

function listTimeOff() {
  return getDb()
    .prepare('SELECT * FROM time_off WHERE ends_on >= ? ORDER BY starts_on')
    .all(today())
    .map((r) => ({ id: r.id, startsOn: r.starts_on, endsOn: r.ends_on, note: r.note }));
}

// ----------------------------------------------------------------- filling

/**
 * Create the days a schedule owes, from where it last got to up to its
 * horizon. Safe to call as often as you like: a date and course that already
 * has a day, was skipped, or is time off is left alone.
 */
function fillSchedule(id, now = new Date().toISOString()) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  const s = parseSchedule(row);
  if (!s || !s.active) return 0;

  const first = [s.startsOn, today(now), s.filledThrough ? addDays(s.filledThrough, 1) : null]
    .filter(Boolean).sort().pop();
  const horizon = addDays(today(now), s.weeksAhead * 7 - 1);
  if (first > horizon) return 0;

  // What this schedule already has in range, so nothing is made twice.
  const have = new Set(db
    .prepare(`SELECT course_code, starts_at FROM classes
               WHERE schedule_id = ? AND starts_at >= ?`)
    .all(id, zonedToUtc(first, '00:00'))
    .map((c) => `${seats.localDate(c.starts_at)}|${c.course_code}`));
  const skipped = new Set(db
    .prepare('SELECT day, course_code FROM schedule_skips WHERE schedule_id = ? AND day >= ?')
    .all(id, first)
    .map((k) => `${k.day}|${k.course_code}`));

  const insert = db.prepare(
    `INSERT INTO classes
       (course_code, title, starts_at, ends_at, location, capacity, price_cents,
        pricing_tiers, zone_limits, schedule_id)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`);

  let made = 0;
  db.transaction(() => {
    for (let day = first; day <= horizon; day = addDays(day, 1)) {
      const hours = s.week[weekday(day)];
      if (!hours || !hours.on) continue;
      if (seats.isTimeOff(day)) continue;

      const startsAt = zonedToUtc(day, hours.open);
      const endsAt = zonedToUtc(day, hours.close);
      if (endsAt <= now) continue;            // today's hours are already over

      for (const c of s.courses) {
        const key = `${day}|${c.code}`;
        if (have.has(key) || skipped.has(key)) continue;
        // Always the course's current price, so every week matches.
        insert.run(c.code, c.title, startsAt, endsAt, s.capacity,
                   seats.coursePrice(c.code) ?? c.priceCents,
                   row.pricing_tiers, row.zone_limits, id);
        made++;
      }
    }
    db.prepare('UPDATE schedules SET filled_through = ? WHERE id = ?').run(horizon, id);
  })();
  return made;
}

/** Top up every active schedule. Run at startup and on each sweep. */
function fillSchedules(now = new Date().toISOString()) {
  return getDb()
    .prepare('SELECT id FROM schedules WHERE active = 1')
    .all()
    .reduce((n, r) => n + fillSchedule(r.id, now), 0);
}

/**
 * Remove a schedule's days that haven't finished and that nobody is on, so
 * they can be made again from new settings. Days with bookings or a waitlist
 * are kept.
 */
function clearFutureDays(id, now = new Date().toISOString()) {
  const db = getDb();
  const ids = db
    .prepare(
      `SELECT c.id FROM classes c
        WHERE c.schedule_id = ? AND c.ends_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM registrations r
             WHERE r.class_id = c.id
               AND (   r.status IN ('confirmed','waitlist')
                    OR (r.status = 'held'    AND r.hold_expires_at  > ?)
                    OR (r.status = 'offered' AND r.offer_expires_at > ?)))`)
    .all(id, now, now, now)
    .map((r) => r.id);
  const del = db.prepare('DELETE FROM classes WHERE id = ?');
  db.transaction(() => ids.forEach((x) => del.run(x)))();
  return ids.length;
}

// --------------------------------------------------------------- validation

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Check a schedule as sent by the admin page. Returns { value } ready to
 * store, or { error } in words staff can act on.
 */
function cleanSchedule(body, { sessionMinutes }) {
  const b = body || {};
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  if (!Array.isArray(b.courses) || !b.courses.length) {
    return { error: 'Pick at least one course to offer.' };
  }
  const courses = [];
  for (const c of b.courses) {
    const code = String(c?.code || '').trim();
    const known = seats.courses().find((x) => x.code === code);
    const title = String(c?.title || known?.title || '').trim();
    // Prices are set per course, not per schedule; one sent here is ignored
    // for a known course.
    const priceCents = known ? known.priceCents : Number(c?.priceCents);
    if (!code || title.length < 2) return { error: 'Each course needs a name.' };
    if (!Number.isInteger(priceCents) || priceCents < 0) {
      return { error: `Enter a price for ${title}.` };
    }
    if (courses.some((x) => x.code === code)) return { error: `${title} is listed twice.` };
    courses.push({ code, title, priceCents });
  }

  if (!Array.isArray(b.week) || b.week.length !== 7) return { error: 'Set the weekly hours.' };
  const week = b.week.map((d) => ({
    on: Boolean(d && d.on), open: String(d?.open || ''), close: String(d?.close || ''),
  }));
  if (!week.some((d) => d.on)) return { error: 'Tick at least one open day.' };
  for (const [i, d] of week.entries()) {
    if (!d.on) continue;
    if (!HHMM.test(d.open) || !HHMM.test(d.close)) return { error: `${DAY[i]}: set opening and closing times.` };
    const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    if (mins(d.close) <= mins(d.open)) return { error: `${DAY[i]}: closing time must be after opening.` };
    if (mins(d.close) - mins(d.open) < sessionMinutes) {
      const h = sessionMinutes / 60;
      return { error: `${DAY[i]}: open at least ${h} hour${h === 1 ? '' : 's'} — one full session.` };
    }
  }

  const weeksAhead = Number(b.weeksAhead);
  if (!Number.isInteger(weeksAhead) || weeksAhead < 1 || weeksAhead > MAX_WEEKS_AHEAD) {
    return { error: `Keep between 1 and ${MAX_WEEKS_AHEAD} weeks open.` };
  }
  const capacity = Number(b.capacity);
  if (!Number.isInteger(capacity) || capacity < 1) return { error: 'Set at least one place.' };

  const startsOn = /^\d{4}-\d{2}-\d{2}$/.test(String(b.startsOn || '')) ? b.startsOn : today();

  return { value: { courses, week, weeksAhead, capacity, startsOn } };
}

// ------------------------------------------------------------------ writing

function createSchedule(v, { pricingTiers = null, zoneLimits = null } = {}) {
  const info = getDb()
    .prepare(
      `INSERT INTO schedules
         (courses, week, weeks_ahead, capacity, pricing_tiers, zone_limits, starts_on)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(JSON.stringify(v.courses), JSON.stringify(v.week), v.weeksAhead, v.capacity,
         pricingTiers, zoneLimits, v.startsOn);
  const id = Number(info.lastInsertRowid);
  return { id, created: fillSchedule(id) };
}

/**
 * Change a schedule. Its future days with nobody on them are rebuilt from the
 * new settings; days people have booked keep the hours and price they booked.
 */
function updateSchedule(id, v, { pricingTiers = null, zoneLimits = null } = {}) {
  const db = getDb();
  db.prepare(
    `UPDATE schedules
        SET courses = ?, week = ?, weeks_ahead = ?, capacity = ?,
            pricing_tiers = ?, zone_limits = ?, starts_on = ?, filled_through = NULL
      WHERE id = ?`)
    .run(JSON.stringify(v.courses), JSON.stringify(v.week), v.weeksAhead, v.capacity,
         pricingTiers, zoneLimits, v.startsOn, id);
  const removed = clearFutureDays(id);
  return { removed, created: fillSchedule(id) };
}

function setScheduleActive(id, active) {
  getDb().prepare('UPDATE schedules SET active = ?, filled_through = NULL WHERE id = ?')
    .run(active ? 1 : 0, id);
  return active ? fillSchedule(id) : 0;
}

/** Delete a schedule and its unbooked future days. Booked days stay, unlinked. */
function deleteSchedule(id) {
  const db = getDb();
  const removed = clearFutureDays(id);
  db.transaction(() => {
    db.prepare('UPDATE classes SET schedule_id = NULL WHERE schedule_id = ?').run(id);
    db.prepare('DELETE FROM schedule_skips WHERE schedule_id = ?').run(id);
    db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  })();
  return { removed };
}

/**
 * Block out dates. Unbooked days inside are removed; days with people on them
 * are kept and returned, so staff can contact those customers.
 */
function addTimeOff({ startsOn, endsOn, note = '' }, now = new Date().toISOString()) {
  const db = getDb();
  const info = db.prepare('INSERT INTO time_off (starts_on, ends_on, note) VALUES (?, ?, ?)')
    .run(startsOn, endsOn, String(note).slice(0, 120));

  const inRange = db
    .prepare(`SELECT * FROM classes WHERE status = 'open' AND starts_at > ?
               AND starts_at BETWEEN ? AND ?`)
    .all(now, zonedToUtc(addDays(startsOn, -1), '00:00'), zonedToUtc(addDays(endsOn, 2), '00:00'))
    .filter((c) => {
      const d = seats.localDate(c.starts_at);
      return d >= startsOn && d <= endsOn;
    });

  const removed = [];
  const kept = [];
  const del = db.prepare('DELETE FROM classes WHERE id = ?');
  db.transaction(() => {
    for (const c of inRange) {
      const people = db.prepare(
        `SELECT COUNT(*) AS n FROM registrations WHERE class_id = ?
           AND (status IN ('confirmed','waitlist')
                OR (status = 'held'    AND hold_expires_at  > ?)
                OR (status = 'offered' AND offer_expires_at > ?))`).get(c.id, now, now).n;
      if (people) kept.push({ id: c.id, title: c.title, startsAt: c.starts_at, people });
      else { del.run(c.id); removed.push(c.id); }
    }
  })();
  return { id: Number(info.lastInsertRowid), removed: removed.length, kept };
}

/** Lift time off. Schedules refill the dates it was covering. */
function removeTimeOff(id) {
  const db = getDb();
  db.prepare('DELETE FROM time_off WHERE id = ?').run(id);
  db.prepare('UPDATE schedules SET filled_through = NULL WHERE active = 1').run();
  return fillSchedules();
}

module.exports = {
  MAX_WEEKS_AHEAD,
  addDays,
  weekday,
  zonedToUtc,
  getSchedule,
  listSchedules,
  listTimeOff,
  fillSchedule,
  fillSchedules,
  clearFutureDays,
  cleanSchedule,
  createSchedule,
  updateSchedule,
  setScheduleActive,
  deleteSchedule,
  addTimeOff,
  removeTimeOff,
};
