# Stripe production-readiness design

Status: implementation contract. Passing this contract means that the deployed
configuration and the observable external systems match the launch profile. It
does not replace legal advice, an independent security review, or an operator's
approval to begin selling.

## 1. Separation of responsibilities

The go-live decision is split into six gates. A gate is either fully passing or
the release is not ready; warnings never silently become approval.

| Gate | Question | Evidence source |
| --- | --- | --- |
| Static configuration | Are production mode, TLS, live keys, identifiers, and evidence references configured? | Parsed server environment |
| Stripe account/catalog | Is the live account enabled and are the two launch Prices, Product features, webhook, Portal, and refunded canary correct? | Read-only Stripe API calls |
| Identity | Does the configured OIDC discovery document bind the exact issuer and JWKS URI, with a public signing key available? | HTTPS discovery/JWKS probes |
| Database | Is PostgreSQL 15+, TLS, and the expected migration head in use? | Read-only SQL probe |
| Published policy | Are the terms, privacy, and support pages reachable, and do the published Terms bytes match the approved SHA-256? | HTTPS document probes plus operator evidence |
| End-to-end evidence | Was the production OIDC -> Checkout -> webhook -> entitlement -> activation -> Portal/cancellation flow recorded recently? | Operator reference and completion timestamp; live canary verified through Stripe |

The executable checks prove consistency of supplied evidence. They cannot prove
that counsel is qualified, that a policy is legally sufficient, or that a human
performed every step honestly. Those remain explicit external release controls.

## 2. Launch catalog invariant

The first production catalog contains one active live Product and exactly two
configured recurring Prices:

- JPY 1,980 every month;
- JPY 19,800 every year.

Both Prices must point to the same Product. The Product must attach these Stripe
Entitlements feature lookup keys:

- `dmoft_camera_live`
- `dmoft_adaptive_optics`
- `dmoft_devices_3`
- `dmoft_pro`
- `dmoft_offline_grace`

The launch Product must not attach roadmap keys for hybrid transport, other
device limits, or Team/Enterprise tiers. Shipping an adapter skeleton does not
make `transport.hybrid` a saleable entitlement; physical/security certification
must pass first.

## 3. Fail-closed execution

`npm run readiness` performs only read operations. It emits a versioned JSON
report and exits non-zero unless every automated gate passes. It never creates a
Product, changes a Price, registers a webhook, accepts legal terms, creates a
charge, or refunds money.

The production process still validates its environment at startup. Checkout
uses only the two configured server-side Price IDs, requires Terms consent, and
the Portal uses one configured live Portal configuration. Webhooks authenticate
the raw request body and production rejects test-mode events.

## 4. Deployment order

1. Complete test-mode catalog and integration tests.
2. Obtain and record policy approval; publish immutable-version Terms and policy
   URLs over HTTPS.
3. Provision production OIDC, PostgreSQL, signing keys, domain, and secret store.
4. Configure the live Stripe Product, Prices, Entitlements, Portal, and webhook.
5. Deploy without advertising Checkout; run migrations and `npm run readiness`.
6. Complete one low-value live purchase through the real OIDC flow, confirm
   license activation and cancellation, fully refund the charge, and record the
   evidence reference/timestamp.
7. Run `npm run readiness` again and preserve its JSON output with the release.
8. Require a named human release approver before enabling sales traffic.

## 5. Reference basis

- [Stripe go-live checklist](https://docs.stripe.com/get-started/checklist/go-live)
- [Stripe webhook handling](https://docs.stripe.com/webhooks)
- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe Entitlements](https://docs.stripe.com/billing/entitlements)
