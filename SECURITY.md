# Security Policy

## Supported versions

Only the latest tagged release receives security fixes during the MVP period.
Community protocol security fixes must be consumed without a Pro paywall.

## Reporting

Do not open a public issue for a suspected vulnerability. Until a dedicated
security address is published, use GitHub's private vulnerability-reporting
feature for this repository.

Include the affected version, platform, reproduction steps, impact, and whether
camera frames or payment credentials may have been exposed. Do not include live
Stripe keys, license-signing private keys, receiver private keys, or real
confidential payloads.

## Trust boundaries

- Optical payloads and camera frames remain local to the Pro client by default.
- The billing service receives subscription, entitlement, and public device-key
  metadata; it must never receive DMOFT file contents or receiver private keys.
- The Stripe webhook signature is verified over the exact raw request body.
- Stripe secret keys and the Ed25519 license-signing key are server-only.
- License checks are a commercial-access control, not a cryptographic security
  boundary for optical payloads.
- Reconstructed files still follow the Community authenticate/decrypt/safe-save
  pipeline. A valid commercial license never makes an unauthenticated file safe.

## Known MVP limits

- No independent cryptographic or payment-integration audit has been completed.
- Offline licenses create a bounded revocation delay (at most token lifetime plus
  the configured grace period).
- Hardware-backed device keys, MDM, organization SSO, and audited hybrid transport
  are roadmap items and are not represented as shipped features.
