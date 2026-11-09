'use strict';

/**
 * Drives admin.html in a headless DOM: login, stats, editing a class,
 * capacity guards, rosters and manual payment.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = process.env.ADMIN_PORT || 3931;
const BASE = `http://localhost:${PORT}`;
const TOKEN = 'admin-test-token';

let passed = 0;
let failed = 0;

function check(label, cond, detail = '') {
  if (cond) { console.log(`  \u2713 ${label}`); passed++; }
  else { console.log(`  \u2717 ${label}${detail ? `\n      ${detail}` : ''}`); failed++; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (fn()) return true; } catch {}
    await sleep(50);
  }
  return false;
}

(async () => {
  process.env.DB_PATH = `/tmp/admin-test-${process.pid}.db`;
  process.env.PORT = String(PORT);
  process.env.PAYMENT_PROVIDER = 'mock';
  process.env.ADMIN_TOKEN = TOKEN;

  for (const f of [process.env.DB_PATH, `${process.env.DB_PATH}-wal`, `${process.env.DB_PATH}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  require('../src/seed').seed();

  const app = require('../src/server');
  const server = app.listen(PORT);
  await sleep(300);

  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  const pageErrors = [];
  virtualConsole.on('jsdomError', (e) => pageErrors.push(e.message));

  const dom = new JSDOM(html, {
    url: BASE,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(win) {
      win.fetch = (url, opts) =>
        fetch(String(url).startsWith('http') ? String(url) : BASE + String(url), opts);
      win.confirm = () => true;
      win.navigator.clipboard = { writeText: async () => {} };
    },
  });

  const { window } = dom;
  const doc = window.document;
  const $ = (id) => doc.getElementById(id);

  console.log('\nsign in');

  check('the dashboard starts hidden', !$('app').classList.contains('on'));

  $('tok').value = 'wrong-token';
  window.Admin.login();
  await sleep(300);
  check('a bad token is rejected', $('gateErr').classList.contains('show'));
  check('and the dashboard stays hidden', !$('app').classList.contains('on'));

  $('tok').value = TOKEN;
  window.Admin.login();
  check('the right token signs in', await until(() => $('app').classList.contains('on')));

  console.log('\ndashboard');

  check('stats render', await until(() => ($('stats').textContent || '').includes('UPCOMING')));
  check('it counts the seeded days',
    ($('stats').textContent || '').includes('4'), $('stats').textContent);

  const dayRows = () => doc.querySelectorAll('#rows tr.day-row');
  check('the day table fills',
    await until(() => dayRows().length === 4),
    `${dayRows().length} rows`);
  check('days are grouped under week headings',
    doc.querySelectorAll('#rows tr.week-head').length >= 1
    && (doc.querySelector('#rows tr.week-head')?.textContent || '').includes('Week of'));

  const firstRow = dayRows()[0]?.textContent || '';
  check('seat counts show as taken/capacity', /\d+\/\d+/.test(firstRow), firstRow.slice(0, 90));
  check('a price shows', firstRow.includes('$'), firstRow.slice(0, 90));
  check('free time slots are labelled',
    /\d+ time slots? available/.test(firstRow.replace(/\s+/g, ' ')), firstRow.slice(0, 160));
  check('free seats are labelled',
    /\d+ seats? available/.test(firstRow.replace(/\s+/g, ' ')), firstRow.slice(0, 200));

  console.log('\nadding a class');

  window.Admin.newClass('day');
  await sleep(150);
  check('the add form opens', $('veil').classList.contains('open'));

  $('veil').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(100);
  check('a click outside or Escape does not close it', $('veil').classList.contains('open'));

  $('fTitle').value = 'X';
  $('fDate').value = '2026-12-01';
  $('fOpen').value = '09:00';
  $('fClose').value = '13:00';
  window.Admin.save(null);
  await sleep(200);
  check('a one-character name is refused', $('fErr').classList.contains('show'));

  $('fTitle').value = 'Evening BLS';
  $('fOpen').value = '13:00';
  $('fClose').value = '09:00';
  window.Admin.save(null);
  await sleep(200);
  check('a closing time before opening is refused',
    ($('fErr').textContent || '').includes('after opening'),
    $('fErr').textContent);

  $('fOpen').value = '09:00';
  $('fClose').value = '10:00';
  window.Admin.save(null);
  await sleep(200);
  check('a day too short for one session is refused',
    ($('fErr').textContent || '').includes('at least 4 hours'), $('fErr').textContent);

  $('fOpen').value = '10:00';
  $('fClose').value = '18:00';
  $('fCap').value = '8';
  $('fPrice').value = '95.50';
  $('fZone3').value = '1';
  window.Admin.save(null);

  check('a valid class saves', await until(() => !$('veil').classList.contains('open')),
    $('fErr')?.textContent);
  check('it appears in the table',
    await until(() => (doc.getElementById('rows').textContent || '').includes('Evening BLS')));

  const added = await (await fetch(`${BASE}/api/admin/classes`, {
    headers: { 'x-admin-token': TOKEN },
  })).json();
  const evening = added.classes.find((c) => c.title === 'Evening BLS');
  check('the price is stored in cents', evening?.priceCents === 9550, `got ${evening?.priceCents}`);
  check('the capacity is stored', evening?.capacity === 8, `got ${evening?.capacity}`);

  // A date and time typed in local time must reach the server as UTC.
  check('local time converts to UTC on save',
    evening?.startsAt.endsWith('Z') && evening.startsAt.includes('2026-12-0'),
    `got ${evening?.startsAt}`);

  check('a zone trip limit is stored', evening?.zoneLimits?.[3] === 1,
    JSON.stringify(evening?.zoneLimits));
  check('blank zones mean no limit',
    evening?.zoneLimits?.[1] === null && evening?.zoneLimits?.[2] === null,
    JSON.stringify(evening?.zoneLimits));

  console.log('\nadding weekly hours');

  window.Admin.newClass();
  await sleep(150);
  check('weekly hours is the default', $('weekFields').style.display !== 'none');
  check('Monday to Friday start ticked',
    $('wkOn1').checked && $('wkOn5').checked && !$('wkOn6').checked && !$('wkOn0').checked);

  $('fTitle').value = 'Weekly CPR';
  $('fFrom').value = '2027-01-04';           // a Monday
  $('fWeeks').value = '2';
  window.Admin.previewWeek();
  check('it previews how many days it will add',
    ($('wkPreview').textContent || '').includes('10 days'), $('wkPreview').textContent);

  // Saturday mornings too, and a short Friday that can't fit a session.
  $('wkOn6').checked = true;
  $('wkOn6').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(50);
  check('ticking a day adds it', ($('wkPreview').textContent || '').includes('12 days'),
    $('wkPreview').textContent);

  $('wkClose5').value = '10:00';
  $('wkClose5').dispatchEvent(new window.Event('input', { bubbles: true }));
  window.Admin.save(null);
  await sleep(200);
  check('a day too short to book is caught by name',
    ($('fErr').textContent || '').includes('Fri'), $('fErr').textContent);

  $('wkClose5').value = '17:00';
  $('wkClose5').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('wkOpen6').value = '08:00';
  $('wkOpen6').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('wkClose6').value = '12:00';
  $('wkClose6').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('fZone3').value = '1';
  window.Admin.save(null);
  check('the weekly days save', await until(() => !$('veil').classList.contains('open')),
    $('fErr')?.textContent);

  const weekly = (await (await fetch(`${BASE}/api/admin/classes`, {
    headers: { 'x-admin-token': TOKEN },
  })).json()).classes.filter((c) => c.title === 'Weekly CPR');
  check('one day is created per open day', weekly.length === 12, `got ${weekly.length}`);

  const localDay = (iso) => new Date(iso).getDay();
  check('no closed weekday was created', !weekly.some((c) => localDay(c.startsAt) === 0),
    weekly.map((c) => c.startsAt).join(' '));
  const saturday = weekly.find((c) => localDay(c.startsAt) === 6);
  check('each weekday keeps its own hours',
    saturday && new Date(saturday.startsAt).getHours() === 8
    && new Date(saturday.endsAt).getHours() === 12,
    saturday && `${saturday.startsAt} – ${saturday.endsAt}`);
  check('every day gets the zone limit', weekly.every((c) => c.zoneLimits[3] === 1));

  const bulkBad = await (await fetch(`${BASE}/api/admin/classes/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({
      courseCode: 'CPR', title: 'Bad batch', capacity: 5, priceCents: 8500,
      days: [
        { startsAt: '2027-03-01T17:00:00Z', endsAt: '2027-03-02T01:00:00Z' },
        { startsAt: '2027-03-02T17:00:00Z', endsAt: '2027-03-02T18:00:00Z' },
      ],
    }),
  })).json();
  check('a batch with one bad day is refused', bulkBad.ok === false && bulkBad.day === 2,
    JSON.stringify(bulkBad));
  const afterBad = (await (await fetch(`${BASE}/api/admin/classes`, {
    headers: { 'x-admin-token': TOKEN },
  })).json()).classes.filter((c) => c.title === 'Bad batch');
  check('and saves none of it', afterBad.length === 0, `got ${afterBad.length}`);

  const badZone = await (await fetch(`${BASE}/api/admin/classes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({
      courseCode: 'CPR', title: 'Bad zone', capacity: 5, priceCents: 8500,
      startsAt: '2027-03-05T17:00:00Z', endsAt: '2027-03-06T01:00:00Z',
      zoneLimits: { 3: 1.5 },
    }),
  })).json();
  check('a fractional zone limit is refused', badZone.reason === 'zone_limits_invalid',
    JSON.stringify(badZone));

  console.log('\nediting and the capacity guard');

  // Two students take seats on a small class.
  const small = await (await fetch(`${BASE}/api/admin/classes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({
      courseCode: 'CPR', title: 'Small day',
      startsAt: '2026-12-10T16:00:00Z', endsAt: '2026-12-11T02:00:00Z',
      capacity: 4, priceCents: 8500,
    }),
  })).json();

  const smallSlots = await (await fetch(`${BASE}/api/classes/${small.classId}/slots`)).json();
  const freeTimes = smallSlots.slots.filter((s) => s.available).map((s) => s.start);

  for (const [i, who] of ['a', 'b'].entries()) {
    await fetch(`${BASE}/api/classes/${small.classId}/hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Person ${who}`, email: `${who}@example.com`,
        // Separate visits: each booking owns its time outright, and a
        // session plus travel blocks 5.5 hours.
        slotStart: freeTimes[i * 11],
        address: '1200 SW Main St, Hillsboro, OR 97123',
      }),
    });
  }

  const shrink = await (await fetch(`${BASE}/api/admin/classes/${small.classId}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({ capacity: 1 }),
  })).json();
  check('capacity cannot drop below seats already taken',
    shrink.ok === false && shrink.reason === 'capacity_below_booked', JSON.stringify(shrink));
  check('and it says how many are taken', shrink.taken === 2, `got ${shrink.taken}`);

  const grow = await (await fetch(`${BASE}/api/admin/classes/${small.classId}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({ capacity: 6, title: 'Renamed class' }),
  })).json();
  check('a valid edit saves', grow.ok === true);

  const after = await (await fetch(`${BASE}/api/classes/${small.classId}`)).json();
  check('the rename shows publicly', after.class.title === 'Renamed class');
  check('extra places become available', after.class.seatsAvailable === 4,
    `got ${after.class.seatsAvailable}`);

  console.log('\nraising capacity pulls the waitlist forward');

  const tiny = await (await fetch(`${BASE}/api/admin/classes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({
      courseCode: 'BABYSIT', title: 'Tiny one',
      startsAt: '2026-12-20T16:00:00Z', endsAt: '2026-12-20T22:00:00Z',
      capacity: 1, priceCents: 6500,
    }),
  })).json();

  const tinySlots = await (await fetch(`${BASE}/api/classes/${tiny.classId}/slots`)).json();
  await fetch(`${BASE}/api/classes/${tiny.classId}/hold`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'First In', email: 'first@example.com',
      slotStart: tinySlots.slots.find((s) => s.available).start,
      address: '1200 SW Main St, Hillsboro, OR 97123',
    }),
  });
  await fetch(`${BASE}/api/classes/${tiny.classId}/waitlist`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hopeful', email: 'hopeful@example.com' }),
  });

  const bumped = await (await fetch(`${BASE}/api/admin/classes/${tiny.classId}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({ capacity: 3 }),
  })).json();
  check('adding seats offers one to the waitlist', bumped.promoted === 1,
    `promoted ${bumped.promoted}`);

  console.log('\nroster');

  await window.Admin.refresh();
  await sleep(200);

  // The day's visits show under its row: time, then where to drive.
  const visitList = [...doc.querySelectorAll('#rows tr.visits-row')]
    .map((r) => r.textContent.replace(/\s+/g, ' ')).find((t) => t.includes('Person a')) || '';
  check('booked visits are listed under their day', visitList.includes('Hillsboro'),
    visitList.slice(0, 200));
  check('with the session time', /\d{1,2}:\d{2} [AP]M – \d{1,2}:\d{2} [AP]M/.test(visitList),
    visitList.slice(0, 200));
  check('and the zone', visitList.includes('Zone 1'), visitList.slice(0, 200));
  check('the next visit is marked',
    !!doc.querySelector('#rows tr.visits-row li.next'));
  window.Admin.roster(small.classId);

  check('the run sheet lists people',
    await until(() => ($('boxBody').textContent || '').includes('Person a')),
    $('boxBody').textContent.slice(0, 140));
  check('it shows booking status',
    ($('boxBody').textContent || '').includes('held'), $('boxBody').textContent.slice(0, 140));
  check('it shows the address to drive to',
    ($('boxBody').textContent || '').includes('Hillsboro'), $('boxBody').textContent.slice(0, 200));
  check('it groups by visit time',
    ($('boxBody').textContent || '').includes('visit'), $('boxBody').textContent.slice(0, 120));
  check('it shows each visit\'s travel zone',
    ($('boxBody').textContent || '').includes('Zone 1'), $('boxBody').textContent.slice(0, 200));

  const paid = await (await fetch(`${BASE}/api/admin/classes/${small.classId}/roster`, {
    headers: { 'x-admin-token': TOKEN },
  })).json();
  const someone = paid.roster[0].public_ref;

  const marked = await (await fetch(`${BASE}/api/admin/registrations/${someone}/mark-paid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({ note: 'cash on the day' }),
  })).json();
  check('a cash payment can be recorded', marked.ok === true, JSON.stringify(marked));
  check('and the student becomes confirmed', marked.registration.status === 'confirmed');

  const dropped = await (await fetch(`${BASE}/api/admin/registrations/${someone}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: '{}',
  })).json();
  check('a student can be removed', dropped.ok === true);

  console.log('\nsecurity');

  const noToken = await fetch(`${BASE}/api/admin/classes`);
  check('admin routes reject a missing token', noToken.status === 401);

  const badToken = await fetch(`${BASE}/api/admin/summary`, {
    headers: { 'x-admin-token': 'nope' },
  });
  check('and a wrong one', badToken.status === 401);

  const publicView = await (await fetch(`${BASE}/api/classes`)).json();
  const leaks = JSON.stringify(publicView).match(/@example\.com/);
  check('the public endpoint leaks no student emails', !leaks);

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
