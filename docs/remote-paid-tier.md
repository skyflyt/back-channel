# Back Channel Remote: the paid tier (Stripe subscription)

Relay access (docs/appbridge-remote-access.md) needs the `appbridge.remote_access` entitlement. An
account gets it in one of two ways:

- **Admin grant.** `PUT /api/appbridge/v1/admin/entitlements` sets `AppBridgeEntitlement.active`.
  This is for Skylar's own accounts and comps, and it works exactly as before.
- **Subscription.** The account holds a Stripe subscription to the Remote price, in an entitling
  state (below).

Code: `apps/broker/src/lib/billing.ts` (routes, webhook),
`apps/broker/src/lib/remote-entitlement.ts` (the rule), `src/app/api/appbridge/v1/billing/**`.
Tests: `route-tests/billing.routetest.mts`.

## The entitlement rule, and why it cannot drift

`remoteAccessSource(tx, accountId)` is the only place that decides. The relay gate calls it inside
its existing serializable transaction on every pass, redemption and lease renewal. So do
`GET /devices/self` and `GET /account/devices`.

1. If the admin grant is active, the account is entitled (`source: "admin"`).
2. Otherwise, it is entitled if any of its `RemoteSubscription` rows entitles right now:
   - `active` or `trialing`;
   - `past_due`, for **3 days** from the first time we saw it past_due (`pastDueSince`). Stripe
     keeps retrying the card meanwhile. After 3 days the account is refused until the invoice is
     paid and the subscription is `active` again.
   - Anything else is refused: `canceled`, `unpaid`, `incomplete`, `incomplete_expired`, `paused`,
     and any status Stripe adds later.
   - **Backstop:** whatever the status, a row stops entitling 3 days after the end of the period we
     last heard about. A renewal moves that date forward. Stripe retries a webhook for up to 3 days,
     so this only bites when Stripe has gone silent. It stops a missed cancellation from granting
     access for ever.

The webhook never writes `AppBridgeEntitlement`, and the admin route never writes
`RemoteSubscription`. Each source has exactly one writer, and "entitled" is computed from both at
read time. There is no derived flag that could disagree with either source:

- Cancelling a subscription cannot clear an owner's comp.
- Revoking a comp cannot cancel a paying customer.
- The time rules (past_due grace, period-end backstop) take effect on their own, with no job and
  no event needed.

**Revocation.** When Stripe ends a subscription (`customer.subscription.deleted`, or `updated` to
`canceled` or `unpaid`), the row changes in the webhook's transaction. The relay renews every lease
about every 60 s for 120 s, and each renewal re-reads the gate. So the pair is refused, and its lease
deleted, at the next renewal: within about 2 minutes.

## Routes

All routes are under `/api/appbridge/v1/billing`. Responses are `Cache-Control: no-store`, and
errors are `{ "error": "<code>" }`.

| Route | Auth | Response |
|---|---|---|
| `POST /checkout` | cookie + `x-bc-csrf` | `{ url }`, a Stripe Checkout page (subscription mode, the configured price). Needs a verified email. `409 already_subscribed` if a subscription is live or needs fixing in the portal. |
| `POST /portal` | cookie + `x-bc-csrf` | `{ url }`, a Stripe Billing Portal page. `404 no_customer` before the first checkout. |
| `GET /status` | cookie | `{ plan: "none"\|"remote", status, currentPeriodEnd, cancelAtPeriodEnd, source: "admin"\|"subscription"\|null }`. No Stripe id, price or key. |
| `POST /webhook` | Stripe signature only | `200 { received: true }`. `400 bad_signature`. |

- The dashboard routes resolve only the `bc_session` cookie. A `bc_` agent key or an `ab_` device
  credential is `401`.
- Checkout and portal are rate limited per account.
- Only a `https://checkout.stripe.com/` or `https://billing.stripe.com/` URL is ever returned. A
  Stripe custom domain would need adding to that list.
- A Stripe error is `502 stripe_error`; Stripe's error text is never relayed.

