'use strict';

/**
 * Drives index.html in a headless DOM against the live API: loads the
 * schedule, books a seat through the modal, and checks the calendar handoff.
 *
 *   node test/frontend.test.js
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = process.env.FE_PORT || 3921;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function check(label, cond, detail = '') {
  if (cond) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.log(`  \u2717 ${label}${detail ? `\n      ${detail}` : ''}`);
    failed++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition, polling, rather than guessing at fixed delays. */
async function until(fn, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fn()) return true;
    } catch { /* not ready yet */ }
    await sleep(50);
  }
  return false;
}

(async () => {
  process.env.DB_PATH = `/tmp/fe-test-${process.pid}.db`;
  process.env.PORT = String(PORT);
  process.env.PAYMENT_PROVIDER = 'mock';
  process.env.ADMIN_TOKEN = 'fe-test';

  // Fresh database with the sample classes.
  for (const f of [process.env.DB_PATH, `${process.env.DB_PATH}-wal`, `${process.env.DB_PATH}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  require('../src/seed').seed();

  const app = require('../src/server');
  const server = app.listen(PORT);
  await sleep(300);

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  const virtualConsole = new VirtualConsole();
  const pageErrors = [];
  virtualConsole.on('jsdomError', (e) => pageErrors.push(e.message));

  const dom = new JSDOM(html, {
    url: BASE,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    // jsdom ships no fetch. Inject Node's before the page's own script runs,
    // since that script calls the API as soon as it parses. Browsers have
    // fetch natively, so this is a harness gap rather than a page problem.
    beforeParse(win) {
      win.fetch = (url, opts) =>
        fetch(String(url).startsWith('http') ? String(url) : BASE + String(url), opts);
    },
  });

  const { window } = dom;
  const doc = window.document;

  console.log('\nschedule rendering');

  const loaded = await until(() => doc.querySelectorAll('#scheduleRows .sched-class').length > 0);
  check('the schedule loads from the API', loaded, `page errors: ${pageErrors.join('; ')}`);

  const rows = doc.querySelectorAll('#scheduleRows .sched-class');
  check('four seeded days render', rows.length === 4, `got ${rows.length}`);

  check('each date gets its own block',
    doc.querySelectorAll('#scheduleRows .sched-day').length === 4,
    `${doc.querySelectorAll('#scheduleRows .sched-day').length} day blocks`);
  const weekHeads = [...doc.querySelectorAll('#scheduleRows .sched-week h3')].map((h) => h.textContent);
  check('days are grouped under week headings',
    weekHeads.length >= 2 && weekHeads.every((h) => /week/i.test(h)), weekHeads.join(' | '));
  const dayBlock = doc.querySelector('#scheduleRows .sched-day .day-date')?.textContent || '';
  check('a day block names the weekday',
    /(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/.test(dayBlock), dayBlock);

  const firstRow = rows[0]?.textContent || '';
  check('a course title appears', firstRow.includes('CPR / AED'), firstRow.slice(0, 80));
  check('availability appears',
    /\d+ time slots? available · \d+ seats? available/.test(firstRow.replace(/\s+/g, ' ')),
    firstRow.replace(/\s+/g, ' ').slice(0, 100));

  check('times render in local form, not raw UTC',
    !firstRow.includes('T16:00:00'), firstRow.slice(0, 80));

  const filterButtons = doc.querySelectorAll('#courseFilter button');
  check('a course filter is offered', filterButtons.length === 4, `${filterButtons.length} buttons`);
  window.Booking.showCourse('HEARTSAVER');
  const filtered = [...doc.querySelectorAll('#scheduleRows .sched-class')].map((r) => r.textContent);
  check('filtering shows only that course',
    filtered.length === 1 && filtered[0].includes('Heartsaver'), filtered.join(' | ').slice(0, 120));
  window.Booking.showCourse(null);
  check('and All brings the rest back',
    doc.querySelectorAll('#scheduleRows .sched-class').length === 4);

  const nextPanel = doc.getElementById('nextClasses')?.textContent || '';
  check('the home panel fills in', nextPanel.includes('CPR / AED'), nextPanel.slice(0, 80));

  console.log('\nbooking through the modal');

  window.Booking.open(1);
  await sleep(400);

  check('the modal opens', doc.getElementById('bookVeil').classList.contains('open'));

  doc.getElementById('bookVeil').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(100);
  check('a click outside or Escape does not close it',
    doc.getElementById('bookVeil').classList.contains('open'));
  check('it names the course', doc.getElementById('bookTitle').textContent === 'CPR / AED');
  check('the price shows', (doc.getElementById('bookBody').textContent || '').includes('85.00'));
  check('a solo booking is told about the surcharge',
    await until(() => (doc.getElementById('priceWhy').textContent || '').includes('Small group'), 3000),
    doc.getElementById('priceWhy').textContent.slice(0, 120));
  check('and the adjusted price is shown',
    (doc.getElementById('priceLine').textContent || '').includes('93.50'),
    doc.getElementById('priceLine').textContent);

  check('times load', await until(() => doc.querySelectorAll('.slot-btn').length > 0),
    doc.getElementById('slotArea')?.textContent);
  check('a ten hour day offers 13 starts',
    doc.querySelectorAll('.slot-btn').length === 13,
    `${doc.querySelectorAll('.slot-btn').length} buttons`);
  check('an address field is asked for', !!doc.getElementById('fAddress'));

  // Nothing should go through without a time.
  const fillAddress = () => {
    doc.getElementById('fAddress').value = '1200 SW Main St';
    doc.getElementById('fCity').value = 'Hillsboro';
    doc.getElementById('fState').value = 'OR';
    doc.getElementById('fZip').value = '97123';
  };

  doc.getElementById('fName0').value = 'Jane Doe';
  doc.getElementById('fEmail').value = 'jane@example.com';
  fillAddress();
  window.Booking.hold();
  await sleep(200);
  check('a booking with no time is refused',
    (doc.getElementById('bookErr').textContent || '').includes('pick a time'),
    doc.getElementById('bookErr').textContent);

  const firstSlot = doc.querySelector('.slot-btn:not([disabled])');
  const pickedTime = firstSlot.textContent.trim();
  firstSlot.click();
  await sleep(120);
  check('picking a time marks it',
    doc.querySelector('.slot-btn.picked')?.textContent.trim() === pickedTime);

  // ...nor without somewhere to go.
  doc.getElementById('fAddress').value = 'x';
  window.Booking.hold();
  await sleep(200);
  check('a short street is refused',
    (doc.getElementById('bookErr').textContent || '').includes('street address'),
    doc.getElementById('bookErr').textContent);

  fillAddress();
  doc.getElementById('fZip').value = '123';
  window.Booking.hold();
  await sleep(200);
  check('a short ZIP is refused',
    (doc.getElementById('bookErr').textContent || '').includes('ZIP'),
    doc.getElementById('bookErr').textContent);

  doc.getElementById('fState').value = '';
  doc.getElementById('fZip').value = '97123';
  window.Booking.hold();
  await sleep(200);
  check('a missing state is refused',
    (doc.getElementById('bookErr').textContent || '').includes('state'),
    doc.getElementById('bookErr').textContent);

  fillAddress();

  // Validation before anything is sent.
  doc.getElementById('fName0').value = 'A';
  window.Booking.hold();
  await sleep(200);
  check('a too-short name is refused',
    doc.getElementById('bookErr').classList.contains('show'));

  doc.getElementById('fName0').value = 'Jane Doe';
  doc.getElementById('fEmail').value = 'not-an-email';
  window.Booking.hold();
  await sleep(200);
  check('a bad email is refused',
    (doc.getElementById('bookErr').textContent || '').includes('valid email'));

  // The real thing.
  doc.getElementById('fEmail').value = 'jane@example.com';
  doc.getElementById('fPhone').value = '5035551234';
  window.Booking.hold();

  const held = await until(() => doc.getElementById('holdClock'));
  check('the seat is held', held);

  const clock = doc.getElementById('holdClock')?.textContent || '';
  check('the countdown starts near 20:00', /^(20:00|19:5\d)$/.test(clock), `got "${clock}"`);
  check('test-mode payment is flagged',
    (doc.getElementById('bookBody').textContent || '').includes('No card is charged'));

  const seatsAfterHold = await (await fetch(`${BASE}/api/classes/1`)).json();
  check('the held place leaves the pool',
    seatsAfterHold.class.seatsAvailable === 19,
    `got ${seatsAfterHold.class.seatsAvailable}`);

  const slotsAfterHold = await (await fetch(`${BASE}/api/classes/1/slots`)).json();
  // 4 hours on site plus 90 minutes to move on takes out eleven half-hour
  // starts, leaving only the last two on a 10 hour day.
  check('the booked time plus its buffer is blocked',
    slotsAfterHold.slots.filter((s) => s.reason === 'booked').length === 11,
    `${slotsAfterHold.slots.filter((s) => s.reason === 'booked').length} blocked`);

  console.log('\npayment and confirmation');

  window.Booking.pay('approve');
  const done = await until(() =>
    (doc.getElementById('bookBody').textContent || '').includes("You're registered"));
  check('payment confirms', done);

  const refChip = doc.querySelector('.ref-chip')?.textContent || '';
  check('a confirmation reference shows', /^SPC-[A-Z0-9]{6}$/.test(refChip), `got "${refChip}"`);

  const gotLinks = await until(() => {
    const g = doc.getElementById('calGoogle');
    return g && g.href && g.href.includes('calendar.google.com');
  });
  check('the Google Calendar link is built', gotLinks,
    doc.getElementById('calGoogle')?.href || 'no href');

  const googleHref = doc.getElementById('calGoogle')?.href || '';
  check('the Google link carries the course name', googleHref.includes('CPR'));
  check('the Google link carries start and end times', /dates=\d{8}T\d{6}Z/.test(googleHref));

  const icsHref = doc.getElementById('calIcs')?.getAttribute('href') || '';
  check('the .ics link is built', icsHref.includes('/calendar.ics'), `got "${icsHref}"`);

  const icsRes = await fetch(BASE + icsHref);
  const icsBody = await icsRes.text();
  check('the .ics downloads as a calendar file',
    (icsRes.headers.get('content-type') || '').includes('text/calendar'));
  check('the .ics is a valid event',
    icsBody.includes('BEGIN:VEVENT') && icsBody.includes('SUMMARY:CPR'));
  check('the .ics is offered as a download',
    (icsRes.headers.get('content-disposition') || '').includes('.ics'));

  console.log('\nfull classes');

  // One seat, taken, so the next person meets the waitlist.
  const made = await (await fetch(`${BASE}/api/admin/classes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'fe-test' },
    body: JSON.stringify({
      courseCode: 'CPR', title: 'Tiny day',
      startsAt: '2027-05-04T16:00:00Z', endsAt: '2027-05-05T02:00:00Z',
      capacity: 1, priceCents: 8500,
    }),
  })).json();

  const madeSlots = await (await fetch(`${BASE}/api/classes/${made.classId}/slots`)).json();
  await fetch(`${BASE}/api/classes/${made.classId}/hold`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Someone Else', email: 'else@example.com',
      slotStart: madeSlots.slots.find((s) => s.available).start,
      address: '900 NE Oak St, Hillsboro OR 97124',
    }),
  });

  window.Booking.close();
  await window.Booking.load();
  await sleep(200);

  window.Booking.open(made.classId);
  await sleep(400);

  const modalText = doc.getElementById('bookBody').textContent || '';
  check('a full class offers the waitlist', modalText.includes('waitlist'), modalText.slice(0, 100));
  check('and asks for no payment', modalText.includes('No payment now'));

  doc.getElementById('fName0').value = 'Waiting Person';
  doc.getElementById('fEmail').value = 'waiting@example.com';
  window.Booking.joinWaitlist();

  const joined = await until(() =>
    (doc.getElementById('bookBody').textContent || '').includes("You're on the list"));
  check('joining the waitlist works', joined);
  check('it gives a position',
    (doc.getElementById('bookBody').textContent || '').includes('number 1'));


  /** Fill in the shared fields and pick the first free time. */
  async function fillBooking({ email }) {
    await until(() => doc.querySelectorAll('.slot-btn:not([disabled])').length > 0);
    doc.querySelector('.slot-btn:not([disabled])').click();
    await sleep(80);
    doc.getElementById('fEmail').value = email;
    doc.getElementById('fAddress').value = '1200 SW Main St';
    doc.getElementById('fCity').value = 'Hillsboro';
    doc.getElementById('fState').value = 'OR';
    doc.getElementById('fZip').value = '97123';
  }

  console.log('\ngroup booking');

  window.Booking.close();
  await window.Booking.load();
  await sleep(200);
  window.Booking.open(2);            // Heartsaver
  await sleep(400);

  check('the seat picker is there', !!doc.getElementById('qtyVal'));
  check('it starts at one seat', doc.getElementById('qtyVal').textContent === '1');
  check('one seat shows a single name field', !!doc.getElementById('fName0')
    && !doc.getElementById('fName1'));
  check('you cannot go below one', doc.getElementById('qtyDown').disabled);

  window.Booking.setQty(1);
  window.Booking.setQty(1);
  await sleep(120);

  check('the count rises', doc.getElementById('qtyVal').textContent === '3');
  check('a name field appears per attendee',
    !!doc.getElementById('fName0') && !!doc.getElementById('fName1') && !!doc.getElementById('fName2'));
  // Heartsaver is 95.00; three people sit in the -5% band at 90.25 each.
  check('the running total shows',
    await until(() => (doc.getElementById('totalLine').textContent || '').includes('270.75'), 3000),
    doc.getElementById('totalLine').textContent);
  check('the discount is explained',
    (doc.getElementById('priceWhy').textContent || '').includes('Group discount'),
    doc.getElementById('priceWhy').textContent.slice(0, 120));
  check('it explains why each name is needed',
    (doc.getElementById('groupNote').textContent || '').includes('certification card'));

  // Names survive changing the count.
  doc.getElementById('fName0').value = 'Ana Reyes';
  doc.getElementById('fName1').value = 'Ben Cole';
  window.Booking.setQty(1);
  await sleep(120);
  check('typed names survive adding a seat',
    doc.getElementById('fName0').value === 'Ana Reyes'
    && doc.getElementById('fName1').value === 'Ben Cole');

  window.Booking.setQty(-1);
  await sleep(120);
  check('and survive removing one', doc.getElementById('fName0').value === 'Ana Reyes');

  // A missing name blocks the booking, naming the offender.
  doc.getElementById('fName2').value = '';
  await fillBooking({ email: 'manager@daycare.com' });
  window.Booking.hold();
  await sleep(250);
  check('a blank attendee is caught',
    (doc.getElementById('bookErr').textContent || '').includes('attendee 3'),
    doc.getElementById('bookErr').textContent);

  doc.getElementById('fName2').value = 'Cara Diaz';
  doc.getElementById('fPhone').value = '5035550000';
  window.Booking.hold();

  check('three seats are held', await until(() => doc.getElementById('holdClock')));

  const payText = doc.getElementById('bookBody').textContent || '';
  check('the payment step shows the group total', payText.includes('270.75'), payText.slice(0, 200));
  check('it lists the attendees',
    payText.includes('Ana Reyes') && payText.includes('Cara Diaz'), payText.slice(0, 200));
  check('it says how many seats are held', payText.includes('3 seats held'), payText.slice(0, 100));

  const afterHold = await (await fetch(`${BASE}/api/classes/2`)).json();
  check('three places leave the pool', afterHold.class.seatsAvailable === 21,
    `got ${afterHold.class.seatsAvailable}`);

  window.Booking.pay('approve');
  check('one payment confirms the group',
    await until(() => (doc.getElementById('bookBody').textContent || '').includes('3 seats booked')));

  const doneText = doc.getElementById('bookBody').textContent || '';
  check('the confirmation lists everyone',
    doneText.includes('Ana Reyes') && doneText.includes('Ben Cole') && doneText.includes('Cara Diaz'));
  check('a group reference is shown',
    /GRP-[A-Z0-9]{6}/.test(doc.querySelector('.ref-chip')?.textContent || ''),
    doc.querySelector('.ref-chip')?.textContent);
  check('it mentions individual cards', doneText.includes('own certification card'));

  const roster = await (await fetch(`${BASE}/api/admin/classes/2/roster`, {
    headers: { 'x-admin-token': 'fe-test' },
  })).json();
  check('all three are on the roster',
    roster.roster.filter((r) => r.status === 'confirmed').length === 3,
    `${roster.roster.length} rows`);
  check('they share one contact email',
    new Set(roster.roster.map((r) => r.student_email)).size === 1);
  check('but keep separate names',
    new Set(roster.roster.map((r) => r.student_name)).size === 3);

  console.log('\ngroup limits');

  // A class with 2 seats left can't take a group of 3.
  const tight = await (await fetch(`${BASE}/api/admin/classes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'fe-test' },
    body: JSON.stringify({
      courseCode: 'CPR', title: 'Nearly full',
      startsAt: '2026-11-20T16:00:00Z', endsAt: '2026-11-21T02:00:00Z',
      capacity: 2, priceCents: 8500,
    }),
  })).json();

  window.Booking.close();
  await window.Booking.load();
  await sleep(200);
  window.Booking.open(tight.classId);
  await sleep(400);

  window.Booking.setQty(1);
  await sleep(200);
  check('the picker stops at the seats available',
    doc.getElementById('qtyVal').textContent === '2'
    && doc.getElementById('qtyUp').disabled,
    `qty ${doc.getElementById('qtyVal').textContent}`);


  console.log('\nper-attendee contacts');

  window.Booking.close();
  await window.Booking.load();
  await sleep(200);
  window.Booking.open(3);            // Pediatric
  await sleep(400);
  window.Booking.setQty(1);
  await sleep(200);

  check('each attendee offers its own contact toggle', !!doc.getElementById('attToggle0'));
  check('the extra fields start hidden',
    !doc.getElementById('attExtra0').classList.contains('open'));

  window.Booking.toggleContact(1);
  await sleep(100);
  check('the toggle reveals email and phone',
    doc.getElementById('attExtra1').classList.contains('open')
    && !!doc.getElementById('fEmail1') && !!doc.getElementById('fPhone1'));
  check('the toggle label flips',
    (doc.getElementById('attToggle1').textContent || '').includes('Hide'));

  doc.getElementById('fName0').value = 'Dana Manager';
  doc.getElementById('fName1').value = 'Ed Nguyen';
  doc.getElementById('fEmail1').value = 'not-an-email';
  await fillBooking({ email: 'dana@daycare.com' });
  window.Booking.hold();
  await sleep(250);
  check('a malformed attendee email is caught',
    (doc.getElementById('bookErr').textContent || '').includes('attendee 2'),
    doc.getElementById('bookErr').textContent);

  doc.getElementById('fEmail1').value = 'ed@own.com';
  doc.getElementById('fPhone1').value = '5035551111';
  window.Booking.hold();
  check('the booking goes through', await until(() => doc.getElementById('holdClock')));

  window.Booking.pay('approve');
  check('it confirms',
    await until(() => (doc.getElementById('bookBody').textContent || '').includes('2 seats booked')));

  const r3 = await (await fetch(`${BASE}/api/admin/classes/3/roster`, {
    headers: { 'x-admin-token': 'fe-test' },
  })).json();
  const ed = r3.roster.find((p) => p.student_name === 'Ed Nguyen');
  const dana = r3.roster.find((p) => p.student_name === 'Dana Manager');
  check('the attendee keeps their own email', ed?.student_email === 'ed@own.com',
    ed?.student_email);
  check('and their own phone', ed?.student_phone === '5035551111', ed?.student_phone);
  check('the organiser keeps the booking email', dana?.student_email === 'dana@daycare.com',
    dana?.student_email);

  const outbox = await (await fetch(`${BASE}/api/admin/outbox`, {
    headers: { 'x-admin-token': 'fe-test' },
  })).json();
  check('the attendee is emailed directly',
    outbox.outbox.some((m) => m.to_email === 'ed@own.com'),
    outbox.outbox.map((m) => m.to_email).join(', '));


  console.log('\nphone formatting');

  const fmt = window.Booking._formatPhone;
  check('a full number formats', fmt('5035551234') === '(503) 555-1234', fmt('5035551234'));
  check('it formats as you type', fmt('50355') === '(503) 55', fmt('50355'));
  check('three digits stay bare', fmt('503') === '503', fmt('503'));
  check('existing punctuation is reflowed',
    fmt('(503)555-1234') === '(503) 555-1234', fmt('(503)555-1234'));
  check('a leading country code is kept',
    fmt('15035551234') === '1 (503) 555-1234', fmt('15035551234'));
  check('letters are stripped', fmt('503abc5551234') === '(503) 555-1234', fmt('503abc5551234'));
  check('an international number is left alone',
    fmt('+44 20 7946 0958') === '+44 20 7946 0958', fmt('+44 20 7946 0958'));
  check('extra digits are dropped', fmt('50355512349999') === '(503) 555-1234',
    fmt('50355512349999'));
  check('an empty value stays empty', fmt('') === '');

  window.Booking.close();
  await window.Booking.load();
  await sleep(200);
  window.Booking.open(4);
  await sleep(400);

  const phoneField = doc.getElementById('fPhone');
  phoneField.value = '5035551234';
  phoneField.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(80);
  check('typing into the phone field formats it',
    phoneField.value === '(503) 555-1234', phoneField.value);

  console.log('\nemail suggestions');

  const emailField = doc.getElementById('fEmail');
  emailField.value = 'nick@g';
  window.Booking._showSuggest(emailField);
  await sleep(80);

  const box = doc.querySelector('.email-suggest');
  check('a suggestion list appears', box && box.classList.contains('open'));
  check('it suggests gmail', (box.textContent || '').includes('gmail.com'), box.textContent);
  check('it keeps what was typed', (box.textContent || '').includes('nick@'), box.textContent);

  emailField.value = 'nick@out';
  window.Booking._showSuggest(emailField);
  await sleep(80);
  check('typing narrows the list',
    (box.textContent || '').includes('outlook.com')
    && !(box.textContent || '').includes('gmail.com'), box.textContent);

  emailField.value = 'nick@gmail.com';
  window.Booking._showSuggest(emailField);
  await sleep(80);
  check('an exact match closes the list', !box.classList.contains('open'));

  emailField.value = 'nick@zzzz';
  window.Booking._showSuggest(emailField);
  await sleep(80);
  check('an unknown domain offers nothing', !box.classList.contains('open'));

  emailField.value = 'nonameyet';
  window.Booking._showSuggest(emailField);
  await sleep(80);
  check('nothing shows before an @', !box.classList.contains('open'));

  emailField.value = 'nick@g';
  window.Booking._showSuggest(emailField);
  await sleep(80);
  const suggestRow = doc.querySelector('.email-suggest div');
  suggestRow.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await sleep(80);
  check('picking one completes the address',
    emailField.value === 'nick@gmail.com', emailField.value);
  check('and the list closes', !box.classList.contains('open'));

  window.Booking._hideSuggest();


  console.log('\naddress fields');

  window.Booking.close();
  await window.Booking.load();
  await sleep(200);
  window.Booking.open(1);
  await sleep(400);

  check('street, city, state and ZIP are separate fields',
    !!doc.getElementById('fAddress') && !!doc.getElementById('fCity')
    && !!doc.getElementById('fState') && !!doc.getElementById('fZip'));
  check('a unit line is offered', !!doc.getElementById('fUnit'));
  check('the state list covers all fifty plus DC',
    doc.getElementById('fState').options.length === 52,
    `${doc.getElementById('fState').options.length} options`);

  doc.getElementById('fAddress').value = '1200 SW Main St';
  doc.getElementById('fUnit').value = 'Suite 300';
  doc.getElementById('fCity').value = 'Hillsboro';
  doc.getElementById('fState').value = 'OR';
  doc.getElementById('fZip').value = '97123';

  check('the parts compose into one line',
    window.Booking._composeAddress() === '1200 SW Main St, Suite 300, Hillsboro, OR 97123',
    window.Booking._composeAddress());

  doc.getElementById('fUnit').value = '';
  check('a missing unit leaves no stray comma',
    window.Booking._composeAddress() === '1200 SW Main St, Hillsboro, OR 97123',
    window.Booking._composeAddress());

  const zipField = doc.getElementById('fZip');
  zipField.value = '9712a3xy';
  zipField.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(80);
  check('letters are stripped from the ZIP', zipField.value === '97123', zipField.value);

  // The lookup is stubbed: the sandbox has no route to a geocoder, and the
  // point here is the wiring rather than the provider.
  const realFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (String(url).includes('/api/address/suggest')) {
      return { json: async () => ({
        ok: true, provider: 'test',
        suggestions: [{
          label: '1200 SW Main St, Hillsboro, OR 97123',
          street: '1200 SW Main St', city: 'Hillsboro', state: 'OR', zip: '97123',
        }],
      }) };
    }
    return realFetch(url, opts);
  };

  doc.getElementById('fAddress').value = '';
  doc.getElementById('fCity').value = '';
  doc.getElementById('fState').value = '';
  doc.getElementById('fZip').value = '';

  const streetField = doc.getElementById('fAddress');
  streetField.value = '1200 SW Main';
  window.Booking._queryAddress(streetField);

  const listed = await until(() => {
    const box = doc.querySelector('.addr-suggest');
    return box && box.classList.contains('open') && box.textContent.includes('Hillsboro');
  }, 3000);
  check('typing a street offers matches', listed);

  window.Booking._chooseAddress(0);
  await sleep(150);
  check('picking one fills the street', doc.getElementById('fAddress').value === '1200 SW Main St',
    doc.getElementById('fAddress').value);
  check('and the city', doc.getElementById('fCity').value === 'Hillsboro');
  check('and the state', doc.getElementById('fState').value === 'OR');
  check('and the ZIP', doc.getElementById('fZip').value === '97123');
  check('an autofilled address shows its zone',
    await until(() => (doc.getElementById('addrHint').textContent || '').includes('Zone 1')),
    doc.getElementById('addrHint').textContent);
  check('and the travel line fills in',
    (doc.getElementById('totalLine').textContent || '').includes('Zone 1'),
    doc.getElementById('totalLine').textContent);

  // The browser's own autofill may fill the field and fire only "change".
  const autoZip = doc.getElementById('fZip');
  autoZip.value = '97301';
  autoZip.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('a browser-autofilled ZIP shows its zone too',
    await until(() => (doc.getElementById('addrHint').textContent || '').includes('Zone 2')),
    doc.getElementById('addrHint').textContent);

  doc.getElementById('fAddress').value = '12';
  window.Booking._queryAddress(doc.getElementById('fAddress'));
  await sleep(500);
  check('a very short entry asks for nothing',
    !doc.querySelector('.addr-suggest')?.classList.contains('open'));

  window.fetch = realFetch;


  console.log('\nZIP autofill');

  const zipRealFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (String(url).includes('/api/address/zip')) {
      return { json: async () => ({ ok: true, city: 'Beaverton', state: 'OR', zip: '97005' }) };
    }
    return zipRealFetch(url, opts);
  };

  doc.getElementById('fCity').value = '';
  doc.getElementById('fState').value = '';
  const zip2 = doc.getElementById('fZip');
  zip2.value = '97005';
  zip2.dispatchEvent(new window.Event('input', { bubbles: true }));

  check('a ZIP fills the city',
    await until(() => doc.getElementById('fCity').value === 'Beaverton', 2500),
    doc.getElementById('fCity').value);
  check('and the state', doc.getElementById('fState').value === 'OR');

  // A city the customer typed is theirs; the lookup must not stomp it.
  doc.getElementById('fCity').value = 'Aloha';
  zip2.value = '97005';
  zip2.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(600);
  check('a city already typed is left alone',
    doc.getElementById('fCity').value === 'Aloha', doc.getElementById('fCity').value);

  window.fetch = zipRealFetch;


  console.log('\ntravel zones');

  window.Booking.close();
  await window.Booking.load();
  await sleep(200);
  window.Booking.open(1);
  await sleep(400);

  const areaText = doc.getElementById('areaBox')?.textContent || '';
  check('the zone charges are shown before booking',
    areaText.includes('Zone 3') && areaText.includes('100') && areaText.includes('50'),
    areaText.slice(0, 160));
  check('the total says travel waits on the ZIP',
    (doc.getElementById('totalLine').textContent || '').includes('enter your ZIP'),
    doc.getElementById('totalLine').textContent);

  // Looked up each time: reopening the modal redraws the field.
  const typeZip = async (zip) => {
    const zoneZip = doc.getElementById('fZip');
    zoneZip.value = zip;
    zoneZip.dispatchEvent(new window.Event('input', { bubbles: true }));
    await sleep(500);
  };
  const hint = () => doc.getElementById('addrHint').textContent || '';

  await typeZip('97113');
  check('a nearby ZIP is told it is Zone 1 and free',
    hint().includes('Zone 1') && hint().includes('no travel charge'), hint());

  await typeZip('97301');
  check('Salem is told Zone 2 and $50', hint().includes('Zone 2') && hint().includes('$50'), hint());
  check('the travel charge joins the total',
    (doc.getElementById('totalLine').textContent || '').includes('Zone 2')
    && (doc.getElementById('totalLine').textContent || '').includes('143.50'),
    doc.getElementById('totalLine').textContent);
  check('their zone is picked out in the table',
    (doc.querySelector('#areaBox tr.mine')?.textContent || '').includes('Zone 2'));

  await typeZip('10001');
  check('an out-of-area ZIP is flagged while typing',
    hint().includes('outside our travel area'), hint());
  check('and it is marked as a problem', doc.getElementById('addrHint').classList.contains('bad'));

  // ...and refused on submit.
  await until(() => doc.querySelectorAll('.slot-btn').length > 0);
  doc.querySelector('.slot-btn').click();
  await sleep(80);
  doc.getElementById('fName0').value = 'Out Of Area';
  doc.getElementById('fEmail').value = 'out@example.com';
  doc.getElementById('fAddress').value = '1 Times Square';
  doc.getElementById('fCity').value = 'New York';
  doc.getElementById('fState').value = 'NY';
  window.Booking.hold();
  await sleep(300);
  check('booking outside the area is refused',
    (doc.getElementById('bookErr').textContent || '').includes('outside our travel area'),
    doc.getElementById('bookErr').textContent);

  // A Zone 3 booking pays $100 on top, once.
  await typeZip('97031');
  doc.getElementById('fCity').value = 'Hood River';
  doc.getElementById('fState').value = 'OR';
  doc.getElementById('fAddress').value = '100 Oak St';
  await until(() => doc.querySelectorAll('.slot-btn').length > 0);
  doc.querySelector('.slot-btn').click();
  await sleep(80);
  window.Booking.hold();
  check('a Zone 3 booking goes through',
    await until(() => doc.getElementById('holdClock')),
    doc.getElementById('bookErr')?.textContent);
  const payStep = doc.getElementById('bookBody').textContent || '';
  check('the payment step itemises the travel charge',
    payStep.includes('Zone 3') && payStep.includes('$100.00'), payStep.slice(0, 300));
  // 85.00 + 10% solo rate = 93.50, plus 100 travel.
  check('and charges it in the total', payStep.includes('$193.50'), payStep.slice(0, 300));

  console.log('\ntrips per zone per day');

  // A day that only goes into Zone 3 once.
  const limited = await (await fetch(`${BASE}/api/admin/classes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'fe-test' },
    body: JSON.stringify({
      courseCode: 'CPR', title: 'One coast trip',
      startsAt: '2027-02-10T16:00:00Z', endsAt: '2027-02-11T02:00:00Z',
      capacity: 10, priceCents: 8500, zoneLimits: { 3: 1 },
    }),
  })).json();
  // And another CPR day it can point them to instead.
  await fetch(`${BASE}/api/admin/classes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'fe-test' },
    body: JSON.stringify({
      courseCode: 'CPR', title: 'CPR / AED',
      startsAt: '2027-02-12T16:00:00Z', endsAt: '2027-02-13T02:00:00Z',
      capacity: 10, priceCents: 8500, zoneLimits: { 3: 1 },
    }),
  });
  const limitedSlots = await (await fetch(`${BASE}/api/classes/${limited.classId}/slots`)).json();
  const first = await (await fetch(`${BASE}/api/classes/${limited.classId}/hold`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Coast One', email: 'coast@example.com',
      slotStart: limitedSlots.slots[0].start,
      address: '1 Beach Rd, Otis, OR 97368', zip: '97368',
    }),
  })).json();
  check('the first Zone 3 trip books', first.ok === true, JSON.stringify(first).slice(0, 120));

  window.Booking.close();
  await window.Booking.load();
  await sleep(200);
  window.Booking.open(limited.classId);
  await sleep(400);
  await typeZip('97031');

  check('a second Zone 3 customer is told the day is taken for their zone',
    hint().includes('already booked for Zone 3'), hint());
  check('no times are offered to them',
    await until(() => doc.querySelectorAll('.slot-btn').length === 0)
    && (doc.getElementById('slotArea').textContent || '').includes('Zone 3'),
    doc.getElementById('slotArea').textContent.slice(0, 120));
  check('other days are suggested',
    await until(() => (doc.getElementById('slotArea').textContent || '').includes('Other days we can come to')),
    doc.getElementById('slotArea').textContent.slice(0, 200));

  await typeZip('97113');
  check('a Zone 1 customer still sees times that day',
    await until(() => doc.querySelectorAll('.slot-btn').length > 0),
    doc.getElementById('slotArea').textContent.slice(0, 120));

  const direct = await (await fetch(`${BASE}/api/classes/${limited.classId}/hold`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Coast Two', email: 'coast2@example.com',
      slotStart: limitedSlots.slots[12].start,
      address: '5 River Rd, Hood River, OR 97031', zip: '97031',
    }),
  })).json();
  check('the server refuses a second Zone 3 trip too', direct.reason === 'zone_full',
    JSON.stringify(direct).slice(0, 120));

  console.log('\nonly open times are shown');

  const halfBooked = await (await fetch(`${BASE}/api/classes/${limited.classId}/slots`)).json();
  const openCount = halfBooked.slots.filter((s) => s.available).length;
  check('booked times are left out, not crossed out',
    doc.querySelectorAll('.slot-btn').length === openCount
    && doc.querySelectorAll('.slot-btn[disabled]').length === 0,
    `${doc.querySelectorAll('.slot-btn').length} buttons for ${openCount} open times`);

  console.log('\ncourse prices');

  await fetch(`${BASE}/api/admin/courses/CPR/price`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': 'fe-test' },
    body: JSON.stringify({ priceCents: 9900 }),
  });
  await window.Booking.load();
  check('a price change shows on the courses page',
    await until(() => [...doc.querySelectorAll('[data-price="CPR"]')].every((el) => el.textContent === '$99')),
    [...doc.querySelectorAll('[data-price="CPR"]')].map((el) => el.textContent).join(','));
  check('and in the schedule data', (await (await fetch(`${BASE}/api/classes`)).json())
    .classes.filter((c) => c.courseCode === 'CPR').every((c) => c.priceCents === 9900));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (pageErrors.length) console.log(`page errors: ${pageErrors.join('; ')}`);
  console.log('');

  window.close();
  server.close();

  // Close the database before deleting its file. Windows refuses to unlink a
  // file that's still open; Linux allows it, which is why this only shows up
  // there. A leftover temp file is harmless either way, so a failure here
  // must not mask a passing run.
  try { require('../src/db').closeDb(); } catch { /* already closed */ }

  for (const f of [process.env.DB_PATH, `${process.env.DB_PATH}-wal`, `${process.env.DB_PATH}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      // Still locked. It's in the temp directory; the OS will clear it.
    }
  }
  process.exit(failed === 0 ? 0 : 1);
})();
