# Payment integration guide

For the payment processor's integration team. This covers where card payments
plug into the Spectrum CPR + First Aid booking site and what the site expects
from the processor.

## The setup

- **Application:** Node.js 22 with Express, plus a SQLite database. The code
  is hand-written; there's no third-party booking platform.
- **Hosting:** Render.com web service, deployed from this GitHub repository.
- **Domain and TLS:** DNS through Cloudflare, served over HTTPS (TLS 1.2+).
- **Card data:** never handled by this site. The design is a **hosted payment
  page** (the customer is redirected to it) or a **hosted pop-up / Lightbox**
  (loaded from the processor's script). The site only stores a transaction
  reference, the amount and approved/declined. The aim is PCI DSS SAQ A.
- **Status today:** a built-in test provider (`mock`) stands in for card
  payments. Nothing is charged until a real provider is switched on.

## How a payment flows

```
Customer picks a class, time and address
  │
  ▼
POST /api/classes/:id/hold          seat held 20 minutes; total worked out on
  │                                  the server (seats + travel charge)
  ▼
createSession()                      ← processor API call (integration point 3)
  │   returns redirectUrl            hosted payment page
  │   or sessionToken + scriptUrl    hosted pop-up
  ▼
Customer pays on the processor's page or pop-up   (integration point 5)
  │
  ├─► POST /api/payments/webhook            processor → our server  (point 4)
  │       webhook() checks the signature    source of truth
  │
  └─► POST /api/registrations/:ref/confirm  browser → our server
          verify() re-checks with the processor's API  (a hint only)
  ▼
Booking confirmed, seat kept, receipt email queued, billing record written
```

Every booking has our reference, for example `SPC-8F3K2Q`. It's sent as the
**invoice / order number** so it comes back on the webhook and the payment
can be matched to the booking.

## The five integration points

Line numbers are as of this commit. Each spot is also marked in the code with
a `PAYMENT INTEGRATION POINT n of 5` banner, so you can search for that text.

| # | What | File | Line |
|---|---|---|---|
| 1 | Which provider is live (`PAYMENT_PROVIDER`), and where a new one is registered | [`src/payments/index.js`](src/payments/index.js#L5) | 5 (register at [line 28](src/payments/index.js#L28)) |
| 2 | **The adapter to fill in**: `createSession()`, `verify()`, `webhook()`, with the full contract in comments | [`src/payments/template.js`](src/payments/template.js#L5) | 5 (`createSession` [76](src/payments/template.js#L76), `verify` [107](src/payments/template.js#L107), `webhook` [123](src/payments/template.js#L123)) |
| 3 | Where the server starts a payment once the seat is held, passing the amount, our reference, `returnUrl` and `notifyUrl` | [`src/server.js`](src/server.js#L487) | 487 (inside `POST /api/classes/:id/hold`, [line 364](src/server.js#L364)) |
| 4 | **Webhook endpoint** for the processor's server-to-server notice: `POST /api/payments/webhook` | [`src/server.js`](src/server.js#L607) | 607 (route at [617](src/server.js#L617)) |
| 5 | Where the customer is handed to the hosted page or pop-up, and where they land when they return | [`index.html`](index.html#L2521) | 2521 (`payOnline` [2538](index.html#L2538), return page [2593](index.html#L2593)) |

**Elavon Converge Lightbox** is already written in
[`src/payments/converge.js`](src/payments/converge.js), with tests against a
pretend Elavon in [`test/converge.test.js`](test/converge.test.js). The browser
confirm route is `POST /api/registrations/:ref/confirm` in `src/server.js`.

### How the Converge adapter proves a payment

Neither the Lightbox approval in the browser nor the Export Script notice is
trusted on its own. Either one triggers a **txnquery** to Converge's XML API,
and the booking is confirmed only when Converge's own record shows:

- the sale was approved (and isn't voided or declined),
- its invoice number (`ssl_invoice_number`) is this booking's reference, and
- its amount is exactly the booking's total.

If Converge can't be reached, nothing is confirmed. Whichever of the two
arrives second is a harmless repeat.

### Setting up the Converge Export Script

In Converge: **Settings → System Setup Support → Export Options**.

1. Tick **Enable export scripts**.
2. Set the **Approval**, **Declined** and **Error** URLs all to
   `https://www.spectrumcpr.org/api/payments/webhook`.
3. Choose an **Authentication Username** and **Password**, and put the same
   values on Render as `CONVERGE_EXPORT_USER` and `CONVERGE_EXPORT_PASSWORD`.
4. Choose **Confirmation Text** (for example `SpectrumOK`) and put it on Render
   as `CONVERGE_EXPORT_CONFIRM`.
5. Tick **Retry failed export scripts**. Leave **Settlement Only** unticked.
6. Save.

Elavon has to add the URL to its proxy before posts arrive. That can take up
to 12 business days, so ask for it early (1-800-377-3962, option 2, option 2,
or sedevportalsupport@elavon.com).

How the site replies: Converge counts any reply other than 200 as a failure,
retries hourly and sends an alert email. So the site answers **200** to every
genuine post, including declines and repeats. It answers **401** to a post
without the right login, and **503** when Elavon can't be reached for the
txnquery check, so the post comes back within the hour.

Elavon's sample post doesn't include the invoice number, so the booking is
found from the txnquery record instead.

**To confirm with Elavon's Solution Engineer:** that txnquery returns
`ssl_invoice_number`, and which status codes mean a voided or declined sale. These are marked `CONFIRM` in `converge.js`. The
checks are strict, so a mismatch fails closed: no booking is confirmed.

## What the adapter has to do

Copy `src/payments/template.js` to `src/payments/<processor>.js` and implement:

**`createSession({ registration, cls, amountCents, seatCount, returnUrl, notifyUrl })`**
- Create a payment for `amountCents` (USD cents) with
  `registration.public_ref` as the invoice number.
- Return either:
  - `{ mode: 'redirect', redirectUrl }` for a hosted payment page, or
  - `{ mode: 'lightbox', sessionToken, scriptUrl }` for a hosted pop-up.
- Throwing an error releases the held seat and tells the customer payment is
  unavailable.

**`webhook(req)`** (recommended)
- Check the signature against `req.rawBody` (the exact bytes received).
- Return `{ ok: true, publicRef, paymentRef, raw }` for an approved payment,
  or `{ ok: false, reason }` to reject it.
- Receiving the same notice twice is harmless.

**`verify(payload)`**
- The browser's claim that a payment succeeded. Look the transaction up with
  the processor's API before returning `{ ok: true, paymentRef }`.

Then add it to `providers` in `src/payments/index.js` and set
`PAYMENT_PROVIDER=<processor>` on Render.

## Settings (environment variables on Render)

Credentials are only ever set as environment variables in the Render
dashboard. They're never written into the code or the repository.

| Variable | Purpose |
|---|---|
| `PAYMENT_PROVIDER` | `mock` (test), `converge`, or the new adapter's name |
| `PAYMENT_API_KEY`, `PAYMENT_MERCHANT_ID`, `PAYMENT_WEBHOOK_SECRET`, `PAYMENT_ENV` | read by `template.js`; rename to suit the processor |
| `CONVERGE_ACCOUNT_ID` | Converge Account ID, sent as `ssl_account_id` (formerly `ssl_merchant_id`; the old `CONVERGE_MERCHANT_ID` name still works) |
| `CONVERGE_USER_ID`, `CONVERGE_PIN` | the API user with hosted-payments permission, and its PIN |
| `CONVERGE_VENDOR_ID` | `ssl_vendor_id`, assigned by Elavon for certification |
| `CONVERGE_ENV` | `demo` (default) or `production` |
| `CONVERGE_EXPORT_USER`, `CONVERGE_EXPORT_PASSWORD` | the Export Script's Authentication Username and Password (see below) |
| `CONVERGE_EXPORT_CONFIRM` | the Export Script's Confirmation Text, letters and digits only; the site puts it in every reply |
| `CONVERGE_WEBHOOK_KEY` | optional extra: the Export Script URL can end `?key=<this>` |
| `PUBLIC_URL` | the site's address, e.g. `https://www.spectrumcpr.org`, used to build `returnUrl` and `notifyUrl` |

**URLs to register with the processor**
- Webhook / notification URL: `https://www.spectrumcpr.org/api/payments/webhook`
- Return URL after payment: `https://www.spectrumcpr.org/?booking=<reference>`
  (passed per payment as `returnUrl`)

Use the `www.` address exactly. The bare domain redirects, and a webhook
POST that gets redirected usually doesn't arrive.

**If the processor allow-lists our server's IP:** Render's outbound IP
addresses are listed in the Render dashboard under the service's
**Connect → Outbound** tab. For Converge, also allow-list the referrer
`https://www.spectrumcpr.org` for Lightbox.

## Before taking real payments

- Test end to end against the processor's sandbox, including a declined card
  and a webhook received twice.
- Make sure `webhook()` checks the signature and `verify()` re-checks with the
  processor's API. The browser's word alone shouldn't confirm a booking.
- Remove the test checkout: the block marked `MOCK CHECKOUT` in
  [`src/server.js` line 1329](src/server.js#L1329) and `src/payments/mock.js`.
