from __future__ import annotations

import urllib.error
from pathlib import Path
from typing import Any

import pytest

from conftest import NOW, TokenFactory
from dmoft_pro_client.activation import (
    AccountServiceClient,
    ActivationServiceClient,
    HttpJsonTransport,
)
from dmoft_pro_client.device import DeviceIdentity
from dmoft_pro_client.encoding import b64url_decode
from dmoft_pro_client.entitlement import EntitlementVerifier, LicenseStore
from dmoft_pro_client.errors import ActivationError


class FakeTransport:
    def __init__(self, device: DeviceIdentity, token: str) -> None:
        self.device = device
        self.token = token
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.challenge = "DMOFT-LICENSE-CHALLENGE/1\npurpose=activate\nnonce=東京"

    def get(self, path: str) -> dict[str, Any]:
        raise AssertionError(f"unexpected GET {path}")

    def post(self, path: str, payload: dict[str, object]) -> dict[str, Any]:
        self.calls.append((path, payload))
        if path.endswith("/challenge"):
            return {
                "challenge": self.challenge,
                "challenge_id": "challenge-1",
                "expires_at": NOW + 60,
            }
        signature = b64url_decode(str(payload["signature"]), maximum_bytes=64)
        self.device.public_key.verify(signature, self.challenge.encode("utf-8"))
        return {"license_token": self.token, "refresh_after": NOW + 500, "status": "active"}


def test_activation_uses_exact_contract_and_stores_verified_token(
    tmp_path: Path,
    token_factory: TokenFactory,
    verifier: EntitlementVerifier,
    device: DeviceIdentity,
) -> None:
    token = token_factory.token()
    transport = FakeTransport(device, token)
    store = LicenseStore(tmp_path)
    client = ActivationServiceClient(
        transport,
        verifier=verifier,
        license_store=store,
        device=device,
    )
    result = client.activate("cs_test_opaque", device_name="Test phone", now=NOW)
    assert result.entitlement.claims.device_id == device.device_id
    assert store.load() == token
    assert transport.calls[0] == (
        "/api/v1/licenses/challenge",
        {
            "checkout_session_id": "cs_test_opaque",
            "device_public_key": device.public_key_base64url,
            "purpose": "activate",
        },
    )
    assert transport.calls[1][1]["device_name"] == "Test phone"


def test_refresh_uses_deterministic_device_binding_without_needing_valid_old_token(
    tmp_path: Path,
    token_factory: TokenFactory,
    verifier: EntitlementVerifier,
    device: DeviceIdentity,
) -> None:
    transport = FakeTransport(device, token_factory.token())
    client = ActivationServiceClient(
        transport,
        verifier=verifier,
        license_store=LicenseStore(tmp_path),
        device=device,
    )
    client.refresh(now=NOW)
    assert transport.calls[0][1] == {
        "device_id": device.device_id,
        "device_public_key": device.public_key_base64url,
        "purpose": "refresh",
    }
    assert transport.calls[1][0] == "/api/v1/licenses/refresh"


def test_additional_device_enrollment_uses_oidc_authenticated_routes(
    tmp_path: Path,
    token_factory: TokenFactory,
    verifier: EntitlementVerifier,
    device: DeviceIdentity,
) -> None:
    transport = FakeTransport(device, token_factory.token())
    client = ActivationServiceClient(
        transport,
        verifier=verifier,
        license_store=LicenseStore(tmp_path),
        device=device,
    )
    client.enroll(device_name="Second device", now=NOW)
    assert transport.calls[0] == (
        "/api/v1/devices/enrollment/challenge",
        {"device_public_key": device.public_key_base64url},
    )
    assert transport.calls[1][0] == "/api/v1/devices/enrollment/complete"


def test_invalid_server_token_is_never_stored(
    tmp_path: Path,
    verifier: EntitlementVerifier,
    device: DeviceIdentity,
) -> None:
    transport = FakeTransport(device, "bad.token.value")
    store = LicenseStore(tmp_path)
    client = ActivationServiceClient(
        transport,
        verifier=verifier,
        license_store=store,
        device=device,
    )
    with pytest.raises(ActivationError, match="invalid license"):
        client.activate("cs_test", device_name="Phone", now=NOW)
    assert not store.path.exists()


@pytest.mark.parametrize(
    "url",
    ["http://billing.example", "https://user:secret@billing.example", "billing.example"],
)
def test_http_transport_rejects_unsafe_service_urls(url: str) -> None:
    with pytest.raises(ActivationError):
        HttpJsonTransport(url)


def test_http_transport_allows_loopback_development() -> None:
    assert HttpJsonTransport("http://127.0.0.1:3000") is not None


class _Headers:
    def __init__(self, content_type: str) -> None:
        self.content_type = content_type

    def get_content_type(self) -> str:
        return self.content_type


