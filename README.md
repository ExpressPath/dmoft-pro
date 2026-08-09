# DMOFT Pro

DMOFT Pro is the paid, source-available live-capture product built on the
Apache-2.0 [DMOFT Community](https://github.com/ExpressPath/dmoft-community)
optical protocol. It adds explicit camera access, adaptive real-time scanning,
and a Stripe-backed commercial entitlement system without moving optical frame
content off the local device.

> Status: engineering MVP. The protocol and safety checks are implemented and
> tested, but the product has not completed independent cryptographic review,
> camera certification, app-store review, or production payment deployment.

## Repository layout

- `client/`: local Python camera client, localhost capture UI, device identity,
  and offline license verification.
- `billing/`: Next.js Stripe Checkout, webhook, entitlement, device activation,
  license refresh, and customer-portal service.
- `docs/`: product boundary, architecture, commercial model, and operations.

## Community and Pro boundary

| Capability | Community | Pro |
| --- | :---: | :---: |
| Secure DMOFT wire protocol and encrypted container | Yes | Uses Community |
| Static/hybrid/dynamic frame generation | Yes | Uses Community |
| Decode supplied image files | Yes | Uses Community |
| FIPS 205 SLH-DSA signature fast lane | Yes | Uses Community |
| Live camera device access | No | Yes |
| Browser localhost capture UI | No | Yes |
| Adaptive live scan control | No | Yes |
| Hybrid LAN/Wi-Fi Direct/USB routing | No | Planned; not yet shipped |
| Security fixes and interoperability updates | Yes | Inherited immediately |

The paid boundary is an integration and operations boundary. Confidentiality,
authentication, error correction, file-safety checks, and protocol compatibility
are never deliberately weakened in Community.

## Quick start

Install Community first, then the Pro client:

```powershell
python -m pip install -e ..\dmoft-community
python -m pip install -e .\client[dev]
$env:DMOFT_PRO_ISSUER_KEYS = "C:\path\to\issuer-keyset.json"
$env:DMOFT_PRO_LICENSE_ISSUER = "https://licenses.example.com"
dmoft-pro doctor
```

Run the local capture UI only after installing a valid license:

```powershell
dmoft-pro serve --host 127.0.0.1 --port 8765
```

Configure and test billing:

```powershell
Set-Location billing
Copy-Item .env.example .env.local
npm.cmd install
npm.cmd run dev
```

The local UI must bind to loopback. Camera access is requested only after a
user gesture and can be stopped at any time. Captured frames are decoded by the
local service and are not sent to the billing service.

## Commercial use

This repository uses the Business Source License 1.1. Inspection, modification,
redistribution, and non-production testing are allowed by that license. Production
use before the Change Date requires a valid DMOFT Pro commercial subscription or
a separate written commercial license. See [LICENSE](LICENSE) and
[the commercial model](docs/COMMERCIAL_MODEL.md). The repository also contains a
[counsel-required commercial-terms draft](docs/COMMERCIAL_LICENSE_TERMS.md); it is
not ready to publish or accept until qualified counsel completes its marked items.

The license token is a device-bound Ed25519 compact JWS. Stripe secrets and the
license signing key exist only in the billing service; the client contains only
verification keys. A local token is valid for at most 30 days and may permit no
more than seven additional offline grace days. Cancellation therefore has a
documented bounded offline revocation delay.

## Security

Do not use this MVP as the sole control for high-value financial authorization.
Review [SECURITY.md](SECURITY.md), keep explicit confirmation on the receiving
device, and independently validate the Community cryptographic implementation
before production use.
