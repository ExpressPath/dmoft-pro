# Stripe Launch Checklist

The repository implements the payment and entitlement flow, but no real charge
can be accepted until the operator supplies and verifies the external account,
prices, identity provider, database, domain, and policies below.

## 1. Business and policy

- Verify the Stripe business account and payout bank account.
- Publish seller identity, terms, privacy notice, cancellation/refund policy,
  support contact, and legally required local disclosures.
- Have qualified counsel complete and approve
  [COMMERCIAL_LICENSE_TERMS.md](COMMERCIAL_LICENSE_TERMS.md), remove every
  `COUNSEL MUST COMPLETE` marker, and publish the final terms at a stable HTTPS URL.
- Configure that final Terms of Service URL in the Stripe Dashboard and require
  Checkout terms consent with `consent_collection: { terms_of_service: "required" }`.
  Preserve evidence of the accepted terms version according to the approved
  privacy and retention policy.
- Decide where the product is offered and obtain tax/legal advice for those
  jurisdictions; enable Stripe Tax only after configuring registrations.
- Keep device limits, grace behavior, and refund language consistent between
  Checkout, the product page, and customer terms. The MVP does not offer a trial.

## 2. Stripe test-mode catalog

Create one recurring product, `DMOFT Pro`, with two Prices:

- JPY 1,980, recurring monthly
- JPY 19,800, recurring yearly

Attach `dmoft_devices_3` to the launch Product used by both Prices. Do not attach
the one-device or ten-device roadmap limits to either launch Price/Product.

Create and attach Billing Entitlement features with stable lookup keys:

- `dmoft_camera_live` -> client feature `camera.live`
- `dmoft_adaptive_optics` -> client feature `optics.adaptive`
- `dmoft_devices_3` -> device limit `3`
- `dmoft_pro` -> tier `pro`
- `dmoft_offline_grace` -> permits the configured grace period

Do not attach `dmoft_hybrid_transport` until a real transport adapter passes its
physical benchmark and security gates. The in-memory coordinator skeleton does
not satisfy this launch condition.

Store Price IDs in `STRIPE_PRICE_PRO_MONTHLY` and
`STRIPE_PRICE_PRO_ANNUAL`. Client requests select exactly `pro_monthly` or
`pro_annual`; they never submit a trusted Price or Product ID.

Configure Customer Portal to expose only the two launch Prices and the published
cancellation behavior. Do not expose Team, Enterprise, hybrid transport, or any
trial configuration in Checkout or Portal at launch.

## 3. Webhook destination

Register `/api/v1/webhooks/stripe` and subscribe at minimum to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `entitlements.active_entitlement_summary.updated`

Set the endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`. The handler verifies
the signature over the exact raw body, limits request size, records Stripe event
IDs idempotently, and applies state changes transactionally. Replayed delivery of
an already completed event must return success without applying it twice.

Use Stripe CLI forwarding and test clocks in test mode before enabling live mode.
Test successful payment, required authentication, failed first payment, renewal,
past due, recovery, plan change, scheduled cancellation, immediate cancellation,
refund policy behavior, duplicate webhooks, reordered webhooks, additional-device
enrollment, device-limit races, and portal return.

## 4. Identity and database

- Configure an OIDC issuer, audience, and JWKS endpoint. Authorization uses the
  verified OIDC `sub`; billing email is never an authentication credential.
- Provision PostgreSQL with TLS, automated backups, point-in-time recovery, and
  a least-privilege application role.
- Run migrations once per deployment before serving traffic.
- Verify that every application instance uses the shipped PostgreSQL-backed
  `PostgresRateLimitStore`, and monitor/clean the shared `api_rate_limits` table.
  Replace the store only when the deployment provides an equivalently shared,
  atomic rate-limit backend.

## 5. License signing

- Generate an Ed25519 signing key in a secrets manager or HSM-capable key service.
- Export only PKCS#8 private key material to the server runtime when external
  signing is unavailable. Never store it in Git, a client bundle, or `NEXT_PUBLIC_*`.
- Publish the matching raw public key through the versioned keyset endpoint and
  package a trusted keyset with released clients.
- Give every signing key a unique `kid`. Add the new public key before issuing
  tokens with it; retain old public keys until every token and grace period expires.
- Rehearse emergency rotation and revocation.

## 6. Deployment

- Use separate Stripe accounts or test/live keys and separate databases for each
  environment.
- Set `APP_BASE_URL` and `LICENSE_ISSUER` to canonical HTTPS origins.
- Reject unexpected `Host`, forwarded-host, origin, and return-URL values.
- Ensure logs redact authorization headers, Checkout Session IDs, license tokens,
  device signatures, and all secrets.
- Alert on webhook failure backlog, repeated activation failures, unusual device
  churn, signing errors, database errors, and license-refresh availability.

## 7. Go-live gate

Do not switch to live Stripe keys until all automated checks pass, the full test
matrix above has evidence, the Community secure test suite has run on a platform
where its native crypto backend loads, and a human has reviewed the customer-facing
price and policy text. Make a low-value real transaction, verify entitlement and
portal cancellation end to end, confirm that the Checkout Session records terms
acceptance, then refund it according to the published policy.

Run the executable gates before and after the refunded live canary:

```powershell
Set-Location billing
npm.cmd run readiness:static
npm.cmd run readiness
```

Archive the versioned JSON report. Any failed or unavailable check blocks launch;
the commands perform read-only probes and never create or refund Stripe objects.
