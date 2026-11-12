# Tempo Dance Studio: a SettleKing merchant integration sample

A dance-studio site, in SettleKing's look, that takes payments through SettleKing in every way a
merchant can. Use it as a working reference for your own integration: read the code, run it against
your SettleKing merchant account, and follow `/test`, which lists each scenario with its steps and
test data.

- **One-time, hosted checkout**: pick a class, pay on SettleKing's payment page by card, wallet or
  bank account, and come back to the same page with the booking confirmed.
- **One-time, "Pay here"**: pay for the class in a SettleKing widget inside the studio's own page.
- **Subscriptions** (payment agreements, `recurring`): *Unlimited Monthly* ($79 a month after a
  7-day free trial) and *Weekly Practice* ($15 a week, charged on approval). The customer approves
  once on SettleKing, either on its approval page or from the studio's page through the agreement
  widget; SettleKing then charges on schedule by itself, by card or wallet (with bank top-up when the
  customer allows it).
- **Charge when needed** (`on_demand`): *Pay As You Dance*, up to $40 a class and $160 a month. The
  studio admin charges it after each class attended.
- **Card on file**: a monthly membership saves the member's card in a setup widget so the studio can
  charge $49 to it later (merchant-initiated payments).
- **Studio admin** (`/admin`): plans (charge, cancel, re-read from SettleKing), bookings and card-on-file
  members.

- `backend/`: NestJS 11 API (classes, bookings, memberships, SettleKing client, webhook receiver).
  It also serves the built page.
- `frontend/`: a single React 19 page (Vite) in SettleKing's palette (Inter and Geist, self-hosted),
  plus `/admin` and `/test`.

When the widget is not configured (`SETTLEKING_WIDGET_ID` / `SETTLEKING_PUBLISHABLE_KEY` empty),
the page hides "Pay here" and the membership section and works exactly as a hosted-checkout site.

## How hosted checkout works

```text
 Browser                    Studio server (NestJS)                 SettleKing
 ───────                    ──────────────────────                 ──────────
 Book "Salsa Foundations" ─▶ POST /api/bookings
                            ├─ saves booking TDS-1042 (pending)
                            └─ POST /api/v1/payments/merchant/integrations/checkout/sessions
                               Basic <client id:secret>, Idempotency-Key: <booking id>
                               { reference, amount: { currency: USD, value: "25.00" },
                                 returnUrl: https://<site>/?booking=<id> }      ─▶  checkout
 ◀─ redirect to https://pay.<domain>/checkout/<checkout id>
 pays by card / wallet on SettleKing (signed in, authenticator code) ──────────────▶  payment
                                                                   ◀── webhook ──  MERCHANT_PAYMENT_RECEIVED
                            POST /api/webhooks/settleking                         (Standard Webhooks
                            ├─ verifies webhook-signature (raw body, whsec_)        signature, retried
                            ├─ ignores repeats (webhook-id)                         until 2xx)
                            └─ checks checkout id + amount + currency → paid
 back to /?booking=<id> ─▶ POST /api/bookings/<id>/sync
                            └─ GET …/merchant/integrations/checkout/sessions/<id>  ─▶  status: paid
 "You're booked."
```

Three independent paths confirm a payment, so none can be lost:

1. **Signed webhook**: `MERCHANT_PAYMENT_RECEIVED`, sent by SettleKing when the checkout is
   paid. Verified against the raw bytes with the endpoint's `whsec_` secret, 5-minute timestamp
   tolerance, deduplicated by `webhook-id`.
2. **Return-page lookup**: when the customer comes back, the server reads the checkout from
   SettleKing (server to server, with the API key). The browser is never trusted.
3. **Reconciliation**: every minute the server looks up bookings still waiting for payment.

Before a booking is marked paid, the checkout id, amount and currency must match what the studio
asked for. The merchant API carries money as `{ "currency": "USD", "value": "25.00" }` (ISO 4217
code, decimal string in major units); the studio keeps cents and converts in
`backend/src/settleking/money.ts`. Creating the checkout with the booking id as `Idempotency-Key` means a retried request
returns the same checkout rather than charging twice.

## How "Pay here" (the payment widget) works

