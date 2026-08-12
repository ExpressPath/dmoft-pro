# DMOFT Pro Local Camera Client

This package adds licensed, local live-camera capture to the Community `dmoft`
protocol engine. It does not replace, weaken, or fork the Community wire format,
cryptography, inner FEC, or fountain decoder.

The source is published under Business Source License 1.1. Non-production use is
permitted; production use requires a DMOFT Pro commercial subscription until the
Change Date, 2030-08-09, when this version changes to Apache-2.0.

## Capability boundary

- Community: frame generation, decoding supplied images, optical transport,
  cryptographic container handling, and protocol interoperability.
- Pro: explicit live-camera capture, localhost browser capture, optional adaptive
  capture pacing, and an experimental optically pinned hybrid transport adapter
  boundary.

Camera frames stay on the device. The browser UI sends bounded JPEG frames only
to its loopback origin. It contains no telemetry or remote upload path.

`dmoft_pro_client.hybrid` currently provides strict short-lived offers, packet
envelopes, entitlement/session/channel-binding checks, and a bounded in-memory
test adapter. It does not discover peers or open TLS/WebRTC/Wi-Fi Direct sockets;
applications must not advertise hybrid transfer until a production adapter is
implemented and certified.

## Install for development

Install the Community package first, then this package:

```powershell
python -m pip install -e ..\..\dmoft-community
python -m pip install -e ".[dev]"
```

The billing service publishes an Ed25519 issuer keyset. A release should bundle
that keyset. For first-install bootstrap, `keyset-fetch` downloads only over
HTTPS, disables redirects, and refuses to store the result unless it matches an
out-of-band SHA-256 fingerprint. HTTPS by itself is not accepted as the key
trust anchor.

```powershell
dmoft-pro keyset-fetch --url https://billing.example/api/v1/licenses/keyset --sha256 <PINNED_SHA256> --output issuer-keyset.json
$env:DMOFT_PRO_ISSUER_KEYS = "issuer-keyset.json"
$env:DMOFT_PRO_LICENSE_ISSUER = "https://billing.example"
$env:DMOFT_PRO_ACCESS_TOKEN_FILE = "oidc-access-token.txt"

dmoft-pro checkout --server-url https://billing.example --plan pro_monthly
# Manually open the printed Stripe URL, review the terms, and complete payment.
dmoft-pro activate --server-url https://billing.example --checkout-session-id cs_live_...
dmoft-pro enroll --server-url https://billing.example --device-name "Second device"
dmoft-pro devices-list --server-url https://billing.example
dmoft-pro devices-revoke --server-url https://billing.example dmoft-device-v1-...
dmoft-pro portal --server-url https://billing.example
dmoft-pro doctor --issuer-keys issuer-keyset.json
dmoft-pro scan-camera --issuer-keys issuer-keyset.json --output transfer.dmoft
dmoft-pro serve --issuer-keys issuer-keyset.json
```

Checkout, initial activation, enrollment, device listing/revocation, and Portal
creation require the same OIDC account bearer token. Supply it through a bounded
private file or `DMOFT_PRO_ACCESS_TOKEN`; there is deliberately no command-line
token argument, URL auto-open, or provider-specific login implementation. The
Checkout Session ID is correlation data and does not authenticate activation.
Revocation blocks refresh immediately, but an already-issued offline token may
remain usable until the signed deadline printed by `devices-revoke`.

`scan-camera` opens the selected camera only after the command is invoked and
always releases it on stop, completion, error, or Ctrl+C. `serve` binds to
`127.0.0.1` by default and refuses non-loopback addresses.

See [docs/SECURITY.md](docs/SECURITY.md) for the entitlement, device-key, browser,
and failure-mode design.
