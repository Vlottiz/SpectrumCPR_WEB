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

  const tick = (code, on) => {
    $(`crsOn_${code}`).checked = on;
    $(`crsOn_${code}`).dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const listAll = async () => (await (await fetch(`${BASE}/api/admin/classes`, {
    headers: { 'x-admin-token': TOKEN },
  })).json()).classes;

  check('CPR is ticked to start with', $('crsOn_CPR').checked && !$('crsOn_BABYSIT').checked);

  tick('CPR', false);
  $('fDate').value = '2026-12-01';
  $('fOpen').value = '10:00';
  $('fClose').value = '18:00';
  window.Admin.save(null);
  await sleep(200);
  check('a day with no course is refused',
    ($('fErr').textContent || '').includes('at least one course'), $('fErr').textContent);

  tick('BABYSIT', true);
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
  $('fZone3').value = '1';
  window.Admin.save(null);

  check('a valid class saves', await until(() => !$('veil').classList.contains('open')),
    $('fErr')?.textContent);

  const evening = (await listAll()).find((c) =>
    c.courseCode === 'BABYSIT' && c.startsAt.startsWith('2026-12-01'));
  check('it is stored under the ticked course', evening?.title === 'Babysitter Safety',
    JSON.stringify(evening)?.slice(0, 120));
  check('it appears in the table',
    await until(() => [...doc.querySelectorAll('#rows tr.day-row')]
      .some((r) => r.textContent.includes('Babysitter Safety') && r.textContent.includes('Dec 1'))));
  check('it takes the course price', evening?.priceCents === 5500, `got ${evening?.priceCents}`);
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

  console.log('\nadding a fixed run of weeks, several courses');

  window.Admin.newClass();
  await sleep(150);
  check('weekly hours is the default', $('weekFields').style.display !== 'none');
  check('and it repeats by default', $('fWeeks').value === 'repeat');
  check('Monday to Friday start ticked',
    $('wkOn1').checked && $('wkOn5').checked && !$('wkOn6').checked && !$('wkOn0').checked);

  tick('HEARTSAVER', true);
  $('fFrom').value = '2027-01-04';           // a Monday
  $('fWeeks').value = '2';
  window.Admin.previewWeek();
  check('it previews how many days it will add',
    /10 days\s*× 2 courses/.test($('wkPreview').textContent || ''), $('wkPreview').textContent);

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

  const inRun = (c) => c.startsAt >= '2027-01-04' && c.startsAt < '2027-01-19';
  const weekly = (await listAll()).filter(inRun);
  check('a day is created per open day per course', weekly.length === 24, `got ${weekly.length}`);
  check('both courses are there',
    weekly.filter((c) => c.courseCode === 'CPR').length === 12
    && weekly.filter((c) => c.courseCode === 'HEARTSAVER').length === 12);
  check('each at its own price',
    weekly.every((c) => c.priceCents === (c.courseCode === 'CPR' ? 8500 : 9500)));

  const localDay = (iso) => new Date(iso).getDay();
  check('no closed weekday was created', !weekly.some((c) => localDay(c.startsAt) === 0),
    weekly.map((c) => c.startsAt).join(' '));
  const saturday = weekly.find((c) => localDay(c.startsAt) === 6);
  check('each weekday keeps its own hours',
    saturday && new Date(saturday.startsAt).getHours() === 8
    && new Date(saturday.endsAt).getHours() === 12,
    saturday && `${saturday.startsAt} – ${saturday.endsAt}`);
  check('every day gets the zone limit', weekly.every((c) => c.zoneLimits[3] === 1));
  check('a fixed run is not a repeating schedule', weekly.every((c) => !c.scheduleId));

  console.log('\na repeating schedule');

  await window.Admin.refresh();
  check('the schedule panel says there is none yet',
    ($('schedList').textContent || '').includes('None yet'), $('schedList').textContent);

  window.Admin.newClass();
  await sleep(150);
  tick('CPR', false);
  tick('BABYSIT', true);
  for (const d of [1, 2, 3, 4, 5]) {
    $(`wkOn${d}`).checked = false;
    $(`wkOn${d}`).dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  $('wkOn6').checked = true;
  $('wkOn6').dispatchEvent(new window.Event('change', { bubbles: true }));
  $('fAhead').value = '4';
  window.Admin.previewWeek();
  check('the preview explains it keeps going',
    /Sat.*4 weeks/.test($('wkPreview').textContent || ''), $('wkPreview').textContent);
  check('the button says what happens', ($('saveBtn').textContent || '').includes('Start this schedule'));
  window.Admin.save(null);
  check('the schedule saves', await until(() => !$('veil').classList.contains('open')),
    $('fErr')?.textContent);

  check('it is listed in the schedule panel',
    await until(() => ($('schedList').textContent || '').includes('Sat 9:00')),
    $('schedList').textContent);
  const fromSchedule = (await listAll()).filter((c) => c.scheduleId);
  check('it opens about four weeks of Saturdays',
    fromSchedule.length >= 3 && fromSchedule.length <= 4
    && fromSchedule.every((c) => c.courseCode === 'BABYSIT' && localDay(c.startsAt) === 6),
    fromSchedule.map((c) => `${c.courseCode} ${c.startsAt}`).join(' '));
  check('its days are marked as repeating',
    [...doc.querySelectorAll('#rows tr.day-row')].some((r) => r.textContent.includes('repeats')));

  const schedId = (await (await fetch(`${BASE}/api/admin/schedules`, {
    headers: { 'x-admin-token': TOKEN },
  })).json()).schedules[0].id;
  window.Admin.editSchedule(schedId);
  await sleep(150);
  check('editing reopens it with its settings',
    $('crsOn_BABYSIT').checked && !$('crsOn_CPR').checked && $('wkOn6').checked && $('fAhead').value === '4');
  check('the form has no price box of its own', !$('crsPrice_BABYSIT'));
  window.Admin.save(null);
  await until(() => !$('veil').classList.contains('open'));

  window.Admin.toggleSchedule(schedId, false);
  check('it can be paused',
    await until(() => ($('schedList').textContent || '').includes('Paused')));

  console.log('\none price per course');

  check('the course prices are listed', $('price_BABYSIT')?.value === '55.00', $('price_BABYSIT')?.value);
  window.confirm = () => true;
  $('price_BABYSIT').value = '60.00';
  $('price_BABYSIT').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(400);
  const babysit = (await listAll()).filter((c) => c.courseCode === 'BABYSIT'
    && c.endsAt > new Date().toISOString());
  check('a new price reaches every upcoming day of that course',
    babysit.length > 1 && babysit.every((c) => c.priceCents === 6000),
    babysit.map((c) => c.priceCents).join(','));
  check('other courses keep theirs',
    (await listAll()).filter((c) => c.courseCode === 'HEARTSAVER').every((c) => c.priceCents === 9500));
  const shown = await (await fetch(`${BASE}/api/courses`)).json();
  check('the booking page is told the new price',
    shown.courses.find((c) => c.code === 'BABYSIT').priceCents === 6000);

  const dodge = await (await fetch(`${BASE}/api/admin/classes/${babysit[0].id}/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({ priceCents: 100 }),
  })).json();
  const afterDodge = (await listAll()).find((c) => c.id === babysit[0].id);
  check('one day cannot be priced differently', dodge.ok && afterDodge.priceCents === 6000,
    `got ${afterDodge.priceCents}`);

  console.log('\ntrainers');

  await window.Admin.refresh();
  check('the usual trainers default to 1', $('trainersDefault').value === '1');
  const dayPicker = () => doc.querySelector('.trainer-strip select[data-day]');
  check('each week heading has a trainer picker per day', !!dayPicker());
  const pickDay = dayPicker().dataset.day;
  dayPicker().value = '2';
  dayPicker().dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(400);
  const sched = await (await fetch(`${BASE}/api/admin/schedules`, {
    headers: { 'x-admin-token': TOKEN },
  })).json();
  check('a day can be given more trainers', sched.trainerDays[pickDay] === 2,
    JSON.stringify(sched.trainerDays));
  check('and it shows as changed',
    doc.querySelector(`.trainer-strip select[data-day="${pickDay}"]`)?.classList.contains('changed'));

  const weekPicker = doc.querySelector('.trainer-strip select[aria-label="Trainers for the whole week"]');
  weekPicker.value = '0';
  weekPicker.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(400);
  const allOff = await (await fetch(`${BASE}/api/admin/schedules`, {
    headers: { 'x-admin-token': TOKEN },
  })).json();
  check('a whole week can be set at once', allOff.trainerDays[pickDay] === 0,
    JSON.stringify(allOff.trainerDays));
  await fetch(`${BASE}/api/admin/trainers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({ days: Object.keys(allOff.trainerDays), trainers: null }),
  });

  console.log('\ntime off');

  const firstSat = fromSchedule.map((c) => c.startsAt).sort()[0];
  const satLocal = new Date(firstSat);
  const ymd = `${satLocal.getFullYear()}-${String(satLocal.getMonth() + 1).padStart(2, '0')}-${String(satLocal.getDate()).padStart(2, '0')}`;
  window.Admin.newTimeOff();
  await sleep(100);
  $('offFrom').value = ymd;
  $('offTo').value = ymd;
  $('offNote').value = 'Family wedding';
  await window.Admin.saveTimeOff();
  check('time off is listed',
    await until(() => ($('offList').textContent || '').includes('Family wedding')),
    $('offList').textContent);
  check('the empty day on it is removed',
    !(await listAll()).some((c) => c.scheduleId && c.startsAt === firstSat));

  const blocked = await (await fetch(`${BASE}/api/admin/classes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({
      courseCode: 'CPR', title: 'CPR / AED', capacity: 5, priceCents: 8500,
      startsAt: firstSat, endsAt: new Date(new Date(firstSat).getTime() + 8 * 3600_000).toISOString(),
    }),
  })).json();
  check('a day cannot be added on time off', blocked.reason === 'time_off', JSON.stringify(blocked));

  console.log('\nbooking notice');

  check('the notice defaults to 24 hours', $('notice').value === '24', $('notice').value);
  $('notice').value = '48';
  $('notice').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(300);
  const notice = await (await fetch(`${BASE}/api/admin/schedules`, {
    headers: { 'x-admin-token': TOKEN },
  })).json();
  check('changing it saves', notice.minNoticeHours === 48, `got ${notice.minNoticeHours}`);
  await fetch(`${BASE}/api/admin/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({ minNoticeHours: 24 }),
  });

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

  console.log('\ncancelled days clear themselves');

  const adminPost = async (path, body = {}) => (await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify(body),
  })).json();
  const adminList = async () => (await (await fetch(`${BASE}/api/admin/classes`, {
    headers: { 'x-admin-token': TOKEN },
  })).json()).classes;

  const empty = await adminPost('/api/admin/classes', {
    courseCode: 'CPR', title: 'Nobody came', capacity: 5, priceCents: 8500,
    startsAt: '2027-04-01T16:00:00Z', endsAt: '2027-04-02T02:00:00Z',
  });
  const cancelledEmpty = await adminPost(`/api/admin/classes/${empty.classId}/cancel`);
  check('an empty day is deleted when cancelled', cancelledEmpty.deleted === true,
    JSON.stringify(cancelledEmpty));
  check('and is gone from the list', !(await adminList()).some((c) => c.id === empty.classId));

  const busy = await adminPost('/api/admin/classes', {
    courseCode: 'CPR', title: 'Someone booked', capacity: 5, priceCents: 8500,
    startsAt: '2027-04-03T16:00:00Z', endsAt: '2027-04-04T02:00:00Z',
  });
  const busySlots = await (await fetch(`${BASE}/api/classes/${busy.classId}/slots`)).json();
  const booked = await (await fetch(`${BASE}/api/classes/${busy.classId}/hold`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Still Booked', email: 'still@example.com',
      slotStart: busySlots.slots[0].start, address: '1200 SW Main St, Hillsboro, OR 97123',
    }),
  })).json();
  await fetch(`${BASE}/api/classes/${busy.classId}/waitlist`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Waiting Here', email: 'waithere@example.com' }),
  });

  const cancelledBusy = await adminPost(`/api/admin/classes/${busy.classId}/cancel`);
  check('a day with people on it stays when cancelled', cancelledBusy.deleted === false);
  check('crossed out on the list',
    (await adminList()).find((c) => c.id === busy.classId)?.status === 'cancelled');

  await adminPost(`/api/admin/registrations/${booked.registration.ref}/cancel`);
  const afterOne = (await adminList()).find((c) => c.id === busy.classId);
  check('it stays while anyone is still on it, even the waitlist', !!afterOne);
  check('nobody on the waitlist is offered a seat on a cancelled day',
    afterOne?.waitlist === 1, `waitlist ${afterOne?.waitlist}`);

  const waiter = (await (await fetch(`${BASE}/api/admin/classes/${busy.classId}/roster`, {
    headers: { 'x-admin-token': TOKEN },
  })).json()).roster.find((r) => r.status === 'waitlist');
  await adminPost(`/api/admin/registrations/${waiter.public_ref}/cancel`);
  check('removing the last person deletes the day',
    !(await adminList()).some((c) => c.id === busy.classId));

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