```text
 Browser (dance.<domain>)          Studio server (NestJS)                       SettleKing
 ────────────────────────          ──────────────────────                       ──────────
 GET /api/config ───────────────▶ { widget: { publishableKey, payUrl } }   (never the API secret)
 Book "Salsa", choose "Pay here" ▶ POST /api/bookings { payWith: "widget" }
                                   ├─ saves booking TDS-1042 (pending)
                                   └─ POST …/merchant/integrations/widget-sessions
                                      Basic <client id:secret>, Idempotency-Key: <booking id>-widget
                                      { widgetId, mode: "payment",
                                        amount: { currency: USD, value: "25.00" },
                                        reference: "TDS-1042",
                                        customer: { reference: <email>, email, name },
                                        savePaymentMethod: "optional" }      ─▶  widget session
                                      (403 CAPABILITY_NOT_ENABLED → same request with "off")
                                   stores widgetSessionId + checkoutSessionId
 ◀─ { bookingId, clientSecret: "wss_…" }      (one session, one secret, from the server)
 <script src="https://pay.<domain>/widget/v1/settleking.js">
 SettleKing(pk_test_…).widget({ clientSecret }).mount(…)  ── iframe on pay.<domain> ──▶ card form
 customer pays inside the iframe; card details never touch the studio  ────────────▶  payment
 widget "success" (a hint only)
 ─▶ POST /api/bookings/<id>/sync
                                   └─ GET …/checkout/sessions/<checkoutSessionId> ─▶ status: paid
                                      amount, currency and reference must match → paid
                                                                   ◀── webhook ──  MERCHANT_PAYMENT_RECEIVED
                                   POST /api/webhooks/settleking (same checks, by checkout id)
 "You're booked."
```

The widget payment opens a checkout too, so everything after "success" is the hosted flow's
confirmation: the server-side lookup, the signed webhook (matched by `checkoutSessionId`) and the
one-minute sweep. An unpaid widget booking expires when its widget session does.

`savePaymentMethod: "optional"` lets the customer tick "save my card" in the widget. Only studios
that SettleKing has granted merchant-initiated payments may save cards; the others get
`403 CAPABILITY_NOT_ENABLED`, and the studio repeats the request with `"off"` (a refused request
stores nothing, so the same Idempotency-Key is reused) and stops asking for ten minutes.

## How memberships (save a card, charge later) work

```text
 Member's browser                  Studio server                               SettleKing
 ────────────────                  ─────────────                               ──────────
 "Monthly membership": name, email ▶ POST /api/memberships
                                   └─ POST …/widget-sessions  Idempotency-Key: <member id>-setup-<n>
                                      { widgetId, mode: "setup", paymentMethods: ["card"],
                                        customer: { reference: <email>, email, name } } ─▶ setup session
 ◀─ { memberId, clientSecret }
 setup widget: card saved ─────────────────────────────────────────────────────────▶ card stored
 widget "success" ─▶ POST /api/memberships/<id>/sync
                                   ├─ GET …/widget-sessions/<id>      → succeeded, paymentMethodId
                                   └─ GET …/customers/<id>/payment-methods → brand, last4
                                                                   ◀── webhook ──  MERCHANT_PAYMENT_METHOD_SAVED
                                   saves customerId, paymentMethodId, brand, last4 (never the card)

 Studio admin (/admin, X-Admin-Token)
 "Charge $49 now" ─▶ POST /api/admin/members/<id>/charges
                                   ├─ records attempt 2026-10 #1 (requesting)
                                   └─ POST …/payments  Idempotency-Key: <member id>-2026-10-1
                                      { customerId, paymentMethodId,
                                        amount: { USD, "49.00" }, reference: TDS-M1043-2026-10-1 }
                                                                          ─▶ 202 processing
 polls ─▶ GET /api/admin/members/<id>/charges/<charge>
                                   └─ GET …/payments/<id>  → paid | failed (failureCode)
                                                                   ◀── webhook ──  MERCHANT_PAYMENT_RECEIVED
                                                                   ◀── webhook ──  MERCHANT_PAYMENT_FAILED
 "Remove card" ─▶ DELETE /api/admin/members/<id>/card
                                   └─ DELETE …/customers/<id>/payment-methods/<pm> ─▶ detached
```

- Each charge attempt is written down before SettleKing is called. If SettleKing's answer is lost
  (timeout, 5xx), the attempt stays `requesting` and "Charge now" resends **the same**
  Idempotency-Key, so SettleKing returns the same payment instead of charging twice. A declined or
  refused attempt is closed, and the next one is attempt 2 with a new key. A month that is paid or
  still processing cannot be charged again.
