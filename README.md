# Spectrum CPR + First Aid — booking API

Class scheduling, seat holds, payments and waitlist. Runs on a mock payment
provider today; Elavon Converge drops in when credentials arrive.

## Run it

**Easiest:** double-click `start.bat` (Windows) or run `./start.sh` (Mac/Linux).
It installs dependencies, sets up the database, generates an admin token and
opens the browser.

Needs **Node 22.5 or newer** — the database uses Node's built-in SQLite, so
there is nothing to compile and no build tools to install.

```bash
npm install
npm run seed      # sample classes
npm start         # http://localhost:3000
```

On Windows PowerShell, use `npm.cmd` instead of `npm` if script execution is
blocked, or run once:
`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

`test:e2e` is kept out of `test:all` because it needs a real bash. On Windows
that means Git Bash or WSL with a distro installed — a bare `bash` there
resolves to WSL and fails with `execvpe(/bin/bash)`. It exercises the same API
the other suites already cover from the inside, so skipping it on Windows
costs little.

```bash
npm run test:all        # everything that runs on Node — 318 checks
npm test                # holds, payment, waitlist, groups (32)
npm run test:slots      # the slot calendar and blocking (34)
npm run test:pricing    # group bands, rounding, fallbacks (22)
npm run test:zones      # travel zones, charges, trips per day (29)
npm run test:address    # address parsing, ZIP lookup, outages (19)
npm run test:fe         # booking page in a headless DOM (131)
npm run test:admin      # admin page and its API (51)

