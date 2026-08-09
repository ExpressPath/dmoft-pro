# DMOFT Pro billing and licensing

Production-oriented Next.js App Router service for DMOFT Pro subscriptions. Stripe owns billing and product-to-feature mappings; PostgreSQL stores an idempotent local projection and the device/license audit trail. The service issues short-lived Ed25519 licenses that are cryptographically bound to one device key.

The service never receives camera frames, optical payloads, files, receiver private keys, or device private keys. It also never treats an email address as authentication.

## Implemented boundary

- Stripe Checkout in `subscription` mode, restricted to two server-configured Price IDs.
- OIDC access-token authentication by verified issuer, audience, signature, and opaque `sub` claim.
- Stripe Customer Portal creation for the authenticated account's mapped Customer.
- Raw-body Stripe webhook verification.
- Persistent, retryable webhook idempotency with event IDs and a stale-processing lease.
- Authoritative synchronization from Stripe's paginated Active Entitlements API into PostgreSQL.
- Configurable feature lookup, tier, device-limit, and offline-grace policy.
- Initial activation authorized by OIDC account authentication, an account-bound completed paid/no-payment-required Checkout Session with current Terms acceptance, and a one-use Ed25519 proof-of-possession challenge.
- Additional-device enrollment authorized by OIDC plus a fresh proof-of-possession challenge, up to the entitlement-derived limit.
- Refresh authorized by the registered device's Ed25519 key and a new one-use challenge.
- Compact EdDSA license token with a maximum 30-day active lifetime.
- At most seven additional offline-grace days, and only when the Stripe entitlement policy explicitly enables it.
- PostgreSQL-backed fixed-window rate limiting with a replaceable store interface.
- A rotation-friendly public verification keyset.

Protocol details are normative for the Pro client: [docs/LICENSE_PROTOCOL_V1.md](docs/LICENSE_PROTOCOL_V1.md).

## Architecture

```text
OIDC access token -> Checkout API -> Stripe Checkout
                                      |
                                      v
Stripe webhook -> signature check -> persisted event -> authoritative Entitlements fetch
                                                       -> PostgreSQL projection

OIDC account + completed Checkout Session + device public key -> one-use challenge
OIDC account + device signature + active projection           -> device registration -> signed license

registered device public key -> one-use refresh challenge -> current projection -> renewed license
```

Stripe Entitlements, not locally inferred invoice state, decides which product features are granted. Subscription snapshots are retained only to bind the license to a current Stripe subscription and cap its lifetime at the observed billing-period end.

## Requirements

- Node.js 22 or newer
- PostgreSQL 15 or newer with `pgcrypto`
- Stripe Billing with Subscriptions and Entitlements enabled
- An OIDC provider that issues signed access tokens with stable, non-email `sub` values
- An Ed25519 license-signing key kept in a server-side secret store

## Local setup

```powershell
Copy-Item .env.example .env.local
npm.cmd install
npm.cmd run db:migrate
npm.cmd run dev
```

`db:migrate` takes `DATABASE_URL` and `DATABASE_SSL` from the process environment, serializes migration runners with a PostgreSQL advisory lock, and records each migration SHA-256. It refuses to run if an already-applied file has changed. PowerShell does not automatically load `.env.local`; export the variables in the shell or use your secret/environment runner before invoking this command.

Never commit `.env.local` or a private signing key. In production, inject secrets through the deployment platform and configure this directory as the project root.

Generate an Ed25519 key pair with OpenSSL:

```powershell
openssl genpkey -algorithm ED25519 -out license-private.pem
openssl pkey -in license-private.pem -pubout -out license-public.pem
```

Store the PKCS#8 private PEM in `LICENSE_ED25519_PRIVATE_KEY_PEM`, the public SPKI PEM in `LICENSE_ED25519_PUBLIC_KEY_PEM`, and delete unneeded local plaintext key files after placing them in an approved secret manager. `npm.cmd run keys:export` emits the exact client keyset JSON when the public-key environment values are set.

## Stripe product configuration

Create Entitlements features in Stripe and attach them to the corresponding subscription Products. The default policy recognizes these lookup keys:

| Purpose | Stripe feature lookup key | License result |
| --- | --- | --- |
| Live camera reader | `dmoft_camera_live` | `camera.live` |
| Adaptive optical tuning | `dmoft_adaptive_optics` | `optics.adaptive` |
| Hybrid local transport (roadmap; do not attach at launch) | `dmoft_hybrid_transport` | `transport.hybrid` |
| Pro tier marker | `dmoft_pro` | tier `pro` |
| Team tier marker | `dmoft_team` | tier `team` |
| Enterprise tier marker | `dmoft_enterprise` | tier `enterprise` |
| One device | `dmoft_devices_1` | limit 1 |
| Three devices | `dmoft_devices_3` | limit 3 |
| Ten devices | `dmoft_devices_10` | limit 10 |
| Offline grace allowed | `dmoft_offline_grace` | up to configured 7 days |

