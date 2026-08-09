"""Strict offline verification for DMOFT Pro Ed25519 license tokens."""

from __future__ import annotations

import re
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from dmoft_pro_client.device import DeviceIdentity, default_state_directory
from dmoft_pro_client.encoding import (
    b64url_decode,
    canonical_json_bytes,
    strict_json_object,
)
from dmoft_pro_client.errors import EntitlementError, ProClientError
from dmoft_pro_client.storage import read_private_file, write_private_file

LICENSE_AUDIENCE = "dmoft-pro"
CAMERA_LIVE_FEATURE = "camera.live"
OPTICS_ADAPTIVE_FEATURE = "optics.adaptive"
TRANSPORT_HYBRID_FEATURE = "transport.hybrid"

_HEADER_FIELDS = frozenset({"alg", "kid", "typ", "v"})
_PAYLOAD_FIELDS = frozenset(
    {
        "v",
        "iss",
        "aud",
        "sub",
        "jti",
        "iat",
        "nbf",
        "exp",
        "grace_until",
        "tier",
        "entitlements",
        "device_id",
        "device_key_sha256",
        "subscription_id",
    }
)
_KEY_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_FEATURE_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
_TIER_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_MAXIMUM_TOKEN_CHARACTERS = 32_768
_MAXIMUM_HEADER_BYTES = 2_048
_MAXIMUM_PAYLOAD_BYTES = 16_384
_MAXIMUM_LICENSE_FILE_BYTES = 40_960
_MAXIMUM_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60
_MAXIMUM_GRACE_SECONDS = 7 * 24 * 60 * 60
_MAXIMUM_CLOCK_SKEW_SECONDS = 300
_DEFAULT_CLOCK_SKEW_SECONDS = 300


class EntitlementStatus(StrEnum):
    ACTIVE = "active"
    GRACE = "grace"


@dataclass(frozen=True, slots=True)
class EntitlementClaims:
    version: int
    issuer: str
    audience: str
    subject: str
    token_id: str
    issued_at: int
    not_before: int
    expires_at: int
    grace_until: int
    tier: str
    entitlements: tuple[str, ...]
    device_id: str
    device_key_sha256: str
    subscription_id: str


@dataclass(frozen=True, slots=True)
class VerifiedEntitlement:
    claims: EntitlementClaims
    status: EntitlementStatus
    key_id: str

    @property
    def warning(self) -> str | None:
        if self.status is EntitlementStatus.GRACE:
            return (
                "The subscription license is in its offline grace period; "
                f"refresh it before Unix time {self.claims.grace_until}."
            )
        return None

    def require(self, required_features: Iterable[str]) -> None:
        required = frozenset(required_features)
        missing = sorted(required.difference(self.claims.entitlements))
        if missing:
            raise EntitlementError(
                f"license is missing required entitlement(s): {', '.join(missing)}"
            )


