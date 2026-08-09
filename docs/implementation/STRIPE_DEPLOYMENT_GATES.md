# Stripe deployment-gate implementation

This document maps the production-readiness design to executable code. It is
deliberately separate from the design contract so implementation choices can
change without weakening the release criteria.

## Components

- `billing/src/lib/readiness.ts`: deterministic checks, report schema, and pure
  snapshot validators.
- `billing/src/lib/readiness-probes.ts`: read-only PostgreSQL, Stripe, OIDC, and
  published-document collection adapters.
- `billing/scripts/production-readiness.ts`: operator CLI. It prints JSON and
  returns exit code 1 whenever `ready` is false.
- `billing/tests/readiness.test.ts`: boundary and fail-closed unit tests.
- `billing/.env.production.example`: complete variable inventory with no usable
  secrets or approvals.
- `billing/Dockerfile`: non-root, standalone production runtime skeleton.

## Modes

```powershell
# No network or database access. Validates only production configuration.
npm.cmd run readiness:static

# Full read-only probes. Required before go-live.
npm.cmd run readiness
```

The report contains check identifiers, categories, status, and remediation text.
It never contains secret keys, webhook secrets, private signing material, bearer
tokens, Checkout Session IDs, or license tokens.

## Evidence variables

`PRODUCTION_TERMS_SHA256` is calculated over the exact response bytes served by
`PRODUCTION_TERMS_URL`; redirects are rejected. `LEGAL_APPROVAL_REFERENCE` and
`PRODUCTION_E2E_REFERENCE` should identify immutable records in the operator's
approved evidence system, not contain the record itself or personal data.

`STRIPE_LIVE_CANARY_CHARGE_ID` names the fully refunded low-value charge used for
the production canary. The probe validates that it is live, paid, JPY, non-zero,
and fully refunded. The CLI never initiates or refunds a charge.

## CI/deployment policy

Store the JSON report as a release artifact. A deployment can automate the
static and read-only gates, but enabling sales remains a separate protected
environment action requiring the named human approver. Do not expose the CLI as
an unauthenticated HTTP route: its result is operational metadata and its probes
consume privileged server credentials.
