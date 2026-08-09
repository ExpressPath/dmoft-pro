# DMOFT Pro License Protocol v1

This document fixes the byte-level contract shared by the billing service and the Python desktop client.

## Encoding primitives

- `base64url` means RFC 4648 URL-safe Base64 with no `=` padding.
- Text is UTF-8 unless explicitly stated as ASCII.
- Hashes use SHA-256.
- Signatures use Ed25519 with no pre-hashing by the application.
- Compact-token JSON is recursively key-sorted, has no insignificant whitespace, and is UTF-8 encoded.
- All times are integral Unix epoch seconds in UTC.

## Device identity

The client generates an Ed25519 key pair locally. The private key never leaves the device.

```text
raw_public_key       = 32-byte Ed25519 public key
full_digest          = SHA256(raw_public_key)
device_key_sha256    = base64url(full_digest)
device_id            = "dmoft-device-v1-" + base64url(full_digest[0:18])
device_public_key    = base64url(raw_public_key)
```

The server rejects padded Base64, DER/SPKI input, non-32-byte public keys, and non-64-byte signatures.

## Challenge

The server creates a random UUID challenge identifier, a random 32-byte nonce, and an expiry. It returns the exact string stored in PostgreSQL:

```text
DMOFT-LICENSE-CHALLENGE/1
purpose=<activate-enroll-or-refresh>
challenge_id=<uuid>
device_id=<derived-device-id>
device_key_sha256=<full-digest-base64url>
checkout_session_id=<cs-id-or-hyphen>
nonce=<32-random-bytes-base64url>
expires_at=<unix-seconds>
```

There is no trailing newline. The device computes:

```text
signature = Ed25519-Sign(device_private_key, UTF8(challenge))
```

The completion request repeats all external bindings. The server loads the row under `SELECT ... FOR UPDATE`, checks purpose, key, derived ID, Checkout Session, expiry, and signature, then marks the challenge used in the same transaction as device/license persistence. A fresh challenge is usable once. An exact retry after a committed response loss may reconstruct the stored token after challenge expiry only after the same signature, request bindings, and account/device ownership have been verified; an expired unused challenge never succeeds.

## Compact license token

The token has three unpadded base64url segments:

```text
base64url(canonical_header) + "." +
base64url(canonical_payload) + "." +
base64url(ed25519_signature)
```

The Ed25519 signature input is the ASCII bytes of the first segment, a literal `.`, and the second segment.

Protected header:

```json
{"alg":"EdDSA","kid":"<deployment-key-id>","typ":"DMOFT-LICENSE","v":1}
```

Payload fields:

```json
{
  "aud": "dmoft-pro",
  "device_id": "dmoft-device-v1-...",
  "device_key_sha256": "...",
  "entitlements": ["camera.live", "optics.adaptive"],
  "exp": 0,
  "grace_until": 0,
  "iat": 0,
  "iss": "https://license-service.example",
  "jti": "UUID",
  "nbf": 0,
  "sub": "cus_...",
  "subscription_id": "sub_...",
  "tier": "pro",
  "v": 1
}
```

`sub` is the opaque Stripe Customer ID, never an email. `entitlements` contains only canonical allowlisted client features. It is sorted and contains no duplicates. `transport.hybrid` remains a reserved roadmap entitlement and is not attached to the launch Product.

The following invariants are mandatory:

```text
aud == "dmoft-pro"
exp - iat <= 30 days
exp <= grace_until <= exp + 7 days
grace_until == exp unless current Stripe policy grants offline grace
device_key_sha256 == base64url(SHA256(local_raw_public_key))
device_id == "dmoft-device-v1-" + base64url(SHA256(local_raw_public_key)[0:18])
```

Client evaluation states:

```text
now < nbf                         -> NOT_YET_VALID
nbf <= now <= exp                 -> ACTIVE
exp < now <= grace_until          -> GRACE (only policy-approved offline behavior)
now > grace_until                 -> EXPIRED
invalid signature/header/binding  -> INVALID
```

The client must not silently treat `GRACE` as full online entitlement. It may continue only explicitly offline-safe local functions defined by product policy. Network/hybrid functions should require `ACTIVE` unless a separate policy states otherwise.

## Public keyset

`GET /api/v1/licenses/keyset` returns exactly:

```json
{"v":1,"keys":[{"kid":"...","alg":"EdDSA","public_key":"<base64url-raw-32-byte-key>"}]}
```

Unknown top-level or key fields are not emitted. Clients select by `kid`, require `alg == "EdDSA"`, decode exactly 32 bytes, and reject an unknown key. The server publishes the response with `Cache-Control: public, max-age=300, stale-while-revalidate=3600` to permit rotation without making key removal immediate. A first-install client must use a bundled keyset or verify an out-of-band SHA-256 fingerprint before storing a downloaded keyset; HTTPS alone is not a trust anchor.

## Activation sequence

1. An OIDC-authenticated client creates a subscription Checkout Session.
2. Stripe requires Terms of Service consent and records the current `dmoft_terms_version` in Checkout and subscription metadata.
3. Stripe completes Checkout; Stripe webhooks synchronize current Entitlements.
4. The OIDC-authenticated client calls the activation challenge endpoint with the completed Checkout Session ID and device public key.
5. The server re-retrieves the Session, verifies accepted consent/version and exact OIDC account/Customer/expanded-subscription binding, refreshes billing state, and stores those bindings with a one-use challenge.
6. The device signs the returned challenge exactly and completes activation with the same OIDC account.
7. In one transaction, the server verifies every binding, uses the exact Checkout subscription for the license-period cap, enforces the device limit, registers the key, and consumes the Checkout activation and challenge.

A Checkout Session can perform initial activation once. It is never reused to add another device, and its identifier is correlation data rather than an account authentication credential.

## Additional-device enrollment

1. The new device authenticates the account through OIDC and submits its public key to `/api/v1/devices/enrollment/challenge`.
2. The service refreshes Stripe billing state, verifies active feature/tier/device-limit Entitlements, and creates a purpose `enroll` challenge bound to the OIDC account and new key.
3. The new device signs the exact challenge and submits it with the same OIDC identity to `/api/v1/devices/enrollment/complete`.
4. The transaction locks the account row, rechecks current projected access, counts active devices, registers the key, consumes the challenge, and records the license.

This supports multi-device products (the launch policy is three devices) without turning a Checkout Session, Customer ID, email address, old license, or device name into an authentication credential.

## Refresh sequence

1. The registered device requests a refresh challenge with its deterministic ID and public key.
2. The service fetches current Stripe subscriptions and Active Entitlements, then updates PostgreSQL.
3. The device signs the exact returned challenge.
4. In one transaction, the service checks that the device is active, consumes the challenge, and records the new license.

Possession of an old license token alone cannot refresh it. Possession of the registered device private key is required.

## Device listing and revocation

`GET /api/v1/devices` lists only devices owned by the OIDC-authenticated account. `POST /api/v1/devices/{device_id}/revoke` locks the account and device rows, is idempotent, marks the device and its issued-license audit rows revoked, and immediately prevents future refresh. Because license verification is offline, a token already issued to that device can remain usable through its signed `grace_until`; the response exposes the latest possible deadline and the client must display it.
