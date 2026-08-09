# DMOFT Pro Client Security Model

## Trust boundaries

The Community `dmoft` package remains the sole implementation of the optical
protocol and encrypted-container algorithms. The Pro client only supplies camera
frames to `DynamicTransferReceiver.process_image`. A Pro entitlement never changes
protocol acceptance, FEC, authentication, replay, or safe-output rules.

The following capabilities are licensed:

- `camera.live`: OpenCV and browser camera capture.
- `optics.adaptive`: local capture-rate adaptation.

Offline generation and decoding of user-supplied image files are not gated.

## License token

The license is a compact, JWS-like three-segment token signed with Ed25519. Its
protected header is exactly:

```json
{"alg":"EdDSA","kid":"<issuer key id>","typ":"DMOFT-LICENSE","v":1}
```

The signature covers the ASCII bytes of `<base64url(header)>.<base64url(payload)>`.
Segments are unpadded base64url and header/payload JSON is canonical UTF-8 JSON.
The verifier enforces issuer, `dmoft-pro` audience, 30-day maximum lifetime,
seven-day maximum grace, exact device ID, exact device public-key digest, and all
requested entitlements. Unknown fields and ambiguous JSON values are rejected.

`ACTIVE` lasts through `exp`. `GRACE` lasts only after `exp` and through
`grace_until`, and is always surfaced as a warning. No feature works afterward.
Clock skew is accepted only for `iat`/`nbf`; it never extends expiry or grace.

## Device key

Each installation generates a distinct Ed25519 key. The private key never enters
an activation request. The public key is sent as unpadded base64url raw 32-byte
data. `device_key_sha256` is the unpadded base64url SHA-256 digest of those raw
bytes. `device_id` is deterministic:

```
dmoft-device-v1- + base64url(SHA256(raw_public_key)[0:18])
```

The client creates its state directory and private-key file with restrictive
permissions where the OS honors POSIX modes. Windows ACL inheritance still
applies, so managed deployments should protect the state directory with an
appropriate user-only DACL. Symlinked key and token files are rejected.

Activation and refresh use one-time, short-lived server challenges. The client
signs the exact returned UTF-8 challenge string. It never signs reconstructed
content, a URL chosen by a frame, or arbitrary input from the optical channel.

Checkout, initial activation, additional-device enrollment, device listing,
revocation, and Customer Portal creation require an OIDC bearer token supplied
through a bounded private file or environment variable. The client has no
command-line token argument and never prints the token. The Checkout Session ID
is correlation data, not an account credential. A revoked device cannot refresh,
although a previously issued offline token remains valid until its signed
deadline. First-install issuer keys must be bundled or downloaded only after an
out-of-band SHA-256 fingerprint match; TLS alone does not establish key trust.

## Local camera API

The server refuses non-loopback bind addresses. Camera access is initiated only
by an explicit CLI command or browser Start button. Browser `getUserMedia` remains
subject to browser permission, HTTPS/localhost secure-context, and origin rules.

Mutating endpoints require a random per-process CSRF token and an exact loopback
Origin. JPEG requests are streamed with a byte limit; dimensions are read before
OpenCV decompression and bounded by width, height, and pixel count. Processing is
serialized and rate limited. Browser sessions also have total duration and frame
count limits. No CORS permission, telemetry, analytics, remote
script, CDN asset, or upload endpoint is present.

The downloadable result is still the reconstructed encrypted DMOFT container.
Decryption, manifest authentication, decompression limits, explicit save approval,
and atomic final output remain Community receiver responsibilities.