- Webhooks are matched to the charge by payment id, or by its unique reference when the webhook
  arrives before the `202` answer was stored; amount, currency and reference must match.
- The one-minute sweep also asks SettleKing about pending card saves and processing charges.

## How plans (subscriptions and pay as you dance) work

```text
 Browser                          Studio server                                   SettleKing
 ───────                          ─────────────                                   ──────────
 "Weekly Practice", name, email ▶ POST /api/plans { planId, approveVia }
                                  ├─ records plan TDS-P1006 (proposing)
                                  └─ POST …/agreements  Idempotency-Key: <plan id>-agreement
                                     { type: recurring, reference: TDS-P1006,
                                       amount: { USD, "15.00" }, interval: week,
                                       paymentMethods: [wallet, card],
                                       returnUrl: https://<site>/?plan=<id>,
                                       payerEmail: <the email given here> }         ─▶ pending, approvalUrl
 approveVia hosted: ◀─ { approvalUrl } → the customer approves on SettleKing, then "Return to …"
 approveVia widget: ◀─ { clientSecret } of POST …/widget-sessions { mode: agreement, agreementId }
                    the frame opens SettleKing's approval page in a popup; "success" is a hint only
 /?plan=<id> ───────────────────▶ POST /api/plans/<id>/sync
                                  └─ GET …/agreements/<id> + GET …/agreements/<id>/charges
                                                                   ◀── webhook ──  MERCHANT_AGREEMENT_UPDATED
                                                                   ◀── webhook ──  MERCHANT_PAYMENT_RECEIVED / _FAILED
                                                                                   (origin agreement, by checkout id)
 Studio admin › Plans › "Charge for class" (Pay As You Dance only)
                                  ├─ records request TDS-P1007-C3 (requesting)
                                  └─ POST …/agreements/<id>/charges  Idempotency-Key: <plan id>-charge-3
                                     { amount: { USD, "24.00" }, reference, description }
                                                                          ─▶ processing | rejected (failureCode)
```

- The studio sends the customer's email as `payerEmail`, so only the SettleKing account with that
  email can approve the plan: a forwarded approval link is useless to anyone else.
- The terms come from the studio's own catalog (`backend/src/plans/plan.catalog.ts`); the customer
  sees and approves exactly those on SettleKing, with an emailed code. SettleKing refuses any charge
  outside them (and outside the customer's own limits) with a reason and moves no money.
- Subscriptions are charged by SettleKing, not the studio: a failed charge is tried once and the plan
  pauses (`suspended`) until the customer resumes it in SettleKing.
- A pay-as-you-dance request is recorded before SettleKing is called; a lost answer is retried with
  the same Idempotency-Key, so it can never charge twice.
- The studio never trusts the browser or a webhook alone for state: both make it read the agreement
  and its charges from SettleKing (and so does the one-minute sweep).
- "Cancel plan" on the plan page cancels at SettleKing (`POST …/agreements/<id>/cancel`); the plan's
  unguessable id in the link is the only key, enough for a sample. Customers can also cancel in
  SettleKing, and the studio learns it from the webhook.

## Security notes for widgets

- **The client secret comes from your server, per session.** The browser gets only the publishable
  key (public, it cannot charge anything) and one widget session's `wss_` secret. The amount,
  reference, customer and whether a card may be saved are decided by the server when it creates
  the session; the page cannot change them. The API client secret and the webhook secret never
  leave the server.
- **Confirm server-side; never trust the browser event.** The widget's `success` event only tells
  the page to ask the server. The server reads the checkout (or widget session) from SettleKing
  with its API key and checks the checkout id, amount, currency and reference before it marks
  anything paid or a card saved. Signed webhooks confirm the same facts independently.
- **Load `settleking.js` from SettleKing's payment origin** with a script tag; don't bundle or
  self-host it. The widget is an iframe on that origin, so card details never reach the studio's
  page or server, and SettleKing renders it only on the widget's allowed origins.
- **Saved cards are charged only by the server**, from an authenticated staff action, with an
  Idempotency-Key per member, month and attempt.
- The sample's admin protection is a shared token (`ADMIN_TOKEN`, sent as `X-Admin-Token`, compared
  in constant time). A real studio puts staff behind proper sign-in. The membership form is not
  signed in either: anyone can start a card save for an email, which only adds a card the person
  entering it will pay with; a real site would verify the email or require an account.