class _Response:
    def __init__(self, body: bytes, content_type: str = "application/json") -> None:
        self.body = body
        self.headers = _Headers(content_type)

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self, maximum: int) -> bytes:
        return self.body[:maximum]


class _Opener:
    def __init__(self, response: _Response | Exception) -> None:
        self.response = response
        self.request: Any | None = None

    def open(self, request: object, timeout: float) -> _Response:
        assert timeout == 10.0
        self.request = request
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def test_http_transport_parses_bounded_strict_json() -> None:
    transport = HttpJsonTransport("http://localhost:3000", bearer_token="header.payload.signature")
    opener = _Opener(_Response(b'{"ok":true}'))
    transport._opener = opener  # type: ignore[assignment]
    assert transport.post("/test", {"request": "value"}) == {"ok": True}
    assert opener.request is not None
    assert opener.request.get_header("Authorization") == "Bearer header.payload.signature"
    transport._opener = _Opener(_Response(b"{}", "text/plain"))  # type: ignore[assignment]
    with pytest.raises(ActivationError, match="non-JSON"):
        transport.post("/test", {})


def test_http_transport_reports_service_and_payload_errors() -> None:
    transport = HttpJsonTransport("http://localhost:3000")
    transport._opener = _Opener(_Response(b"x" * 65_537))  # type: ignore[assignment]
    with pytest.raises(ActivationError, match="exceeds"):
        transport.post("/test", {})
    error = urllib.error.HTTPError("http://localhost", 403, "denied", {}, None)
    transport._opener = _Opener(error)  # type: ignore[assignment]
    with pytest.raises(ActivationError, match="HTTP 403"):
        transport.post("/test", {})
    with pytest.raises(ActivationError, match="path"):
        transport.post("relative", {})


class AccountTransport:
    def get(self, path: str) -> dict[str, Any]:
        assert path == "/api/v1/devices"
        return {
            "devices": [
                {
                    "device_id": "dmoft-device-v1-AAAAAAAAAAAAAAAAAAAAAAAA",
                    "device_name": "Laptop",
                    "status": "active",
                    "first_activated_at": "2026-08-09T00:00:00.000Z",
                    "last_seen_at": "2026-08-09T00:00:00.000Z",
                    "revoked_at": None,
                }
            ]
        }

    def post(self, path: str, payload: dict[str, object]) -> dict[str, Any]:
        if path == "/api/v1/checkout":
            assert payload == {"plan": "pro_monthly"}
            return {"checkout_session_id": "cs_test_1", "url": "https://checkout.stripe.test/1"}
        if path == "/api/v1/portal":
            return {"url": "https://billing.stripe.test/1"}
        assert path.endswith("/revoke")
        return {
            "device_id": "dmoft-device-v1-AAAAAAAAAAAAAAAAAAAAAAAA",
            "device_name": "Laptop",
            "status": "revoked",
            "first_activated_at": "2026-08-09T00:00:00.000Z",
            "last_seen_at": "2026-08-09T00:01:00.000Z",
            "revoked_at": "2026-08-09T00:01:00.000Z",
            "offline_token_valid_until": "2026-09-15T00:00:00.000Z",
        }


def test_account_checkout_portal_and_device_management_contracts() -> None:
    client = AccountServiceClient(AccountTransport())
    checkout = client.create_checkout("pro_monthly")
    assert checkout.checkout_session_id == "cs_test_1"
    assert client.create_portal_session().startswith("https://")
    assert client.list_devices()[0].status == "active"
    revoked = client.revoke_device("dmoft-device-v1-AAAAAAAAAAAAAAAAAAAAAAAA")
    assert revoked.status == "revoked"
    assert revoked.offline_token_valid_until is not None


class BadChallengeTransport:
    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response

    def post(self, path: str, payload: dict[str, object]) -> dict[str, Any]:
        return self.response


@pytest.mark.parametrize(
    ("response", "message"),
    [
        ({"challenge_id": "id", "challenge": "x"}, "fields"),
        (
            {"challenge_id": "id", "challenge": "x", "expires_at": NOW},
            "expired",
        ),
        (
            {"challenge_id": "id", "challenge": "x", "expires_at": NOW + 901},
            "excessive",
        ),
    ],
)
def test_challenge_response_is_strict(
    tmp_path: Path,
    verifier: EntitlementVerifier,
    device: DeviceIdentity,
    response: dict[str, Any],
    message: str,
) -> None:
    client = ActivationServiceClient(
        BadChallengeTransport(response),
        verifier=verifier,
        license_store=LicenseStore(tmp_path),
        device=device,
    )
    with pytest.raises(ActivationError, match=message):
        client.activate("cs_test", device_name="Phone", now=NOW)
