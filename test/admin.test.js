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

  check('the day table fills',
    await until(() => doc.querySelectorAll('#rows tr').length === 4),
    `${doc.querySelectorAll('#rows tr').length} rows`);

  const firstRow = doc.querySelector('#rows tr')?.textContent || '';
  check('seat counts show as taken/capacity', /\d+\/\d+/.test(firstRow), firstRow.slice(0, 90));
  check('a price shows', firstRow.includes('$'), firstRow.slice(0, 90));

  console.log('\nadding a class');

  window.Admin.newClass();
  await sleep(150);
  check('the add form opens', $('veil').classList.contains('open'));

  $('fTitle').value = 'X';
  $('fStart').value = '2026-12-01T09:00';
  $('fEnd').value = '2026-12-01T13:00';
  window.Admin.save(null);
  await sleep(200);
  check('a one-character name is refused', $('fErr').classList.contains('show'));

  $('fTitle').value = 'Evening BLS';
  $('fStart').value = '2026-12-01T13:00';
  $('fEnd').value = '2026-12-01T09:00';
  window.Admin.save(null);
  await sleep(200);
  check('a closing time before opening is refused',
    ($('fErr').textContent || '').includes('after opening'),
    $('fErr').textContent);

  $('fStart').value = '2026-12-01T09:00';
  $('fEnd').value = '2026-12-01T10:00';
  window.Admin.save(null);
  await sleep(200);
  check('a day too short for one session is refused',
    ($('fErr').textContent || '').includes('two hours'), $('fErr').textContent);

  $('fStart').value = '2026-12-01T10:00';
  $('fEnd').value = '2026-12-01T18:00';
  $('fCap').value = '8';
  $('fPrice').value = '95.50';
  window.Admin.save(null);

  check('a valid class saves', await until(() => !$('veil').classList.contains('open')));
  check('it appears in the table',
    await until(() => (doc.getElementById('rows').textContent || '').includes('Evening BLS')));

  const added = await (await fetch(`${BASE}/api/admin/classes`, {
    headers: { 'x-admin-token': TOKEN },
  })).json();
  const evening = added.classes.find((c) => c.title === 'Evening BLS');
  check('the price is stored in cents', evening?.priceCents === 9550, `got ${evening?.priceCents}`);
  check('the capacity is stored', evening?.capacity === 8, `got ${evening?.capacity}`);

  // A datetime-local value is local time; it must reach the server as UTC.
  check('local time converts to UTC on save',
    evening?.startsAt.endsWith('Z') && evening.startsAt.includes('2026-12-0'),
    `got ${evening?.startsAt}`);

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
        // Separate visits: each booking owns its time outright.
        slotStart: freeTimes[i * 5],
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
