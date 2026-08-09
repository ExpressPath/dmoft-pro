# Community / Pro Feature Boundary

## Rule

Community owns the interoperable and security-critical protocol. Pro owns the
convenience, device integration, ongoing camera optimization, and commercial
operations around it.

## Community (Apache-2.0)

- Wire specifications and canonical encodings
- Receiver-bound encryption and authenticated chunks
- Safe reconstruction and replay controls
- Static, hybrid, and dynamic optical frame generation
- Saved-image and caller-supplied frame decoding
- Color calibration, erasure decisions, inner FEC, and outer fountain repair
- SLH-DSA signature fast-lane format and transport
- Reference CLI, test vectors, and synthetic benchmarks
- All vulnerability and interoperability fixes

Community deliberately exposes APIs that accept image arrays or image files so
other open implementations can interoperate. It does not enumerate, open, or
continuously read a camera device.

## Pro (BSL 1.1 plus commercial subscription)

- Camera enumeration and explicit live capture
- Local browser capture UX using `getUserMedia`
- Live quality measurement and adaptive scan controls
- Device-bound offline entitlements
- Stripe Checkout, Billing Entitlements, webhook reconciliation, and portal
- Optically pinned hybrid packet coordinator and transport adapter interface
- Commercial support and certified device profiles when those programs launch

The hybrid coordinator includes only strict offers/envelopes and a bounded memory
adapter for tests. It is not a usable LAN or WebRTC transport by itself, and its
entitlement must not be attached to the launch Product.

## Roadmap, not included in the production MVP

- Production TLS LAN/WebRTC adapters, discovery, signaling, and Wi-Fi Direct/USB integration
- Multipath scheduling and differential resume
- Signed device-profile updates
- Hardware-backed license and receiver keys
- Organization administration, SSO/SCIM, MDM, audit export, and SLA support

These items must remain labelled as roadmap until implemented and verified.

## Anti-patterns

- Do not gate decryption, authentication, safe-save, or security patches.
- Do not make Community frames intentionally less reliable.
- Do not put Stripe state or a license token inside the optical wire protocol.
- Do not upload camera frames to prove entitlement.
- Do not treat a paid license as authorization to execute, import, or approve a
  reconstructed object.
