from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from dmoft_pro_client.device import DeviceIdentity
from dmoft_pro_client.encoding import b64url_encode, canonical_json_bytes
from dmoft_pro_client.entitlement import (
    CAMERA_LIVE_FEATURE,
    OPTICS_ADAPTIVE_FEATURE,
    EntitlementClaims,
    EntitlementStatus,
    EntitlementVerifier,
    IssuerKeySet,
    VerifiedEntitlement,
)

NOW = 2_000_000_000
ISSUER = "https://licenses.test"
KEY_ID = "test-2026-01"


@dataclass
class TokenFactory:
    issuer_private_key: Ed25519PrivateKey
    device: DeviceIdentity

    def claims(self, **overrides: Any) -> dict[str, Any]:
        values: dict[str, Any] = {
            "aud": "dmoft-pro",
            "device_id": self.device.device_id,
            "device_key_sha256": self.device.public_key_sha256,
            "entitlements": [CAMERA_LIVE_FEATURE, OPTICS_ADAPTIVE_FEATURE],
            "exp": NOW + 1000,
            "grace_until": NOW + 2000,
            "iat": NOW - 100,
            "iss": ISSUER,
            "jti": "license-token-1",
            "nbf": NOW - 100,
            "sub": "cus_opaque",
            "subscription_id": "sub_opaque",
            "tier": "pro",
            "v": 1,
        }
        values.update(overrides)
        return values

    def token(
        self,
        *,
        claims: dict[str, Any] | None = None,
        header: dict[str, Any] | None = None,
    ) -> str:
        protected = header or {"alg": "EdDSA", "kid": KEY_ID, "typ": "DMOFT-LICENSE", "v": 1}
        payload = claims or self.claims()
        header_segment = b64url_encode(canonical_json_bytes(protected))
        payload_segment = b64url_encode(canonical_json_bytes(payload))
        signing_input = f"{header_segment}.{payload_segment}".encode("ascii")
        signature = b64url_encode(self.issuer_private_key.sign(signing_input))
        return f"{header_segment}.{payload_segment}.{signature}"


@pytest.fixture
def device() -> DeviceIdentity:
    return DeviceIdentity(Ed25519PrivateKey.generate())


@pytest.fixture
def issuer_private_key() -> Ed25519PrivateKey:
    return Ed25519PrivateKey.generate()


@pytest.fixture
def token_factory(
    issuer_private_key: Ed25519PrivateKey,
    device: DeviceIdentity,
) -> TokenFactory:
    return TokenFactory(issuer_private_key, device)


@pytest.fixture
def verifier(issuer_private_key: Ed25519PrivateKey) -> EntitlementVerifier:
    return EntitlementVerifier(
        IssuerKeySet({KEY_ID: issuer_private_key.public_key()}),
        expected_issuer=ISSUER,
    )


def make_verified_entitlement(
    device: DeviceIdentity,
    *,
    features: Iterable[str] = (CAMERA_LIVE_FEATURE, OPTICS_ADAPTIVE_FEATURE),
) -> VerifiedEntitlement:
    claims = EntitlementClaims(
        version=1,
        issuer=ISSUER,
        audience="dmoft-pro",
        subject="cus_opaque",
        token_id="token-1",
        issued_at=NOW - 100,
        not_before=NOW - 100,
        expires_at=NOW + 1000,
        grace_until=NOW + 2000,
        tier="pro",
        entitlements=tuple(sorted(features)),
        device_id=device.device_id,
        device_key_sha256=device.public_key_sha256,
        subscription_id="sub_opaque",
    )
    return VerifiedEntitlement(claims, EntitlementStatus.ACTIVE, KEY_ID)
