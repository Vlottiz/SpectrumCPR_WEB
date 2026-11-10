'use strict';

/**
 * Customer records.
 *
 * Two lists come out of the bookings:
 *
 *   billing   everyone who paid — name, contact, address, course, date,
 *             what they paid and how — including people later removed, so the
 *             books always add up.
 *   renewals  everyone certified, with the date their card expires (2 years
 *             after the class), for the reminder email.
 *
 * And two things happen on their own, from the sweeper:
 *
 *   - a renewal reminder is queued for each customer REMINDER_DAYS before
 *     their card expires (once), and
 *   - personal details are cleared RETENTION_DAYS after the class. Customers
 *     agree at checkout to their details being kept for up to 2 years; amounts
 *     and payment references stay, so the billing record still adds up.
 *
 * Reminders go into the outbox like every other email; they're sent once a
 * mail provider is connected.
 */

const { getDb } = require('./db');

const CERT_YEARS = 2;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 730);
const REMINDER_DAYS = Number(process.env.REMINDER_DAYS || 30);
const DAY_MS = 86_400_000;

const nowIso = () => new Date().toISOString();

/** The class a person took, as an ISO instant: their visit, or the day. */
const CERT_AT = 'COALESCE(r.slot_start, c.starts_at)';

function plusYears(iso, years) {
  const d = new Date(iso);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString();
}

/**
 * Everyone who has paid, newest first. Removed people are included and
 * marked, since their payment still happened.
 */
function billing() {
  return getDb()
    .prepare(
      `SELECT r.public_ref AS ref, r.group_ref AS groupRef,
              r.student_name AS name, r.student_email AS email, r.student_phone AS phone,
              r.address, r.organiser_name AS organiser,
              c.title AS course, c.course_code AS courseCode,
              ${CERT_AT} AS classAt,
              r.amount_cents AS seatCents, r.travel_cents AS travelCents,
              r.travel_zone AS zone,
              r.confirmed_at AS paidAt, r.payment_provider AS paidBy, r.payment_ref AS paymentRef,
              r.status, r.cancelled_at AS removedAt, r.consent_at AS consentAt,
              r.anonymized_at AS anonymizedAt
         FROM registrations r JOIN classes c ON c.id = r.class_id
        WHERE r.confirmed_at IS NOT NULL
        ORDER BY r.confirmed_at DESC, r.group_ref, r.seat_index`)
    .all()
    .map((x) => ({ ...x, removed: x.status === 'cancelled' }));
}

/**
 * Everyone certified whose details are still held, soonest-to-expire first.
 * withinDays limits it to cards expiring in that many days (past ones too).
 */
function renewals({ withinDays = null, now = nowIso() } = {}) {
  const rows = getDb()
    .prepare(
      `SELECT r.public_ref AS ref, r.student_name AS name, r.student_email AS email,
              r.student_phone AS phone, r.address,
              c.title AS course, c.course_code AS courseCode,
              ${CERT_AT} AS classAt, r.reminder_sent_at AS reminderSentAt, r.consent_at AS consentAt
         FROM registrations r JOIN classes c ON c.id = r.class_id
        WHERE r.status = 'confirmed' AND r.anonymized_at IS NULL
          AND ${CERT_AT} <= ?`)
    .all(now)
    .map((x) => {
      const expiresAt = plusYears(x.classAt, CERT_YEARS);
      return { ...x, expiresAt, daysLeft: Math.ceil((new Date(expiresAt) - new Date(now)) / DAY_MS) };
    })
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  return withinDays === null ? rows : rows.filter((x) => x.daysLeft <= withinDays);
}

/**
 * Queue one renewal reminder per email address per class, REMINDER_DAYS
 * before the card expires. A group whose attendees share the organiser's
 * address gets one email naming everyone. Runs from the sweeper; each person
 * is reminded once.
 */
function queueRenewalReminders(now = nowIso()) {
  const db = getDb();
  const due = renewals({ withinDays: REMINDER_DAYS, now })
    .filter((x) => !x.reminderSentAt && x.email && x.daysLeft > -30);
  if (!due.length) return 0;

  const byInbox = new Map();
  for (const x of due) {
    const key = `${x.email.toLowerCase()}|${x.courseCode}|${x.expiresAt.slice(0, 10)}`;
    if (!byInbox.has(key)) byInbox.set(key, []);
    byInbox.get(key).push(x);
  }

  const orgName = process.env.ORG_NAME || 'Spectrum CPR + First Aid';
  const insert = db.prepare(
    'INSERT INTO outbox (registration_id, to_email, subject, body) VALUES (?, ?, ?, ?)');
  const mark = db.prepare('UPDATE registrations SET reminder_sent_at = ? WHERE public_ref = ?');
  const regId = db.prepare('SELECT id FROM registrations WHERE public_ref = ?');
  const date = (iso) => new Date(iso).toLocaleDateString('en-US',
    { timeZone: process.env.BUSINESS_TZ || 'America/Los_Angeles', month: 'long', day: 'numeric', year: 'numeric' });

  db.transaction(() => {
    for (const people of byInbox.values()) {
      const first = people[0];
      const names = people.map((p) => p.name);
      insert.run(
        regId.get(first.ref)?.id ?? null,
        first.email,
        `Your ${first.course} card expires ${date(first.expiresAt)}`,
        [
          `Hi ${names.length > 1 ? 'there' : first.name},`,
          ``,
          `${names.length > 1 ? `The ${first.course} cards for ${names.join(', ')} expire`
                              : `Your ${first.course} card expires`} on ${date(first.expiresAt)}.`,
          ``,
          `Book a renewal class and we'll come to you, the same as last time.`,
          ``,
          `— ${orgName}`,
        ].join('\n'),
      );
      for (const p of people) mark.run(now, p.ref);
    }
  })();
  return byInbox.size;
}

/**
 * Clear personal details once RETENTION_DAYS have passed since the class.
 * Amounts, dates, course and payment references stay so the billing record
 * still adds up; names, emails, phones and addresses go. Emails written to
 * those people go too.
 */
function anonymizeExpired(now = nowIso()) {
  const db = getDb();
  const cutoff = new Date(new Date(now).getTime() - RETENTION_DAYS * DAY_MS).toISOString();
  const ids = db
    .prepare(
      `SELECT r.id FROM registrations r JOIN classes c ON c.id = r.class_id
        WHERE r.anonymized_at IS NULL AND ${CERT_AT} < ?`)
    .all(cutoff)
    .map((r) => r.id);
  if (!ids.length) return 0;

  const clear = db.prepare(
    `UPDATE registrations
        SET student_name = 'Details removed after 2 years', student_email = '',
            student_phone = '', address = '', address_notes = '', notes = '',
            organiser_name = NULL, anonymized_at = ?
      WHERE id = ?`);
  const mail = db.prepare('DELETE FROM outbox WHERE registration_id = ?');
  db.transaction(() => {
    for (const id of ids) { clear.run(now, id); mail.run(id); }
  })();
  return ids.length;
}

module.exports = {
  CERT_YEARS,
  RETENTION_DAYS,
  REMINDER_DAYS,
  plusYears,
  billing,
  renewals,
  queueRenewalReminders,
  anonymizeExpired,
};