npm run test:e2e        # full API flow over HTTP (37) — needs bash
```

The server also serves `index.html`, so open **http://localhost:3000** and the
whole site works with live booking — no separate web server needed while
developing.

Book a seat, then open the `checkoutUrl` from the response to approve or
decline a fake payment.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `DB_PATH` | `./data/booking.db` | SQLite file |
| `HOLD_MINUTES` | `20` | seat reservation window |
| `SESSION_MINUTES` | `240` | how long the instructor is on site |
| `BUFFER_MINUTES` | `90` | pack-up and travel, added to the block |
| `BUSINESS_TZ` | `America/Los_Angeles` | whose calendar date "per day" zone limits count by |
| `HOME_ZIP` | `97116` | where travel distances are measured from |
| `SLOT_STEP_MINUTES` | `30` | spacing of offered start times |
| `ADDRESS_PROVIDER` | `photon` | `photon`, `census` or `google` |
| `GOOGLE_PLACES_KEY` | *(unset)* | switches address lookup to Google Places |
| `ADDRESS_BIAS_LAT` / `..._LON` | Hillsboro OR | rank nearby addresses first |
| `OFFER_HOURS` | `24` | how long a waitlist offer stands |
| `ADMIN_TOKEN` | *(unset)* | admin routes return 503 until set |
| `PAYMENT_PROVIDER` | `mock` | `mock` or `converge` |
| `SWEEP_INTERVAL_MS` | `60000` | expiry sweeper cadence |

## How the calendar works

The business travels to the customer, so a **training day** is a day the
instructor is available plus the hours they'll work. Customers book a session
inside that window at their own address.

- Sessions run `SESSION_MINUTES` (default 120).
- Each booking then blocks `SESSION_MINUTES + BUFFER_MINUTES` (default 150) on
  the calendar — the extra half hour is packing up and driving. Book 8:00am and
  8:00–10:30 disappears; 10:30 is the next offered start.
- Start times are offered every `SLOT_STEP_MINUTES` (default 30) from opening,
  and only when the session itself finishes before closing. The travel buffer
  deliberately isn't required to fit — driving home after the last session of
  the day doesn't need to be inside working hours.
- A booking is **exclusive**: one van, one address, one time. Unlike a
  classroom, nobody else can join a booked slot.
- `capacity` on a day is how many people the instructor will train that day in
  total, across every visit. A party of six draws six from it.

So two things can run out independently — times, and headcount. A day with
plenty of hours left can still refuse a group of eight.

### When a day can't take a booking

The customer is offered both a waitlist and other days. Alternatives come from
days running the same course with room for the party, ordered so that a day
offering **the time they asked for** comes first even if it's later — somebody
who wanted 9am usually wants 9am more than they want that particular Tuesday.

### Travel zones

The instructor drives out from ZIP **97116** (Forest Grove). The straight-line
distance from there to the centre of the customer's ZIP sets their zone and
the travel charge:

| Zone | Distance | Travel charge |
|---|---|---|
| 1 | 0 – 25 miles | none |
| 2 | 25.01 – 50 miles | $50 |
| 3 | 50.01 – 90 miles | $100 |

Past 90 miles the booking is refused and the customer is asked to call.

- The charge is **per visit**, not per person, and is added to the total
  before payment. It's stored on the organiser's seat (`travel_cents`); every
  seat records the zone and distance.
- The booking page shows the zone table up front, names the customer's zone
  and charge as soon as they type a ZIP, and itemises classes, travel and the
  total on the form and the payment step.
- **Trips per zone per day.** Each day can cap how many visits go into each
  zone (`classes.zone_limits`, e.g. `{"3": 1}`). Blank is no limit, 0 closes
  the zone. The cap is per **calendar date** in `BUSINESS_TZ`, not per day row
  or time slot — two days on the same date share it, and the stricter limit
  wins. It's checked inside the booking transaction, so two customers can't
  both take the last Zone 3 trip.
- A customer whose zone is used up for a day sees no times for it and is
  offered other days that can still reach them.

Distances need no maps service: `src/zip-centroids.json` holds every ZIP
within 100 miles of 97116 (from the BSD-licensed `zipcodes` package), and a ZIP
not in it is further than that. `scripts/build-zip-table.js` rebuilds it if the
home ZIP or zone edges change. The zones themselves are in `src/zones.js`.

### Addresses

Every booking carries the address the instructor drives to, plus optional
access notes (gate code, parking, which door). The address appears on the
confirmation, in the calendar event, and on the admin run sheet as a link to
Google Maps.

Street, unit, city, state and ZIP are separate fields. A vague single line is
how a van ends up at the wrong Main Street, so each part is validated and the
ZIP must be five digits.

**Lookup** is proxied through the server, so no key reaches the browser and
CORS never applies:

| Provider | When | Behaviour |
|---|---|---|
| `photon` | **default**, free, no key | OpenStreetMap data via komoot's Photon, built for type-ahead. Suggests from three characters. House-number coverage is good in towns, patchier rurally — it's whatever OSM contributors mapped. Komoot ask heavy users to self-host. |
| `census` | free, no key | US Census geocoder. Authoritative for US addresses and the better validator, but needs a street number and name before it matches. More "tidy what I typed" than "guess from three letters". |
| `google` | set `GOOGLE_PLACES_KEY` | Places Autocomplete. Best coverage, smoothest type-ahead. Bills per session. |

Set `ADDRESS_PROVIDER` to force one. Results are biased toward
`ADDRESS_BIAS_LAT` / `ADDRESS_BIAS_LON` (default Hillsboro, Oregon) so nearby
addresses rank first.

**ZIP lookup runs separately** and needs no provider: type a five digit ZIP and
city and state fill in, free and keyless. It never overwrites a city already
typed.

A lookup failure never blocks a booking — the fields stay typeable and an
outage returns an empty list rather than an error.

## How a booking works

```
customer picks a day, a time and gives an address
  → POST /api/classes/:id/hold        time reserved for 20 minutes
  → payment session created           mock page now, Converge Lightbox later
  → POST /api/registrations/:ref/confirm
  → seat confirmed, email queued
