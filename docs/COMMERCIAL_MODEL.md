# Commercial Model

## Recommended launch model

Use a source-available open-core subscription:

1. DMOFT Community is Apache-2.0 and provides the complete secure optical
   protocol, test vectors, generation, and non-live decoding.
2. DMOFT Pro source is visible under BSL 1.1 for auditability and non-production
   evaluation.
3. A Stripe subscription grants production rights and the signed entitlement
   required by the live-camera client.

This model charges for continuing device integration and workflow quality rather
than charging for cryptographic safety. It also satisfies the requirement that
both GitHub repositories can be publicly inspected.

## Launch offer

| Plan | Price | Devices | Shipped entitlement |
| --- | ---: | ---: | --- |
| Community | JPY 0 | Unlimited | Protocol, generation, saved-image decoding |
| Pro Monthly | JPY 1,980/month | 3 | `camera.live`, `optics.adaptive` |
| Pro Annual | JPY 19,800/year | 3 | Same; two months effectively discounted |

Recommended launch settings:

- One Pro product with monthly and annual recurring Prices in Stripe.
- No free trial at launch. Add one only after account-level repeat-trial
  prevention and customer-facing trial terms are implemented and tested.
- No lifetime license: camera/device compatibility and security maintenance are
  recurring obligations.
- Stripe Billing Entitlements are authoritative. A `past_due` subscription keeps
  access only while Stripe still reports the mapped features as active;
  `unpaid`, `canceled`, and `incomplete_expired` must not produce entitlements.
- At most three active device keys per subscription. Users explicitly deactivate
  a device before replacing it after the limit.
- Stripe Customer Portal handles payment methods, invoices, plan changes, and
  cancellation.
- Checkout must require acceptance of the final published commercial terms. The
  current [commercial-terms draft](COMMERCIAL_LICENSE_TERMS.md) is not launch-ready
  until qualified counsel completes and approves it.
- Stripe Tax can be enabled before selling in jurisdictions where registration
  or collection is required. Tax and consumer terms require jurisdiction-specific
  professional review before launch.

Prices are initial product hypotheses, not market facts. Validate conversion,
support load, churn, and camera-device maintenance cost before changing them.
Price changes happen in Stripe through new Price objects, while stable Billing
Entitlement feature keys keep client authorization independent of price IDs.

## Later tiers

Do not sell these until their features exist:

- Team: seat administration, shared device inventory, centralized policy, and
  priority support.
- Enterprise: SSO/SCIM, MDM deployment, audit export, hardware-backed keys,
  certified device matrix, SLA, and negotiated data-processing terms.

## Entitlement policy

Canonical feature keys are:

- `camera.live`
- `optics.adaptive`
- `transport.hybrid` (roadmap; do not attach at launch)

The service persists Stripe's active entitlements and uses them to issue a
device-bound token. It never determines access from a browser success redirect,
an email address, or unverified client-supplied plan names.

Token lifetime is at most 30 days. The offline grace claim is at most seven days
past expiry and must produce a visible warning. This creates an explicit maximum
revocation delay. High-assurance enterprise policies can set both periods lower.

## Metrics

Track only the data needed to operate the product:

- paid Checkout conversion
- monthly/annual recurring revenue and voluntary/involuntary churn
- active entitled installations and device-limit failures
- license refresh success/failure reason
- local opt-in diagnostic aggregates such as accepted-frame ratio and camera
  model; never collect optical payload bytes or reconstructed content
- authenticated reconstructed bytes per second for product quality
