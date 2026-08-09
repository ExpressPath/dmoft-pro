from __future__ import annotations

import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from conftest import ISSUER, KEY_ID, NOW, TokenFactory
from dmoft_pro_client.device import DeviceIdentity
from dmoft_pro_client.encoding import b64url_decode, b64url_encode, canonical_json_bytes
from dmoft_pro_client.entitlement import (
    CAMERA_LIVE_FEATURE,
    EntitlementError,
    EntitlementStatus,
    EntitlementVerifier,
    IssuerKeySet,
    LicenseStore,
)


def test_active_token_verifies_all_bindings(
    token_factory: TokenFactory,
    verifier: EntitlementVerifier,
    device: DeviceIdentity,
) -> None:
    verified = verifier.verify(
        token_factory.token(),
        device=device,
        required_features=(CAMERA_LIVE_FEATURE,),
        now=NOW,
    )
    assert verified.status is EntitlementStatus.ACTIVE
    assert verified.claims.device_id == device.device_id
    assert verified.warning is None


def test_grace_is_explicit_and_does_not_extend_past_grace_until(
    token_factory: TokenFactory,
    verifier: EntitlementVerifier,
    device: DeviceIdentity,
) -> None:
    token = token_factory.token(claims=token_factory.claims(exp=NOW - 1, grace_until=NOW + 10))
    verified = verifier.verify(token, device=device, now=NOW)
    assert verified.status is EntitlementStatus.GRACE
    assert verified.warning is not None
    with pytest.raises(EntitlementError, match="expired"):
        verifier.verify(token, device=device, now=NOW + 11)


def test_default_clock_skew_applies_only_to_iat_and_nbf(
    token_factory: TokenFactory,
    verifier: EntitlementVerifier,
    device: DeviceIdentity,
) -> None:
    within_skew = token_factory.token(
        claims=token_factory.claims(iat=NOW + 300, nbf=NOW + 300, exp=NOW + 1_000)
    )
    assert verifier.verify(within_skew, device=device, now=NOW).status is EntitlementStatus.ACTIVE
    expired = token_factory.token(
        claims=token_factory.claims(
            iat=NOW - 1_000,
            nbf=NOW - 1_005,
            exp=NOW - 1,
            grace_until=NOW - 1,
        )
    )
    with pytest.raises(EntitlementError, match="expired"):
        verifier.verify(expired, device=device, now=NOW)


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"iss": "https://attacker.test"}, "issuer"),
        ({"aud": "another-product"}, "audience"),
        ({"exp": NOW + 31 * 24 * 60 * 60}, "30 days"),
        ({"grace_until": NOW + 1000 + 7 * 24 * 60 * 60 + 1}, "seven days"),
        ({"nbf": NOW + 301}, "not valid yet"),
        ({"iat": True}, "issued-at"),
        ({"entitlements": [CAMERA_LIVE_FEATURE, CAMERA_LIVE_FEATURE]}, "unique"),
    ],
)
def test_invalid_claims_are_rejected(
    token_factory: TokenFactory,
    verifier: EntitlementVerifier,
    device: DeviceIdentity,
    overrides: dict[str, object],
    message: str,
) -> None:
    token = token_factory.token(claims=token_factory.claims(**overrides))
    with pytest.raises(EntitlementError, match=message):
        verifier.verify(token, device=device, now=NOW)


def test_device_and_feature_binding_are_exact(
    token_factory: TokenFactory,
    verifier: EntitlementVerifier,
    device: DeviceIdentity,
) -> None:
    other_device = DeviceIdentity(Ed25519PrivateKey.generate())
    token = token_factory.token()
    with pytest.raises(EntitlementError, match="device ID"):
        verifier.verify(token, device=other_device, now=NOW)
    with pytest.raises(EntitlementError, match="missing required"):
        verifier.verify(token, device=device, required_features=("transport.hybrid",), now=NOW)


def test_tampered_signature_and_unknown_key_are_rejected(
    token_factory: TokenFactory,
    verifier: EntitlementVerifier,
    device: DeviceIdentity,
) -> None:
    token = token_factory.token()
    replacement = "A" if token[-1] != "A" else "B"
    with pytest.raises(EntitlementError, match="signature"):
        verifier.verify(token[:-1] + replacement, device=device, now=NOW)
    unknown = token_factory.token(
        header={"alg": "EdDSA", "kid": "unknown", "typ": "DMOFT-LICENSE", "v": 1}
    )
    with pytest.raises(EntitlementError, match="unknown issuer"):
        verifier.verify(unknown, device=device, now=NOW)


def test_noncanonical_and_unknown_json_fields_are_rejected(
    token_factory: TokenFactory,
    verifier: EntitlementVerifier,
    device: DeviceIdentity,
) -> None:
    header = {"v": 1, "typ": "DMOFT-LICENSE", "kid": KEY_ID, "alg": "EdDSA"}
    noncanonical_header = json.dumps(header, separators=(", ", ": ")).encode()
    payload = canonical_json_bytes(token_factory.claims())
    header_segment = b64url_encode(noncanonical_header)
    payload_segment = b64url_encode(payload)
    signature = b64url_encode(
        token_factory.issuer_private_key.sign(f"{header_segment}.{payload_segment}".encode())
    )
    with pytest.raises(EntitlementError, match="not canonical"):
        verifier.verify(f"{header_segment}.{payload_segment}.{signature}", device=device, now=NOW)
    claims = token_factory.claims(extra="forbidden")
    with pytest.raises(EntitlementError, match="fields"):
        verifier.verify(token_factory.token(claims=claims), device=device, now=NOW)