## Set up the merchant in SettleKing

In the SettleKing app (`https://app.stage.settleking.com`), signed in with a
**business** account:

1. **Payments → Payment methods → Cards (NMI)**: paste your NMI gateway's private security key and
   public tokenization key (and, optionally, its webhook signing key), then confirm with your
   authenticator app. SettleKing checks the key with NMI and stores the keys encrypted.
2. Under **What your checkout accepts**, turn on cards and/or the SettleKing wallet.
3. **Payments → Developer setup → API keys**: create a key for this site. Copy the client secret,
   which is shown only once.
4. **Developer setup → Webhooks**: add `https://<your host>/api/webhooks/settleking` and copy its
   signing secret. The endpoint must be public HTTPS. Subscribe to
   `MERCHANT_PAYMENT_RECEIVED`, `MERCHANT_PAYMENT_REVERSED`, `MERCHANT_PAYMENT_FAILED`,
   `MERCHANT_PAYMENT_METHOD_SAVED` and `MERCHANT_AGREEMENT_UPDATED` (or tick none: every event).
   Keep one endpoint per site: an old endpoint to the same URL signs with its own secret, and the
   studio rejects those deliveries as `bad_signature`.

### Widgets ("Pay here" and memberships)

5. **Developer setup → Widgets → Create widget** (the dashboard calls
   `POST /api/v1/payments/merchant/widgets` with your signed-in session): give it a name and the
   display name customers see, choose the payment methods (card; ACH is optional for "Pay here",
   memberships always save a card) and, optionally, colours and fonts.
6. Under **Allowed origins** add exactly your site's origin, your `PUBLIC_URL` (scheme, host
   and port; no path, no wildcard). The widget refuses to render on any other origin. Add
   `http://localhost:5180` too if you run the Vite dev server.
7. Copy the widget's **id** into `SETTLEKING_WIDGET_ID` and its **publishable key**
   (`pk_test_…`) into `SETTLEKING_PUBLISHABLE_KEY`.

**Capability note.** Saving customers' cards and charging them later (setup widget sessions,
`savePaymentMethod` other than `off`, and `POST /payments`) and proposing plans (`POST
/agreements`) need the **merchant-initiated payments** capability. It is not self-service: SettleKing operations grant it to the merchant.
Without it, SettleKing answers `403 CAPABILITY_NOT_ENABLED`; "Pay here" still works (without the
"save my card" box), while the membership form and "Charge now" show "Saving customers' cards and
charging them later is not enabled for this studio. Contact SettleKing support."

## Run it

You need a SettleKing **business** account set up as above, and an HTTPS address for the site
(`PUBLIC_URL`): SettleKing only returns customers to an HTTPS `returnUrl`, only delivers webhooks to
public HTTPS, and the widget only renders on the origin you allowed. On a laptop, a tunnel (for
example Cloudflare Tunnel or ngrok) to port 4400 gives you one.

### With Docker

```bash
cp .env.example .env       # PUBLIC_URL, the client id/secret, webhook secret and widget values from above
docker compose up -d --build
```

The site listens on `http://localhost:4400`; put your reverse proxy or tunnel in front of it. Check
`http://localhost:4400/api/health`. Payment confirmations appear in `docker compose logs -f`.

### On your machine (hot reload)

```bash
(cd backend && npm install) && (cd frontend && npm install)
cd backend && npm run build && npm run dev    # API on :4400, reads ../.env
cd frontend && npm run dev                    # site on :5180, proxies /api to :4400
```

