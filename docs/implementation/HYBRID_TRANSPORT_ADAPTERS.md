# Hybrid transport adapter implementation

Algorithm and security decisions live in `docs/design/HYBRID_TRANSPORT.md`.

- `HybridOffer` handles strict optical bootstrap metadata.
- `HybridEnvelope` serializes one Community transport packet.
- `HybridPacketTransport` is the send/receive/close SPI and must expose its
  transport kind plus authenticated channel-binding digest.
- `HybridSender` and `HybridReceiver` enforce channel binding, session binding,
  expiry, size limits, and entitlement checks.
- `MemoryHybridTransport` is a deterministic test adapter, not a network feature.

Production adapter checklist:

1. expose an authenticated channel-binding digest;
2. cap message and queue sizes;
3. implement cancellation and deadline propagation;
4. never log payload bytes, tokens, or endpoint secrets;
5. pass cross-device loss, replay, redirect, and permission tests;
6. keep optical packet reception active as fallback.