```

**The seat is taken before payment starts, not after.** That ordering is the
whole point. Counting seats from payment confirmations — reading gateway
emails, say — can only tell you what already happened, so two people can buy
the same last seat before either confirmation lands. Holding first makes
overselling impossible.

The hold and the seat count run inside one `BEGIN IMMEDIATE` transaction, so
simultaneous clicks serialise. A test fires ten grabs at three seats and gets
exactly three winners.

Expiry is evaluated in the availability query rather than trusted from a status
column, so a lapsed hold frees its seat immediately even if the sweeper isn't
running. The sweeper only tidies statuses and moves the waitlist.

### Statuses

| Status | Holds a seat? | Meaning |
|---|---|---|
| `held` | yes, until `hold_expires_at` | paying now |
| `confirmed` | yes | paid |
| `offered` | yes, until `offer_expires_at` | waitlist seat reserved for them |
| `waitlist` | no | queued |
| `expired` | no | hold lapsed |
| `cancelled` | no | released |

An offer holds the seat for 24 hours so a cancellation at 2am isn't lost to
whoever happens to be awake.

## Group bookings

An organiser can reserve several seats in one booking — a daycare manager
signing up staff, a dental practice, a coaching team.

- Each attendee gets their own name, their own row on the roster and their own
  certification card.
- One email and phone covers the whole booking; the confirmation goes to the
  organiser and lists everyone.
- Any attendee can optionally have their **own** email and phone. Leave them
  blank and they inherit the booking contact. Anyone who supplies an address
  also gets their own confirmation with their own reference — the only reason
  to give one.
- One payment for the lot. The total is the per-seat price times the headcount,
  though each row still stores the per-seat price so revenue maths stays simple.
- **All or nothing.** If four seats are wanted and three are free, nothing is
  held. A half-booked group leaves the organiser paying for staff who can't
  attend, and someone has to fix it by hand either way.
- Capped at `MAX_GROUP_SEATS` (default 12), so a typo can't reserve a class.
- The seat picker won't offer more seats than the class has left.

Phone fields format as you type — `5035551234` becomes `(503) 555-1234`. Values
starting with `+` are left alone, since that's an international number and the
formatting would mangle it. Email fields suggest common domains once an `@` is
typed; arrow keys and Enter pick one, Escape dismisses. Only the domain is
completed — guessing at the local part would be worse than useless.

Admin can cancel a whole group at once, or drop one attendee and leave the rest
booked. Either way the freed seats go to the waitlist.

## Group pricing

A visit costs the same to travel to and set up whatever the headcount, so
party size moves the per-person price. Defaults:

| Party | Adjustment | Shown to the customer as |
|---|---|---|
| 1–2 | **+10%** | a small booking carrying a share of the fixed trip cost |
| 3–4 | **−5%** | a fuller session spreading that cost further |
| 5+ | **−10%** | best rate, one visit and more people trained |

Each band carries a `reason` that the booking page displays next to the price,
so a surcharge never appears unexplained. The page also nudges: a party of two
is told what a third person would bring the rate down to.

Bands are per training day and editable in the admin form, stored as JSON in
`classes.pricing_tiers`. A day with none falls back to `DEFAULT_TIERS` in
`seats.js`.

Rules the server enforces: bands start at 1, run continuously, and the last is
open-ended — a gap would let a group silently pay the base price. Rounding is
per seat rather than on the total, so every person on a roster pays the same
to the cent.

## Courses

Three: `CPR` (CPR / AED), `HEARTSAVER` (Heartsaver CPR / AED / First Aid) and
`BABYSIT` (Babysitter Safety). Days created under earlier, wider course lists
still display — they fall back to a neutral colour rather than breaking.

## Admin page

`http://localhost:3000/admin.html` — sign in with `ADMIN_TOKEN`.

- add training days one at a time, or as **weekly hours**: tick the weekdays
  you're open, set each one's hours, choose a start date and 1–12 weeks, and
  every open day is created at once (`POST /api/admin/classes/bulk`, all or
  nothing). Customers only ever see start times inside those hours
- each day carries course, headcount, base price, group price bands (with a
  live preview of what 1/2/3/5/8 people pay) and trips allowed per travel zone
- the day list is grouped by week, and shows zone trips used against each limit
- change hours, headcount and prices (headcount can't go below what's booked)
- a **run sheet** per day: each visit as its own block with the arrival time,
  the address as a Google Maps link, access notes, who's coming and what they
  paid
- group bookings appear as one block with the organiser's contact, the seat
  count and what they paid, rather than scattered through the list
- record a cash or cheque payment ("Mark paid")
- remove a student, which frees the seat and offers it to the waitlist
- copy confirmed emails for the class
- cancel and reopen classes

Raising a class's capacity offers the new seats to the waitlist automatically.

Times are entered in your local timezone and stored as UTC.

The token lives in `sessionStorage`, so closing the tab signs you out.

## What's in here