def test_keyset_file_is_strict_and_rotation_ready(
    tmp_path: Path,
    issuer_private_key: Ed25519PrivateKey,
) -> None:
    raw = issuer_private_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    path = tmp_path / "keys.json"
    path.write_bytes(
        canonical_json_bytes(
            {
                "keys": [{"alg": "EdDSA", "kid": KEY_ID, "public_key": b64url_encode(raw)}],
                "v": 1,
            }
        )
    )
    assert IssuerKeySet.from_file(path).resolve(KEY_ID) is not None


def test_license_store_is_bounded_and_round_trips(tmp_path: Path) -> None:
    store = LicenseStore(tmp_path)
    store.save("abc.def.ghi")
    assert store.load() == "abc.def.ghi"
    with pytest.raises(EntitlementError, match="whitespace"):
        store.save(" bad ")


def test_verifier_configuration_rejects_wrong_product_audience(
    issuer_private_key: Ed25519PrivateKey,
) -> None:
    with pytest.raises(ValueError, match="dmoft-pro"):
        EntitlementVerifier(
            IssuerKeySet({KEY_ID: issuer_private_key.public_key()}),
            expected_issuer=ISSUER,
            expected_audience="wrong",
        )


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"exp": NOW - 100}, "validity start"),
        ({"iat": NOW + 10, "exp": NOW + 5, "nbf": NOW - 10}, "validity start"),
        ({"iat": NOW + 301, "nbf": NOW + 301}, "future"),
        ({"grace_until": NOW + 999}, "grace"),
        ({"tier": "Bad Tier"}, "tier"),
        ({"sub": "bad\nsubject"}, "control"),
        ({"entitlements": ["optics.adaptive", "camera.live"]}, "sorted"),
        ({"device_key_sha256": "wrong"}, "public key"),
    ],
)
def test_additional_schema_and_time_invariants(
    token_factory: TokenFactory,
    verifier: EntitlementVerifier,
    device: DeviceIdentity,
    overrides: dict[str, object],
    message: str,
) -> None:
    token = token_factory.token(claims=token_factory.claims(**overrides))
    with pytest.raises(EntitlementError, match=message):
        verifier.verify(token, device=device, now=NOW)


def test_keyset_rejects_empty_duplicate_and_malformed_entries(tmp_path: Path) -> None:
    cases = [
        {"v": 1, "keys": []},
        {
            "v": 1,
            "keys": [
                {"alg": "EdDSA", "kid": "same", "public_key": b64url_encode(b"x" * 32)},
                {"alg": "EdDSA", "kid": "same", "public_key": b64url_encode(b"y" * 32)},
            ],
        },
        {
            "v": 1,
            "keys": [{"alg": "RSA", "kid": "bad", "public_key": "abc"}],
        },
        {
            "v": 1,
            "keys": [
                {
                    "alg": "EdDSA",
                    "kid": "invalid:key",
                    "public_key": b64url_encode(b"x" * 32),
                }
            ],
        },
    ]
    for index, document in enumerate(cases):
        path = tmp_path / f"bad-{index}.json"
        path.write_bytes(canonical_json_bytes(document))
        with pytest.raises(EntitlementError):
            IssuerKeySet.from_file(path)


def test_token_envelope_header_and_signature_sizes_are_strict(
    token_factory: TokenFactory,
    verifier: EntitlementVerifier,
    device: DeviceIdentity,
) -> None:
    bad_header = token_factory.token(
        header={"alg": "none", "kid": KEY_ID, "typ": "DMOFT-LICENSE", "v": 1}
    )
    with pytest.raises(EntitlementError, match="algorithm"):
        verifier.verify(bad_header, device=device, now=NOW)
    header_segment, payload_segment, _ = token_factory.token().split(".")
    with pytest.raises(EntitlementError, match="signature"):
        verifier.verify(f"{header_segment}.{payload_segment}.AA", device=device, now=NOW)
    with pytest.raises(EntitlementError, match="three segments"):
        verifier.verify("one.two", device=device, now=NOW)


def test_billing_generated_cross_language_fixture_verifies_in_client() -> None:
    fixture_path = (
        Path(__file__).resolve().parents[2] / "billing" / "tests" / "fixtures" / "license-v1.json"
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    device = DeviceIdentity(
        Ed25519PrivateKey.from_private_bytes(
            b64url_decode(fixture["device_private_key_seed"], maximum_bytes=32)
        )
    )
    keyset = IssuerKeySet.from_bytes(canonical_json_bytes(fixture["issuer_keyset"]))
    verified = EntitlementVerifier(
        keyset,
        expected_issuer="https://licenses.test",
    ).verify(
        fixture["token"],
        device=device,
        required_features=(CAMERA_LIVE_FEATURE,),
        now=2_000_000_000,
    )
    assert verified.claims.device_id == fixture["claims"]["device_id"]
    assert device.public_key_base64url == fixture["device_public_key"]