class IssuerKeySet:
    """A rotation-friendly map from signed `kid` values to Ed25519 keys."""

    def __init__(self, keys: Mapping[str, Ed25519PublicKey]) -> None:
        if not keys:
            raise EntitlementError("issuer keyset must contain at least one key")
        self._keys = dict(keys)

    def resolve(self, key_id: str) -> Ed25519PublicKey:
        try:
            return self._keys[key_id]
        except KeyError as error:
            raise EntitlementError(f"license uses unknown issuer key ID: {key_id}") from error

    @classmethod
    def from_file(cls, path: Path) -> IssuerKeySet:
        try:
            raw = read_private_file(path, maximum_bytes=64 * 1024)
        except (OSError, ValueError, ProClientError) as error:
            raise EntitlementError(f"cannot load issuer keyset: {path}") from error
        try:
            return cls.from_bytes(raw)
        except EntitlementError as error:
            raise EntitlementError(f"cannot load issuer keyset: {path}") from error

    @classmethod
    def from_bytes(cls, raw: bytes) -> IssuerKeySet:
        """Parse a bounded strict keyset after transport trust is established."""

        try:
            document = strict_json_object(raw, maximum_bytes=64 * 1024)
        except ValueError as error:
            raise EntitlementError("issuer keyset is malformed") from error
        if set(document) != {"v", "keys"} or document.get("v") != 1:
            raise EntitlementError("issuer keyset has an unsupported schema")
        encoded_keys = document.get("keys")
        if not isinstance(encoded_keys, list) or not encoded_keys:
            raise EntitlementError("issuer keyset keys must be a non-empty array")
        parsed: dict[str, Ed25519PublicKey] = {}
        for encoded_key in encoded_keys:
            if not isinstance(encoded_key, dict) or set(encoded_key) != {
                "kid",
                "alg",
                "public_key",
            }:
                raise EntitlementError("issuer key entry has invalid fields")
            key_id = encoded_key.get("kid")
            algorithm = encoded_key.get("alg")
            public_key = encoded_key.get("public_key")
            if not isinstance(key_id, str) or _KEY_ID_PATTERN.fullmatch(key_id) is None:
                raise EntitlementError("issuer key ID is invalid")
            if key_id in parsed:
                raise EntitlementError(f"issuer key ID is duplicated: {key_id}")
            if algorithm != "EdDSA" or not isinstance(public_key, str):
                raise EntitlementError("issuer key must use EdDSA with a base64url public key")
            try:
                raw_key = b64url_decode(public_key, maximum_bytes=32)
                if len(raw_key) != 32:
                    raise ValueError("wrong Ed25519 key size")
                parsed[key_id] = Ed25519PublicKey.from_public_bytes(raw_key)
            except ValueError as error:
                raise EntitlementError(f"issuer key is malformed: {key_id}") from error
        return cls(parsed)


