# Optional LAN and Wi-Fi hybrid transport design

Status: entitlement-gated executable coordinator with adapter boundaries; no
platform discovery or production WebRTC/TLS adapter is enabled.

Implementation structure is separated into
`docs/implementation/HYBRID_TRANSPORT_ADAPTERS.md`.

## Security invariant

Optical bootstrap remains authoritative. A receiver-displayed request binds the
DMOFT session to a short-lived local transport offer and a SHA-256 channel
binding. The local channel carries the same encrypted outer-FEC packets as the
optical stream. It never carries a plaintext file key or decrypted content.

The channel binding is the SHA-256 digest of a transport-specific authenticated
identity:

- TLS LAN adapter: the receiver's ephemeral certificate SPKI;
- WebRTC adapter: the negotiated DTLS certificate fingerprint.

The sender compares the observed binding with the optically scanned value before
sending. A network attacker can still cause denial of service, but cannot
silently redirect the scanned transfer to another endpoint.

## Offer

`HybridOffer` contains:

- schema version;
- 16-byte DMOFT session ID and independent 16-byte transfer ID;
- issue and expiry times, with a maximum five-minute lifetime;
- transport kind (`tls-lan` or `webrtc-data-channel`);
- bounded endpoint URI;
- 32-byte channel-binding digest.

The offer is intended for a future receiver-request extension. It is parsed as
strict canonical JSON in the current executable skeleton so duplicate or
unknown fields fail closed.

## Packet envelope

Each network message contains the offer's transfer ID, one existing protected
`TransportFrameHeader`, and its payload. A domain-separated SHA-256 digest binds
those fields and detects envelope corruption; it is not a replacement for
container AEAD. Header CRC, payload CRC, outer FEC, and final receiver-bound
authentication continue unchanged.

Optical and network packets may arrive in any order. Reusing a sequence number
with identical bytes is a duplicate; reusing it with different bytes is an
error, enforced by Community's `DynamicTransferReceiver`.

## WebRTC and TLS choices

WebRTC DataChannel uses the standardized SCTP/DTLS/UDP stack and can later carry
self-contained DMOFT envelopes in unordered mode. TLS LAN uses an ephemeral,
optically pinned certificate and no unauthenticated HTTP fallback. mDNS,
Wi-Fi Direct setup, signaling, firewall traversal, and platform permission UI
remain separate adapters.

## Entitlement boundary

Every protected send or receive calls the local authorizer for
`transport.hybrid`. The launch Stripe product must not attach this entitlement
until at least one production adapter and its physical benchmark/security gates
are complete.