```
index.html          the public booking page
admin.html          the admin dashboard
package.json
src/
  server.js         routes
  seats.js          holds, slots, waitlist, groups
  db.js             schema and migrations
  address.js        address lookup providers
  calendar.js       .ics and Google Calendar links
  zones.js          travel zones and charges
  zip-centroids.json  ZIP locations within 100 miles of 97116
  seed.js           sample training days
  payments/         mock now, Converge later
scripts/
  build-zip-table.js  rebuilds zip-centroids.json
test/               the suites
Dockerfile          }
docker-compose.yml  } NAS / server deployment
.dockerignore       }
start.bat/.sh       local launcher
update.ps1          copy the newest downloads into place
cleanup.ps1         remove stray copies from the project root
```

Anything with the same name sitting at the project root is a leftover — Node
loads from `src/`. `cleanup.ps1` removes those safely.

Full deployment steps are in **DEPLOY.md**.

## Running on a NAS or server with Docker

```bash
echo "ADMIN_TOKEN=$(openssl rand -hex 16)" > .env
docker compose up -d
```

The database is a named volume (`booking-data`), so bookings survive rebuilds.
**Back that volume up** — it holds every registration.

```bash
docker compose logs -f                   # watch
docker run --rm -v spectrum-booking_booking-data:/d -v "$PWD":/b alpine \
  cp /d/booking.db /b/backup.db          # back up
```

### Before going live with real payments

A home NAS is a fine place to develop or stage this, but weigh these before
pointing real customers and real card payments at it:

- **Elavon whitelists the IP your server calls out from.** Residential
  connections usually have a dynamic IP, so the whitelist breaks whenever the
  ISP changes it and payments stop until someone notices. A static IP (often a
  business plan) or a cloud host avoids this.
- **HTTPS with a valid certificate, TLS 1.2/1.3 with Perfect Forward Secrecy**
  is required. Reachable on a NAS via a reverse proxy and Let's Encrypt, but
  it's setup you own forever.
- **Exposing a NAS to the internet** puts a device holding everything else you
  own on the public internet. NAS appliances are a well-known ransomware
  target.
- **Uptime.** Home power and internet go down. If the booking page is down, the
  business loses bookings silently.
- Many residential ISP terms prohibit running public servers.

A $5–7/month VPS (or Render, Railway, Fly.io) sidesteps all of it and gives a
static IP for the Elavon whitelist. A reasonable split: NAS for testing and
internal admin, cloud for the public booking site.

## Endpoints

**Public**

```
GET  /api/classes                             upcoming days + availability
GET  /api/classes/:id
GET  /api/classes/:id/slots?partySize=N       bookable times for that party
GET  /api/classes/:id/quote?partySize=N       what that party pays, and why
GET  /api/classes/:id/alternatives            other days that could take it
GET  /api/zones                               the zones and their charges
GET  /api/zones/lookup?zip=97123&classId=N    a ZIP's zone, miles and charge
GET  /api/address/suggest?q=...               address completions
GET  /api/address/zip?zip=97123               city and state for a ZIP
GET  /api/address/details?placeId=...         components for a Google pick
POST /api/classes/:id/hold                    {name, email, phone?}
POST /api/classes/:id/waitlist                {name, email, phone?}
GET  /api/registrations/:ref
POST /api/registrations/:ref/confirm
POST /api/registrations/:ref/cancel
POST /api/registrations/:ref/extend
POST /api/registrations/:ref/accept-offer
```

**Admin** — all require `x-admin-token`

```
GET  /api/admin/classes/:id/roster
POST /api/admin/classes
POST /api/admin/classes/bulk                  many days at once, from weekly hours
POST /api/admin/classes/:id/cancel
GET  /api/admin/outbox
POST /api/admin/sweep
```

## Switching to Elavon Converge

Everything payment-related lives in `src/payments/`. The seat logic never
learns which provider is active.

**1. The client calls Elavon and requests:**

- Hosted Payments / Lightbox enabled
- account set to **eCommerce**, not Phone/Catalog — this is the usual blocker
- an API user with permission to post a session token request
- the production domain **and server IP** added to the allowed list
  (Converge Account → Settings → Fraud Prevention Rules → API IP Address
  Allowed List — tick the Checkout.js/Lightbox level, not XML)