class EntitlementVerifier:
    """Verify authenticity, schema, time, device, audience, and feature binding."""

    def __init__(
        self,
        keyset: IssuerKeySet,
        *,
        expected_issuer: str,
        expected_audience: str = LICENSE_AUDIENCE,
        clock_skew_seconds: int = _DEFAULT_CLOCK_SKEW_SECONDS,
    ) -> None:
        if not expected_issuer or len(expected_issuer) > 256:
            raise ValueError("expected issuer must be a non-empty bounded string")
        if expected_audience != LICENSE_AUDIENCE:
            raise ValueError(f"expected audience must be {LICENSE_AUDIENCE!r}")
        if not 0 <= clock_skew_seconds <= _MAXIMUM_CLOCK_SKEW_SECONDS:
            raise ValueError("clock skew must be between zero and 300 seconds")
        self.keyset = keyset
        self.expected_issuer = expected_issuer
        self.expected_audience = expected_audience
        self.clock_skew_seconds = clock_skew_seconds

    def verify(
        self,
        token: str,
        *,
        device: DeviceIdentity,
        required_features: Iterable[str] = (),
        now: int | None = None,
    ) -> VerifiedEntitlement:
        if (
            not isinstance(token, str)
            or not token
            or len(token) > _MAXIMUM_TOKEN_CHARACTERS
            or token.strip() != token
        ):
            raise EntitlementError("license token is empty, oversized, or contains whitespace")
        parts = token.split(".")
        if len(parts) != 3:
            raise EntitlementError("license token must contain exactly three segments")
        header_segment, payload_segment, signature_segment = parts
        try:
            header_bytes = b64url_decode(header_segment, maximum_bytes=_MAXIMUM_HEADER_BYTES)
            header = strict_json_object(header_bytes, maximum_bytes=_MAXIMUM_HEADER_BYTES)
            signature = b64url_decode(signature_segment, maximum_bytes=64)
        except ValueError as error:
            raise EntitlementError("license protected header or signature is malformed") from error
        if canonical_json_bytes(header) != header_bytes:
            raise EntitlementError("license protected header is not canonical JSON")
        key_id = self._validate_header(header)
        if len(signature) != 64:
            raise EntitlementError("license signature has the wrong Ed25519 size")
        signing_input = f"{header_segment}.{payload_segment}".encode("ascii")
        try:
            self.keyset.resolve(key_id).verify(signature, signing_input)
        except InvalidSignature as error:
            raise EntitlementError("license signature is invalid") from error
        try:
            payload_bytes = b64url_decode(payload_segment, maximum_bytes=_MAXIMUM_PAYLOAD_BYTES)
            payload = strict_json_object(payload_bytes, maximum_bytes=_MAXIMUM_PAYLOAD_BYTES)
        except ValueError as error:
            raise EntitlementError("license payload is malformed") from error
        if canonical_json_bytes(payload) != payload_bytes:
            raise EntitlementError("license payload is not canonical JSON")
        claims = self._parse_claims(payload)
        checked_at = int(time.time()) if now is None else _strict_integer(now, "current time")
        status = self._validate_claims(claims, device=device, now=checked_at)
        verified = VerifiedEntitlement(claims=claims, status=status, key_id=key_id)
        verified.require(required_features)
        return verified

    @staticmethod
    def _validate_header(header: dict[str, Any]) -> str:
        if set(header) != _HEADER_FIELDS:
            raise EntitlementError("license protected header fields are invalid")
        if header.get("alg") != "EdDSA" or header.get("typ") != "DMOFT-LICENSE":
            raise EntitlementError("license protected header algorithm or type is invalid")
        if header.get("v") != 1 or isinstance(header.get("v"), bool):
            raise EntitlementError("license protected header version is unsupported")
        key_id = header.get("kid")
        if not isinstance(key_id, str) or _KEY_ID_PATTERN.fullmatch(key_id) is None:
            raise EntitlementError("license protected header key ID is invalid")
        return key_id

    def _parse_claims(self, payload: dict[str, Any]) -> EntitlementClaims:
        if set(payload) != _PAYLOAD_FIELDS:
            raise EntitlementError("license payload fields are invalid")
        if payload.get("v") != 1 or isinstance(payload.get("v"), bool):
            raise EntitlementError("license payload version is unsupported")
        issuer = _bounded_string(payload.get("iss"), "issuer", maximum=256)
        audience = _bounded_string(payload.get("aud"), "audience", maximum=64)
        subject = _bounded_string(payload.get("sub"), "subject", maximum=256)
        token_id = _bounded_string(payload.get("jti"), "token ID", maximum=256)
        tier = _bounded_string(payload.get("tier"), "tier", maximum=32)
        if _TIER_PATTERN.fullmatch(tier) is None:
            raise EntitlementError("license tier contains unsupported characters")
        device_id = _bounded_string(payload.get("device_id"), "device ID", maximum=128)
        device_digest = _bounded_string(
            payload.get("device_key_sha256"), "device key digest", maximum=64
        )
        subscription_id = _bounded_string(
            payload.get("subscription_id"), "subscription ID", maximum=256
        )
        encoded_features = payload.get("entitlements")
        if not isinstance(encoded_features, list) or not 1 <= len(encoded_features) <= 64:
            raise EntitlementError("license entitlements must be a non-empty bounded array")
        features: list[str] = []
        for value in encoded_features:
            if not isinstance(value, str) or _FEATURE_PATTERN.fullmatch(value) is None:
                raise EntitlementError("license contains an invalid entitlement ID")
            features.append(value)
        if len(set(features)) != len(features) or features != sorted(features):
            raise EntitlementError("license entitlements must be unique and sorted")
        return EntitlementClaims(
            version=1,
            issuer=issuer,
            audience=audience,
            subject=subject,
            token_id=token_id,
            issued_at=_strict_integer(payload.get("iat"), "issued-at time"),
            not_before=_strict_integer(payload.get("nbf"), "not-before time"),
            expires_at=_strict_integer(payload.get("exp"), "expiration time"),
            grace_until=_strict_integer(payload.get("grace_until"), "grace-until time"),
            tier=tier,
            entitlements=tuple(features),
            device_id=device_id,
            device_key_sha256=device_digest,
            subscription_id=subscription_id,
        )

    def _validate_claims(
        self,
        claims: EntitlementClaims,
        *,
        device: DeviceIdentity,
        now: int,
    ) -> EntitlementStatus:
        if claims.issuer != self.expected_issuer:
            raise EntitlementError("license issuer does not match this product")
        if claims.audience != self.expected_audience:
            raise EntitlementError("license audience does not match this product")
        if claims.device_id != device.device_id:
            raise EntitlementError("license is bound to another device ID")
        if claims.device_key_sha256 != device.public_key_sha256:
            raise EntitlementError("license is bound to another device public key")
        if claims.expires_at <= max(claims.not_before, claims.issued_at):
            raise EntitlementError("license expiration does not follow its validity start")
        if claims.expires_at - claims.issued_at > _MAXIMUM_TOKEN_LIFETIME_SECONDS:
            raise EntitlementError("license lifetime exceeds 30 days")
        if (
            not claims.expires_at
            <= claims.grace_until
            <= (claims.expires_at + _MAXIMUM_GRACE_SECONDS)
        ):
            raise EntitlementError("license grace interval exceeds seven days")
        if claims.issued_at > now + self.clock_skew_seconds:
            raise EntitlementError("license issued-at time is in the future")
        if claims.not_before > now + self.clock_skew_seconds:
            raise EntitlementError("license is not valid yet")
        if now <= claims.expires_at:
            return EntitlementStatus.ACTIVE
        if now <= claims.grace_until:
            return EntitlementStatus.GRACE
        raise EntitlementError("license and offline grace period have expired")