**Checkout** creates one Stripe customer per account, or reuses it. The customer is created with
only `metadata[accountId]` and an idempotency key, so two racing first checkouts get the same
customer. No email or name is sent; Checkout collects what Stripe needs. The session carries:
- `client_reference_id`, `metadata[accountId]` and `subscription_data[metadata][accountId]`, all set
  to the account id;
- success and cancel URLs back to `/account/remote?billing=success|cancel`.

## Webhook

- **Signature.** `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]`. The broker computes
  HMAC-SHA256(`STRIPE_WEBHOOK_SECRET`, `${t}.` + the raw body bytes) and compares it to each `v1`
  with `timingSafeEqual`.
  - Several `v1` values appear while a secret is rolled; any match is enough.
  - A timestamp more than 300 s from now is refused, as are a missing header, two `t=` values,
    no `v1`, or a non-hex `v1`.
  - The body is read as bytes (at most 1 MiB) and parsed only after the signature checks out.
- **Idempotency.** Each event id is recorded in `StripeEvent` in the same serializable
  transaction that applies it. A replay is acknowledged and changes nothing. A refused transaction
  (for example, a `503` because the price isn't configured) records nothing, so Stripe's retry is
  processed. Ids older than 30 days are pruned.
- **Account mapping.** An object maps to an account **only** through the `BillingCustomer` row the
  broker wrote when it created that customer.
  - Our account id in `metadata` or `client_reference_id` must agree when it is present; if it
    disagrees, the event does nothing. Metadata never creates a mapping on its own.
  - A subscription already tracked for one account cannot be moved to another.
  - Only a subscription that includes `STRIPE_REMOTE_PRICE_ID` starts being tracked.
- **Ordering.** Stripe does not guarantee order.
  - A snapshot older than the one applied (`event.created < lastEventAt`) is ignored.
  - A `canceled` or `incomplete_expired` subscription is never revived.
  - Nothing moves back to `incomplete`.
- **Events:**
  - `customer.subscription.created`, `updated`, `deleted` carry the state. `deleted` is always
    stored as `canceled`.
  - `invoice.payment_failed` only pulls an existing past_due grace clock back to an earlier failure.
    It never grants anything.
  - `checkout.session.completed` is checked against the mapping and audited; the state arrives
    with the subscription events.
  - Any other type gets `200` and no action.
- **API versions.** Both payload shapes are read: `current_period_end` on the subscription (before
  2025-03-31) or on its items (from then on), and `invoice.subscription` or
  `invoice.parent.subscription_details.subscription`.
- **Privacy.** No body, id or payload content is logged or echoed. The only log line is a code
  (`billing webhook: unmapped` or `conflict`).

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `STRIPE_SECRET_KEY` | Secret Manager | `sk_live_…` / `sk_test_…` (or a restricted `rk_…` key with write access to Customers, Checkout Sessions and Billing Portal sessions). |
| `STRIPE_WEBHOOK_SECRET` | Secret Manager | The endpoint's `whsec_…` signing secret. |
| `STRIPE_REMOTE_PRICE_ID` | `--set-env-vars` | The Remote tier's recurring price, `price_…`. Not a secret. |
| `PUBLIC_APP_URL` | `--set-env-vars` (exists) | The origin used for the success, cancel and return URLs. |

**Fail closed.** If any of these is unset or malformed, checkout, portal and status answer `503` and
the page hides the plan card. The webhook needs only the signing secret, plus the price to start
tracking a new subscription; otherwise it answers `503`, and Stripe retries. The relay gate never
depends on this configuration: a tracked subscription keeps entitling while billing is switched off.

## Data

Migration `20260924200000_remote_paid_tier` is purely additive: `BillingCustomer`,
`RemoteSubscription` and `StripeEvent`, with their indexes and two foreign keys to `Account`. It
stores no card data, email or address. Apply it before deploying the app; its header covers the
backup and `prisma migrate deploy`.