Point your tunnel at `:5180` in that case, and add that origin to the widget's allowed origins.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | HTTPS origin of this site; the checkout's `returnUrl` is `<PUBLIC_URL>/?booking=<id>` |
| `SETTLEKING_API_URL` | SettleKing API origin, default `https://api-v2.stage.settleking.com` |
| `SETTLEKING_CHECKOUT_URL` | Hosted checkout base, default `https://pay.stage.settleking.com/checkout` |
| `SETTLEKING_CLIENT_ID` / `SETTLEKING_CLIENT_SECRET` | API key from Developer setup |
| `SETTLEKING_PAYMENT_METHODS` | Optional comma list of `card` / `wallet` to offer on the hosted checkout; empty offers every method the merchant has enabled |
| `SETTLEKING_WEBHOOK_SECRET` | The webhook endpoint's `whsec_…` signing secret |
| `SETTLEKING_MERCHANT_NAME` | Name shown to payers on the checkout |
| `SETTLEKING_WIDGET_ID` | The widget's id (uuid) from Developer setup → Widgets; empty hides the widget options |
| `SETTLEKING_PUBLISHABLE_KEY` | The widget's publishable key (`pk_test_…`); public, sent to the page by `/api/config` |
| `SETTLEKING_APP_URL` | SettleKing's web app, default `https://app.stage.settleking.com`; the page links customers there to manage plans and limits |
| `SETTLEKING_PAY_URL` | SettleKing's payment origin, default `https://pay.stage.settleking.com`; the page loads `<SETTLEKING_PAY_URL>/widget/v1/settleking.js` |
| `ADMIN_TOKEN` | Token the studio admin page sends as `X-Admin-Token`; empty turns the admin API off (generate with `openssl rand -base64 32`) |
| `DATA_DIR` | Where bookings and members are stored (`data/db.json`; a JSON file keeps the sample dependency-free) |

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/classes` | The classes |
| GET | `/api/config` | `{ studioName, widget: { publishableKey, payUrl } \| null, membership: { amount }, plans, payUrl, appUrl }` |
| POST | `/api/bookings` | `{ classId, studentName, email, payWith?: "hosted" \| "widget" }`: returns `{ bookingId, checkoutUrl }` (hosted) or `{ bookingId, clientSecret }` (widget) |
| GET | `/api/bookings/:id` | Booking status (customer view) |
| POST | `/api/bookings/:id/sync` | Confirm with SettleKing now (return page, widget success) |
| POST | `/api/memberships` | `{ name, email }`: open a setup widget session; returns `{ memberId, clientSecret }` |
| GET | `/api/memberships/:id` | Member status (member view: card brand and last 4 only) |
| POST | `/api/memberships/:id/sync` | Confirm the saved card with SettleKing now (widget success) |
| GET | `/api/plans` | The plans (catalog) |
| POST | `/api/plans` | `{ planId, name, email, approveVia: "hosted" \| "widget" }`: returns `{ planId, approvalUrl }` or `{ planId, clientSecret }` |
| GET | `/api/plans/:id` | The plan (customer view: status, how it is paid, charges) |
| POST | `/api/plans/:id/sync` | Read the agreement and its charges from SettleKing now |
| POST | `/api/plans/:id/cancel` | Cancel the plan at SettleKing |
| GET | `/api/admin/plans` | Admin: every plan with its charges |
| POST | `/api/admin/plans/:id/charges` | Admin: `{ classId }`, charge a pay-as-you-dance plan for that class |
| POST | `/api/admin/plans/:id/sync` / `cancel` | Admin: re-read from SettleKing / cancel |
| GET | `/api/admin/bookings` | Admin: the newest 50 bookings |
| GET | `/api/admin/members` | Admin (`X-Admin-Token`): members, saved cards, recent charges |
| POST | `/api/admin/members/:id/charges` | Admin: charge this month's membership to the saved card |
| GET | `/api/admin/members/:id/charges/:chargeId` | Admin: the charge's state, read from SettleKing (`GET /payments/{id}`) |
| DELETE | `/api/admin/members/:id/card` | Admin: remove the saved card at SettleKing |
| POST | `/api/webhooks/settleking` | SettleKing webhooks (unknown event types are acknowledged and ignored) |

The studio admin page is at `/admin` (e.g. `https://dance.example.com/admin`); it
asks for the admin token and keeps it for the browser tab only.

## Tests

```bash
cd backend && npm test     # webhook signatures, booking/payment rules, widget sessions, memberships, plans, client
```

## Notes for production

- Replace the JSON file store with a database and send real confirmation emails.
- Bill memberships from a scheduler (one charge per member per month, same idempotency rules)
  rather than a button, and email members when a charge fails.
- Keep the API secret and webhook secret in a secret manager; rotate them from Developer setup.
- Answer webhooks quickly with 2xx; SettleKing retries failed deliveries for about three days and
  disables an endpoint after repeated failures.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability. Never commit `.env`.

## License

[MIT](LICENSE). Tempo Dance Studio is a fictional business; the class names and prices are sample data.