class LicenseStore:
    """Private local storage for one compact entitlement token."""

    def __init__(self, state_directory: Path | None = None) -> None:
        self.state_directory = state_directory or default_state_directory()
        self.path = self.state_directory / "license.token"

    def load(self) -> str:
        try:
            encoded = read_private_file(self.path, maximum_bytes=_MAXIMUM_LICENSE_FILE_BYTES)
            token = encoded.decode("ascii")
        except FileNotFoundError as error:
            raise EntitlementError(f"license token does not exist: {self.path}") from error
        except (OSError, UnicodeDecodeError, ProClientError) as error:
            raise EntitlementError(f"cannot load license token: {self.path}") from error
        if not token or token.strip() != token:
            raise EntitlementError("stored license token contains invalid whitespace")
        return token

    def save(self, token: str) -> None:
        if isinstance(token, str) and token.strip() != token:
            raise EntitlementError("refusing to store a license token with whitespace")
        if not token or len(token) > _MAXIMUM_TOKEN_CHARACTERS:
            raise EntitlementError("refusing to store an invalid license-token envelope")
        try:
            write_private_file(self.path, token.encode("ascii"), replace=True)
        except (OSError, UnicodeEncodeError, ProClientError) as error:
            raise EntitlementError(f"cannot save license token: {self.path}") from error


class AccessAuthorizer(Protocol):
    def authorize(self, required_features: Iterable[str]) -> VerifiedEntitlement: ...


class StoredEntitlementAuthorizer:
    """Re-read and revalidate local entitlement at every protected operation."""

    def __init__(
        self,
        store: LicenseStore,
        verifier: EntitlementVerifier,
        device: DeviceIdentity,
    ) -> None:
        self.store = store
        self.verifier = verifier
        self.device = device

    def authorize(self, required_features: Iterable[str]) -> VerifiedEntitlement:
        return self.verifier.verify(
            self.store.load(),
            device=self.device,
            required_features=required_features,
        )


def _strict_integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise EntitlementError(f"license {field} must be a non-negative integer")
    return value


def _bounded_string(value: Any, field: str, *, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise EntitlementError(f"license {field} must be a non-empty bounded string")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        raise EntitlementError(f"license {field} contains control characters")
    return value