Elavon assigns a Solution Engineer for integration testing before go-live.
Build against the demo endpoints first.

**2. Set the environment:**

```bash
PAYMENT_PROVIDER=converge
CONVERGE_MERCHANT_ID=...
CONVERGE_USER_ID=...
CONVERGE_PIN=...
CONVERGE_ENV=demo        # then production
```

**3. Delete the mock:**

- `src/payments/mock.js`
- the `MOCK CHECKOUT` block in `src/server.js` (marked with a start and end
  comment)

Nothing else references either.

**4. Before taking real money**

The browser callback is a hint, not proof — a user can forge a POST to
`/confirm`. Verify server-side with an XML API `txnquery` on `ssl_txn_id`, or
configure a Converge Export Script (their webhook) and treat that as the source
of truth. There's a note at the relevant spot in `payments/converge.js`.

### Why Lightbox and not Checkout.js

PCI scope. Lightbox is SAQ A — 22 questions. Checkout.js is SAQ A-EP — 191,
because card fields would live on our page. Unless the client needs a fully
custom payment form, Lightbox is far cheaper to stay compliant on.

## Hosting

Needs a host that runs a persistent process and gives a **static outbound IP**,
since Elavon whitelists it. Render, Railway, Fly.io and a plain VPS all work.
Vercel and Netlify functions do not — their egress IPs rotate.

Also required by Elavon: HTTPS with a valid certificate, TLS 1.2 or 1.3 with
Perfect Forward Secrecy.

Get hosting sorted early — the IP is needed before the whitelist request, and
that request takes a few days.

## The booking page

`index.html` renders its schedule from `/api/classes` rather than hardcoded
rows, so class dates live in one place. It's grouped by week, then by date,
with each date listed once and whatever runs that day beneath it. The time
picker only lists start times that can actually be booked. Register opens a modal: details →
20-minute hold with a live countdown → payment → confirmation.

Times are stored UTC and rendered in the visitor's own timezone. A class stored
as `16:00Z` shows as 9:00 AM in Portland.

If the last seat goes while someone has the form open, the hold fails and the
modal switches to the waitlist rather than erroring.

### Calendar handoff

After confirming, students get two buttons:

- **Google Calendar** — a prefilled event URL
- **Apple / Outlook** — downloads an `.ics` from
  `/api/registrations/:ref/calendar.ics`

The `.ics` carries reminders for the day before and an hour ahead, and its UID
is derived from the confirmation reference so re-importing updates the event
instead of duplicating it.

### Pointing the page at a remote API

When the site and API are on different hosts, set this before the page's script
runs:

```html
<script>window.BOOKING_API_BASE = 'https://booking.example.com';</script>
```

and set `ALLOWED_ORIGINS` on the server to the site's origin. It defaults to
`*`, which is fine locally but too loose for production.

## Not built yet

- real email sending (`outbox` table holds what would have gone out)
- Converge Lightbox call in `payConverge()` (the stub documents the shape)
- rate limiting on the hold endpoint

## Keeping files in sync

`src/db.js`, `src/seats.js` and `src/server.js` change as a set. Copying only
some of them produces errors that point nowhere near the cause — a group
booking rejected as `name_required`, for instance, because an older server
reads a single `name` field and never sees the `attendees` list.

Two guards catch that now:

- **The server refuses to start** on a half-updated copy and names the stale
  file.
- **The booking page checks `/health`** on load and shows a banner if the
  server lacks features the page needs.

On Windows, `update.ps1` copies the newest matching downloads into place and
verifies each one:

```powershell
powershell -ExecutionPolicy Bypass -File update.ps1
```

## Upgrading an existing database

`db.js` migrates on startup: missing columns are added in place and existing
bookings are left alone. Nothing to run by hand — start the server and it
reports what it changed.

SQLite is the right call at this volume and needs no separate server. The
project uses `node:sqlite` rather than `better-sqlite3` specifically to avoid
native compilation — `better-sqlite3` has no prebuilt binary for newer Node
releases and falls back to needing Visual Studio on Windows. If the business
ever outgrows one box, the schema moves to Postgres as-is.
