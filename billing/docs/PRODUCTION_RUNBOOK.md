# Production release runbook

The executable contract is described in
[`../../docs/design/STRIPE_PRODUCTION_READINESS.md`](../../docs/design/STRIPE_PRODUCTION_READINESS.md).
This runbook performs no automatic Stripe writes or legal approvals.

## Before deployment

1. Pin the release commit and preserve `npm ci`, `npm run check`, Community test,
   and dependency-audit results.
2. Have counsel approve the final customer documents. Publish versioned Terms,
   privacy, and support URLs without redirects; calculate SHA-256 over the exact
   Terms response bytes.
3. Provision separate production OIDC, PostgreSQL, Stripe, domain, signing key,
   and secret-store resources. Populate every value in `.env.production.example`
   through protected configuration.
4. Run `npm run readiness:static`. A non-zero exit blocks deployment.
5. Run `npm run db:migrate` as a single protected release job, then deploy the
   immutable image. Do not run migrations independently on every web replica.

## Production canary

Keep public sales disabled while performing the canary:

1. Authenticate through production OIDC and create Checkout through the product.
2. Complete a low-value live payment and confirm the signed webhook becomes
   `processed` exactly once.
3. Confirm the active Entitlements projection, device proof-of-possession,
   license activation/refresh, and public keyset verification.
4. Open the configured Customer Portal, schedule cancellation, and confirm the
   resulting webhook/projection.
5. Fully refund the canary charge according to the published policy.
6. Store redacted evidence in the approved system. Set the canary Charge ID,
   evidence reference, and UTC completion timestamp in protected configuration.
7. Run `npm run readiness`; archive its JSON report with the release.

Only after every check reports `pass` may the named human approver enable sales.

## Rollback and incident rules

- Disable Checkout/Portal traffic before rotating secrets or restoring a billing
  database. Do not delete received Stripe events to force replay.
- Stripe event IDs remain the idempotency key. Failed/stale events are retried
  through the existing claim lease and authoritative current-object retrieval.
- Rotate the webhook secret and license signing key through their documented
  overlap procedures; never remove verification keys while a signed license can
  remain valid.
- Alert on failed/stale webhooks, license refresh failure, OIDC/JWKS failure,
  database saturation, and readiness drift. Rerun readiness after any Stripe
  catalog, Portal, webhook, domain, policy, OIDC, or database change.