Each sellable Product needs at least one canonical product feature, one tier marker, and one device-limit feature. Unknown lookup keys fail closed and are never copied into a client license. Override the mapping with the strict `ENTITLEMENT_POLICY_JSON` schema shown in `.env.example`.

At launch, both recurring Prices must use the Pro Product carrying
`dmoft_camera_live`, `dmoft_adaptive_optics`, `dmoft_pro`, and
`dmoft_devices_3` (plus `dmoft_offline_grace` only if the published policy permits
it). Do not attach hybrid transport, Team/Enterprise, one-device, or ten-device
features at launch; those mappings exist only so later products can fail closed
against a fixed schema.

Set `STRIPE_PRICE_PRO_MONTHLY` and `STRIPE_PRICE_PRO_ANNUAL` to Prices on correctly configured Products. Arbitrary client-supplied Price IDs are not accepted.

Before live mode, publish counsel-approved Terms of Service at the Dashboard's
configured Terms URL and make Checkout require terms acceptance. The repository's
[commercial-terms draft](../docs/COMMERCIAL_LICENSE_TERMS.md) is deliberately not
launch-ready while any `COUNSEL MUST COMPLETE` marker remains. No free trial is
configured or advertised.

Register this webhook destination:

```text
POST https://YOUR_HOST/api/v1/webhooks/stripe
```

