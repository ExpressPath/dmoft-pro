"""Challenge-bound activation and refresh client for the Stripe entitlement service."""

from __future__ import annotations

import ipaddress
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

from dmoft_pro_client.device import DeviceIdentity
from dmoft_pro_client.encoding import canonical_json_bytes, strict_json_object
from dmoft_pro_client.entitlement import (
    CAMERA_LIVE_FEATURE,
    EntitlementStatus,
    EntitlementVerifier,
    LicenseStore,
    VerifiedEntitlement,
)
from dmoft_pro_client.errors import ActivationError, EntitlementError

_MAXIMUM_REQUEST_BYTES = 64 * 1024
_MAXIMUM_RESPONSE_BYTES = 64 * 1024
_MAXIMUM_CHALLENGE_LIFETIME_SECONDS = 15 * 60


class JsonTransport(Protocol):
    def get(self, path: str) -> dict[str, Any]: ...

    def post(self, path: str, payload: dict[str, object]) -> dict[str, Any]: ...


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> None:
        return None


class HttpJsonTransport:
    """Bounded HTTPS JSON transport with redirects disabled."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout_seconds: float = 10.0,
        bearer_token: str | None = None,
    ) -> None:
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname:
            raise ActivationError("activation service URL must be an absolute HTTP(S) URL")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ActivationError(
                "activation service URL must not contain credentials or query data"
            )
        if parsed.scheme == "http" and not _is_loopback_hostname(parsed.hostname):
            raise ActivationError("unencrypted activation HTTP is allowed only on loopback")
        if not 1.0 <= timeout_seconds <= 60.0:
            raise ValueError("activation timeout must be between 1 and 60 seconds")
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.bearer_token = _validate_bearer_token(bearer_token)
        self._opener = urllib.request.build_opener(_NoRedirectHandler())

    def get(self, path: str) -> dict[str, Any]:
        return self._request("GET", path, None)

    def post(self, path: str, payload: dict[str, object]) -> dict[str, Any]:
        return self._request("POST", path, payload)

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, object] | None,
    ) -> dict[str, Any]:
        if not path.startswith("/") or "?" in path or "#" in path:
            raise ActivationError("activation endpoint path is invalid")
        encoded = canonical_json_bytes(payload) if payload is not None else None
        if encoded is not None and len(encoded) > _MAXIMUM_REQUEST_BYTES:
            raise ActivationError("activation request exceeds its size limit")
        headers = {
            "Accept": "application/json",
            "User-Agent": "dmoft-pro-client/0.1",
        }
        if encoded is not None:
            headers["Content-Type"] = "application/json"
        if self.bearer_token is not None:
            headers["Authorization"] = f"Bearer {self.bearer_token}"
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=encoded,
            headers=headers,
            method=method,
        )
        try:
            with self._opener.open(request, timeout=self.timeout_seconds) as response:
                content_type = response.headers.get_content_type()
                if content_type != "application/json":
                    raise ActivationError("activation service returned a non-JSON response")
                body = response.read(_MAXIMUM_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as error:
            raise ActivationError(
                f"activation service rejected the request (HTTP {error.code})"
            ) from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise ActivationError("activation service could not be reached") from error
        if len(body) > _MAXIMUM_RESPONSE_BYTES:
            raise ActivationError("activation response exceeds its size limit")
        try:
            return strict_json_object(body, maximum_bytes=_MAXIMUM_RESPONSE_BYTES)
        except ValueError as error:
            raise ActivationError("activation service returned malformed JSON") from error


@dataclass(frozen=True, slots=True)
class LicenseServiceResult:
    entitlement: VerifiedEntitlement
    refresh_after: int


@dataclass(frozen=True, slots=True)
class CheckoutResult:
    checkout_session_id: str
    url: str


@dataclass(frozen=True, slots=True)
class DeviceRecord:
    device_id: str
    device_name: str
    status: str
    first_activated_at: str
    last_seen_at: str
    revoked_at: str | None


@dataclass(frozen=True, slots=True)
class RevokedDevice(DeviceRecord):
    offline_token_valid_until: str | None


@dataclass(frozen=True, slots=True)
class _Challenge:
    identifier: str
    value: str
    expires_at: int


class AccountServiceClient:
    """Authenticated account, Checkout, portal, and device-management operations."""

    def __init__(self, transport: JsonTransport) -> None:
        self.transport = transport

    def create_checkout(self, plan: str) -> CheckoutResult:
        if plan not in {"pro_monthly", "pro_annual"}:
            raise ActivationError("checkout plan is invalid")
        response = self.transport.post("/api/v1/checkout", {"plan": plan})
        if set(response) != {"checkout_session_id", "url"}:
            raise ActivationError("checkout response fields are invalid")
        session_id = _bounded_text(
            response.get("checkout_session_id"), "checkout session ID", maximum=256
        )
        url = _bounded_https_url(response.get("url"), "Checkout URL")
        return CheckoutResult(checkout_session_id=session_id, url=url)

    def create_portal_session(self) -> str:
        response = self.transport.post("/api/v1/portal", {})
        if set(response) != {"url"}:
            raise ActivationError("portal response fields are invalid")
        return _bounded_https_url(response.get("url"), "Customer Portal URL")

    def list_devices(self) -> tuple[DeviceRecord, ...]:
        response = self.transport.get("/api/v1/devices")
        if set(response) != {"devices"} or not isinstance(response.get("devices"), list):
            raise ActivationError("device-list response fields are invalid")
        return tuple(_parse_device_record(value) for value in response["devices"])

    def revoke_device(self, device_id: str) -> RevokedDevice:
        identifier = _bounded_device_id(device_id)
        response = self.transport.post(
            f"/api/v1/devices/{urllib.parse.quote(identifier, safe='')}/revoke",
            {},
        )
        expected = {
            "device_id",
            "device_name",
            "status",
            "first_activated_at",
            "last_seen_at",
            "revoked_at",
            "offline_token_valid_until",
        }
        if set(response) != expected:
            raise ActivationError("device-revocation response fields are invalid")
        parsed = _parse_device_record(
            {key: value for key, value in response.items() if key != "offline_token_valid_until"}
        )
        if parsed.status != "revoked":
            raise ActivationError("device-revocation response did not revoke the device")
        offline_until = _optional_bounded_text(
            response.get("offline_token_valid_until"),
            "offline-token deadline",
            maximum=64,
        )
        return RevokedDevice(
            device_id=parsed.device_id,
            device_name=parsed.device_name,
            status=parsed.status,
            first_activated_at=parsed.first_activated_at,
            last_seen_at=parsed.last_seen_at,
            revoked_at=parsed.revoked_at,
            offline_token_valid_until=offline_until,
        )


class ActivationServiceClient:
    """Perform one-use challenge activation and renewal with local verification."""

    def __init__(
        self,
        transport: JsonTransport,
        *,
        verifier: EntitlementVerifier,
        license_store: LicenseStore,
        device: DeviceIdentity,
    ) -> None:
        self.transport = transport
        self.verifier = verifier
        self.license_store = license_store
        self.device = device

    def activate(
        self,
        checkout_session_id: str,
        *,
        device_name: str,
        now: int | None = None,
    ) -> LicenseServiceResult:
        session_id = _bounded_text(checkout_session_id, "checkout session ID", maximum=256)
        display_name = _bounded_text(device_name, "device name", maximum=80)
        if display_name.strip() != display_name:
            raise ActivationError("device name must not have leading or trailing whitespace")
        challenge = self._request_challenge(
            "/api/v1/licenses/challenge",
            {
                "checkout_session_id": session_id,
                "device_public_key": self.device.public_key_base64url,
                "purpose": "activate",
            },
            now=now,
        )
        return self._exchange_token(
            "/api/v1/licenses/activate",
            {
                "challenge_id": challenge.identifier,
                "checkout_session_id": session_id,
                "device_name": display_name,
                "device_public_key": self.device.public_key_base64url,
                "signature": self.device.sign_challenge(challenge.value),
            },
            now=now,
        )

    def refresh(self, *, now: int | None = None) -> LicenseServiceResult:
        challenge = self._request_challenge(
            "/api/v1/licenses/challenge",
            {
                "device_id": self.device.device_id,
                "device_public_key": self.device.public_key_base64url,
                "purpose": "refresh",
            },
            now=now,
        )
        return self._exchange_token(
            "/api/v1/licenses/refresh",
            {
                "challenge_id": challenge.identifier,
                "device_id": self.device.device_id,
                "device_public_key": self.device.public_key_base64url,
                "signature": self.device.sign_challenge(challenge.value),
            },
            now=now,
        )

    def enroll(self, *, device_name: str, now: int | None = None) -> LicenseServiceResult:
        display_name = _bounded_text(device_name, "device name", maximum=80)
        if display_name.strip() != display_name:
            raise ActivationError("device name must not have leading or trailing whitespace")
        challenge = self._request_challenge(
            "/api/v1/devices/enrollment/challenge",
            {"device_public_key": self.device.public_key_base64url},
            now=now,
        )
        return self._exchange_token(
            "/api/v1/devices/enrollment/complete",
            {
                "challenge_id": challenge.identifier,
                "device_name": display_name,
                "device_public_key": self.device.public_key_base64url,
                "signature": self.device.sign_challenge(challenge.value),
            },
            now=now,
        )

    def _request_challenge(
        self,
        path: str,
        payload: dict[str, object],
        *,
        now: int | None,
    ) -> _Challenge:
        response = self.transport.post(path, payload)
        if set(response) != {"challenge_id", "challenge", "expires_at"}:
            raise ActivationError("challenge response fields are invalid")
        identifier = _bounded_text(response.get("challenge_id"), "challenge ID", maximum=256)
        value = _bounded_challenge(response.get("challenge"))
        expires_at = _nonnegative_integer(response.get("expires_at"), "challenge expiration")
        checked_at = int(time.time()) if now is None else _nonnegative_integer(now, "current time")
        if not checked_at < expires_at <= checked_at + _MAXIMUM_CHALLENGE_LIFETIME_SECONDS:
            raise ActivationError("challenge is expired or has an excessive lifetime")
        return _Challenge(identifier=identifier, value=value, expires_at=expires_at)

    def _exchange_token(
        self,
        path: str,
        payload: dict[str, object],
        *,
        now: int | None,
    ) -> LicenseServiceResult:
        response = self.transport.post(path, payload)
        if set(response) != {"license_token", "status", "refresh_after"}:
            raise ActivationError("license response fields are invalid")
        token = response.get("license_token")
        status = response.get("status")
        if not isinstance(token, str) or status not in {
            EntitlementStatus.ACTIVE.value,
            EntitlementStatus.GRACE.value,
        }:
            raise ActivationError("license response token or status is invalid")
        try:
            entitlement = self.verifier.verify(
                token,
                device=self.device,
                required_features=(CAMERA_LIVE_FEATURE,),
                now=now,
            )
        except EntitlementError as error:
            raise ActivationError("activation service returned an invalid license token") from error
        if status != entitlement.status.value:
            raise ActivationError("license response status does not match the signed token")
        refresh_after = _nonnegative_integer(response.get("refresh_after"), "refresh-after time")
        if refresh_after > entitlement.claims.grace_until:
            raise ActivationError("refresh-after time exceeds the signed grace deadline")
        self.license_store.save(token)
        return LicenseServiceResult(entitlement=entitlement, refresh_after=refresh_after)


def _is_loopback_hostname(hostname: str) -> bool:
    if hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _validate_bearer_token(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not 1 <= len(value) <= 32_768:
        raise ActivationError("OIDC access token is empty or oversized")
    if any(
        character.isspace() or ord(character) < 0x21 or ord(character) == 0x7F
        for character in value
    ):
        raise ActivationError("OIDC access token contains whitespace or control characters")
    try:
        value.encode("ascii")
    except UnicodeEncodeError as error:
        raise ActivationError("OIDC access token must contain ASCII characters") from error
    return value


def _bounded_https_url(value: object, field: str) -> str:
    text = _bounded_text(value, field, maximum=2_048)
    parsed = urllib.parse.urlsplit(text)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ActivationError(f"{field} must be an absolute HTTPS URL without credentials")
    return text


def _bounded_device_id(value: object) -> str:
    text = _bounded_text(value, "device ID", maximum=128)
    if not text.startswith("dmoft-device-v1-") or len(text) != len("dmoft-device-v1-") + 24:
        raise ActivationError("device ID has an invalid format")
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
    if any(character not in alphabet for character in text.removeprefix("dmoft-device-v1-")):
        raise ActivationError("device ID has an invalid format")
    return text


def _optional_bounded_text(value: object, field: str, *, maximum: int) -> str | None:
    if value is None:
        return None
    return _bounded_text(value, field, maximum=maximum)


def _parse_device_record(value: object) -> DeviceRecord:
    expected = {
        "device_id",
        "device_name",
        "status",
        "first_activated_at",
        "last_seen_at",
        "revoked_at",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise ActivationError("device-list entry fields are invalid")
    status = value.get("status")
    if status not in {"active", "revoked"}:
        raise ActivationError("device-list entry status is invalid")
    return DeviceRecord(
        device_id=_bounded_device_id(value.get("device_id")),
        device_name=_bounded_text(value.get("device_name"), "device name", maximum=80),
        status=status,
        first_activated_at=_bounded_text(
            value.get("first_activated_at"), "first activation time", maximum=64
        ),
        last_seen_at=_bounded_text(value.get("last_seen_at"), "last-seen time", maximum=64),
        revoked_at=_optional_bounded_text(value.get("revoked_at"), "revocation time", maximum=64),
    )


def _bounded_text(value: object, field: str, *, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ActivationError(f"{field} must be a non-empty bounded string")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        raise ActivationError(f"{field} contains control characters")
    return value


def _bounded_challenge(value: object) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 4096:
        raise ActivationError("challenge must be a non-empty bounded string")
    if any(
        (ord(character) < 0x20 and character != "\n") or ord(character) == 0x7F
        for character in value
    ):
        raise ActivationError("challenge contains unsupported control characters")
    return value


def _nonnegative_integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ActivationError(f"{field} must be a non-negative integer")
    return value
