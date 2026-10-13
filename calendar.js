'use strict';

/**
 * Calendar handoff for confirmed students.
 *
 * Two routes, because there's no single one that works everywhere:
 *   - Google Calendar takes a URL with the event in the query string.
 *   - Everything else (Apple Calendar, Outlook, Thunderbird, phone calendars)
 *     reads an .ics file.
 *
 * Times are emitted in UTC. The database stores ISO 8601 UTC, calendar apps
 * convert to the viewer's zone on import, so a student in Portland sees 9am
 * for an event stored as 16:00Z.
 */

/** 2026-09-21T16:00:00.000Z -> 20260921T160000Z */
function toCalendarStamp(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Escape per RFC 5545: backslash, semicolon and comma are delimiters, and
 * literal newlines have to become \n.
 */
function escapeIcsText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold lines at 75 octets, as the spec requires. Long descriptions silently
 * break in some clients otherwise. Continuation lines start with one space.
 */
function foldLine(line) {
  if (line.length <= 75) return line;
  const chunks = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    chunks.push(' ' + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  if (rest.length) chunks.push(' ' + rest);
  return chunks.join('\r\n');
}

function buildDescription({ cls, registration, orgName }) {
  return [
    `${cls.title} with ${orgName}.`,
    '',
    `Confirmation: ${registration.public_ref}`,
    registration.address ? `Address: ${registration.address}` : '',
    registration.address_notes ? `Notes: ${registration.address_notes}` : '',
    '',
    'The instructor comes to you. Wear comfortable clothes and have floor space',
    'ready for compressions. Certification cards are issued before they leave.',
  ].filter((l) => l !== null).join('\n');
}

/**
 * The calendar entry covers the session the customer booked, not the
 * instructor's whole working day. Falls back to the day window for bookings
 * made before slots existed.
 */
function eventTimes({ cls, registration, sessionMinutes = 240 }) {
  if (!registration.slot_start) return { start: cls.starts_at, end: cls.ends_at };
  const start = registration.slot_start;
  const end = new Date(new Date(start).getTime() + sessionMinutes * 60_000).toISOString();
  return { start, end };
}

/**
 * A full VCALENDAR for one registration.
 *
 * UID is derived from the confirmation reference, so re-importing updates the
 * existing entry instead of creating a duplicate.
 */
function buildIcs({ cls, registration, orgName = 'Spectrum CPR + First Aid',
                    domain = 'spectrumcpr.local', sessionMinutes = 240 }) {
  const now = toCalendarStamp(new Date().toISOString());
  const { start, end } = eventTimes({ cls, registration, sessionMinutes });

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${escapeIcsText(orgName)}//Booking//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${registration.public_ref}@${domain}`,
    `DTSTAMP:${now}`,
    `DTSTART:${toCalendarStamp(start)}`,
    `DTEND:${toCalendarStamp(end)}`,
    `SUMMARY:${escapeIcsText(cls.title)}`,
    `DESCRIPTION:${escapeIcsText(buildDescription({ cls, registration, orgName }))}`,
    `LOCATION:${escapeIcsText(registration.address || cls.location)}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    // Two nudges: the night before, and an hour out.
    'BEGIN:VALARM',
    'TRIGGER:-P1D',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeIcsText(cls.title)} is tomorrow`,
    'END:VALARM',
    'BEGIN:VALARM',
    'TRIGGER:-PT1H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeIcsText(cls.title)} starts in an hour`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  // RFC 5545 requires CRLF line endings.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** Prefilled Google Calendar event composer. */
function buildGoogleUrl({ cls, registration, orgName = 'Spectrum CPR + First Aid',
                          sessionMinutes = 240 }) {
  const { start, end } = eventTimes({ cls, registration, sessionMinutes });
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: cls.title,
    dates: `${toCalendarStamp(start)}/${toCalendarStamp(end)}`,
    details: buildDescription({ cls, registration, orgName }),
    location: registration.address || cls.location,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

module.exports = { buildIcs, buildGoogleUrl, toCalendarStamp, eventTimes };