Subscribe it to:

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
entitlements.active_entitlement_summary.updated
```

The summary webhook can contain only a partial list. The handler intentionally ignores that embedded list and fetches every current Active Entitlement from Stripe's paginated API before replacing the local projection. This also makes event arrival order harmless.

## Stripe CLI verification

Start the app and forward signed events:

```powershell
stripe login
stripe listen --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,entitlements.active_entitlement_summary.updated --forward-to localhost:3000/api/v1/webhooks/stripe
```

Copy the listener's `whsec_...` value to `STRIPE_WEBHOOK_SECRET`, restart the app, then exercise a real test-mode Checkout created through `POST /api/v1/checkout`. That is the reliable end-to-end Entitlements test because the Product/Feature associations belong to your Stripe account.

For signature and persistence smoke tests:

```powershell
stripe trigger customer.subscription.updated
stripe trigger checkout.session.completed
```

Inspect `stripe_events`; successfully handled events end in `processed`. To test duplicate delivery, resend the same event ID from Stripe Workbench or use `stripe events resend EVENT_ID --webhook-endpoint=ENDPOINT_ID`. The row's `attempts` can increase, but projection and fulfillment remain idempotent.

## API summary

### Authenticated billing APIs

`POST /api/v1/checkout`

```json
{ "plan": "pro_monthly" }
```

Requires `Authorization: Bearer <OIDC access token>`. An `Idempotency-Key` of 8-128 safe ASCII characters is recommended. Returns the Stripe-hosted Checkout URL and Checkout Session ID.

`POST /api/v1/portal` requires the same OIDC bearer token and returns a Stripe Customer Portal URL. Customer IDs are resolved from the authenticated OIDC subject; the API never accepts a customer ID or email from the caller.

### Device licensing APIs

`POST /api/v1/licenses/challenge` accepts exactly one of:

```json
{
  "purpose": "activate",
  "checkout_session_id": "cs_test_...",
  "device_public_key": "UNPADDED_BASE64URL_RAW_ED25519_PUBLIC_KEY"
}
```

The `activate` request requires `Authorization: Bearer <OIDC access token>` and the Checkout Session must belong to that exact authenticated account. The `refresh` request is authenticated by the subsequent registered-device proof and does not use an OIDC bearer token.

```json
{
  "purpose": "refresh",
  "device_id": "dmoft-device-v1-...",
  "device_public_key": "UNPADDED_BASE64URL_RAW_ED25519_PUBLIC_KEY"
}
```

It returns `{challenge_id, challenge, expires_at}`. Sign the exact UTF-8 bytes of `challenge`; do not parse and reconstruct it.

Complete activation with `POST /api/v1/licenses/activate`:

```json
{
  "challenge_id": "UUID",
  "checkout_session_id": "cs_test_...",
  "device_public_key": "...",
  "device_name": "Work laptop",
  "signature": "UNPADDED_BASE64URL_ED25519_SIGNATURE"
}
```

Activation completion requires the same account's OIDC bearer token. The Checkout Session identifier correlates the client with the purchase; it is not an authentication credential.

Refresh with `POST /api/v1/licenses/refresh`:

```json
{
  "challenge_id": "UUID",
  "device_id": "dmoft-device-v1-...",
  "device_public_key": "...",
  "signature": "UNPADDED_BASE64URL_ED25519_SIGNATURE"
}
```

Both completion APIs return `{license_token, status, refresh_after}`, with `refresh_after` as Unix epoch seconds.

### Additional devices

For a launch Product carrying `dmoft_devices_3`, the initial Checkout Session activates device one. Devices two and three use an authenticated enrollment flow; the Checkout Session is never reused:

1. Call `POST /api/v1/devices/enrollment/challenge` with an OIDC bearer token and `{ "device_public_key": "..." }`.
2. Sign the returned exact UTF-8 `challenge` with that new device key.
3. Call `POST /api/v1/devices/enrollment/complete` with the same OIDC bearer token and `{challenge_id, device_public_key, device_name, signature}`.

The completion transaction locks the account row before counting active devices, so concurrent enrollments cannot exceed the Stripe entitlement-derived limit. The service does not use email, Customer ID, or an existing license token as enrollment authentication.

`GET /api/v1/devices` lists the authenticated account's registered devices. `POST /api/v1/devices/{device_id}/revoke` revokes one of them; both require an OIDC bearer token. Revocation prevents future refresh immediately, but an already-issued offline license remains usable until its signed `grace_until` deadline.

`GET /api/v1/licenses/keyset` returns the strict public-key contract and a five-minute cache lifetime. Keep retired verification keys published for at least the longest token lifetime plus grace and cache duration.

## License key rotation

1. Generate the next Ed25519 pair without changing the active signer.
2. Add the next public raw key and current key to `LICENSE_PUBLIC_KEYSET_JSON`; deploy and wait beyond the keyset cache window.
3. Change the active private/public PEM and `LICENSE_KEY_ID`, retaining the previous public key in the JSON keyset.
4. Keep the previous public key published for at least 37 days plus cache skew after the last token it signed.
5. Remove the retired key only after every such token is unusable.

For desktop binaries, pin an initial trusted key/keyset or trusted update channel. Fetching a keyset over TLS alone does not protect a client after its host trust is compromised.

## Operational jobs

Run periodic cleanup without deleting active audit data prematurely:

```sql
DELETE FROM api_rate_limits WHERE expires_at < now() - interval '1 hour';
DELETE FROM license_challenges WHERE expires_at < now() - interval '30 days';
DELETE FROM stripe_events WHERE processed_at < now() - interval '90 days' AND status = 'processed';
```

Monitor failed or stale `stripe_events`, Stripe webhook delivery health, activation failures, device-limit denials, license issuance latency, database saturation, and OIDC JWKS failures. Alert on any event left in `processing` for more than five minutes.

## Security properties and limits

- A Checkout Session ID is only an activation correlation identifier, not a credential or account identity. Initial challenge creation and activation completion both require OIDC authentication, and the service verifies the Session and its exact Customer, subscription, account binding, and current Terms version directly with Stripe.
- Device challenges expire in 1-15 minutes, carry every request binding, and are consumed in the same database transaction that records the license.
- A revoked device key cannot silently re-enroll; the account must add a new key or an administrator must use a future explicit recovery workflow.
- Retrying an already-completed activation or refresh challenge returns the same deterministically signed claims instead of issuing a second license.
- Cancellation cannot instantly revoke an already-issued offline token. Maximum exposure is the active lifetime (at most 30 days) plus up to seven grace days only for products carrying the grace entitlement. Use a shorter TTL and omit grace for stricter deployments.
- `past_due` subscriptions are eligible only while Stripe still reports active Entitlements. Stripe remains the access authority.
- The shipped PostgreSQL-backed rate limiter coordinates counters across application instances. It trusts `x-forwarded-for`, so deploy behind Vercel or another proxy that overwrites this header. Replace `RateLimitStore` only with an equivalently shared, atomic backend when platform policy requires it.
- The webhook payload is retained for idempotency/audit. Apply data-retention controls appropriate to the deployment jurisdiction.
- Checkout does not configure or advertise a free trial. Although Stripe's `trialing` status is understood for future administrator-configured subscriptions, repeated-trial prevention is not implemented; do not launch a trial until an account-level eligibility policy is added.
- In production, `APP_BASE_URL`, `OIDC_ISSUER`, `OIDC_JWKS_URL`, and `LICENSE_ISSUER` must use HTTPS. Development/test allows HTTP only on loopback hosts.

## Checks

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Official references: [Stripe Checkout](https://docs.stripe.com/payments/checkout), [Stripe webhooks](https://docs.stripe.com/webhooks), [Stripe Entitlements](https://docs.stripe.com/billing/entitlements), and [Next.js Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers).
