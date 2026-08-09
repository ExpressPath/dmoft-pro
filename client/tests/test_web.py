from __future__ import annotations

from collections.abc import Iterable

import cv2
import numpy as np
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from dmoft.transfer import TransferProgress
from fastapi.testclient import TestClient

from conftest import make_verified_entitlement
from dmoft_pro_client.device import DeviceIdentity
from dmoft_pro_client.entitlement import VerifiedEntitlement
from dmoft_pro_client.errors import LocalApiError
from dmoft_pro_client.web import WebCaptureLimits, create_app, jpeg_dimensions


class FakeAuthorizer:
    def __init__(self, entitlement: VerifiedEntitlement) -> None:
        self.entitlement = entitlement

    def authorize(self, required_features: Iterable[str]) -> VerifiedEntitlement:
        self.entitlement.require(required_features)
        return self.entitlement


class ImmediateReceiver:
    def __init__(self) -> None:
        self.accepted = False

    @property
    def can_recover_object(self) -> bool:
        return self.accepted

    def process_image(self, image: np.ndarray) -> TransferProgress:
        assert image.shape == (240, 320, 3)
        self.accepted = True
        return TransferProgress(1, 1, 1.0, True)

    def reconstruct(self) -> bytes:
        return b"encrypted-web-result"


class NeverCompleteReceiver(ImmediateReceiver):
    @property
    def can_recover_object(self) -> bool:
        return False


@pytest.fixture
def browser_client() -> TestClient:
    identity = DeviceIdentity(Ed25519PrivateKey.generate())
    app = create_app(
        FakeAuthorizer(make_verified_entitlement(identity)),
        bind_host="127.0.0.1",
        port=8765,
        receiver_factory=ImmediateReceiver,
    )
    return TestClient(
        app,
        base_url="http://127.0.0.1:8765",
        client=("127.0.0.1", 50_000),
    )


def _jpeg() -> bytes:
    ok, encoded = cv2.imencode(".jpg", np.zeros((240, 320, 3), dtype=np.uint8))
    assert ok
    return encoded.tobytes()


def _session_headers(client: TestClient) -> dict[str, str]:
    bootstrap = client.get("/api/v1/bootstrap")
    assert bootstrap.status_code == 200
    return {
        "Origin": "http://127.0.0.1:8765",
        "X-DMOFT-CSRF": bootstrap.json()["csrf_token"],
    }


def test_browser_capture_is_explicit_local_and_returns_only_encrypted_result(
    browser_client: TestClient,
) -> None:
    headers = _session_headers(browser_client)
    started = browser_client.post("/api/v1/session/start", headers=headers, json={})
    assert started.status_code == 200
    frame_headers = {**headers, "Content-Type": "image/jpeg"}
    decoded = browser_client.post("/api/v1/frame", headers=frame_headers, content=_jpeg())
    assert decoded.status_code == 200
    assert decoded.json()["completed"] is True
    result_headers = {"X-DMOFT-CSRF": headers["X-DMOFT-CSRF"]}
    result = browser_client.get("/api/v1/result", headers=result_headers)
    assert result.content == b"encrypted-web-result"
    assert result.headers["x-dmoft-content"] == "encrypted-container"


def test_mutation_rejects_missing_csrf_or_wrong_origin(browser_client: TestClient) -> None:
    missing = browser_client.post("/api/v1/session/start", json={})
    assert missing.status_code == 403
    headers = _session_headers(browser_client)
    headers["Origin"] = "https://attacker.example"
    wrong_origin = browser_client.post("/api/v1/session/start", headers=headers, json={})
    assert wrong_origin.status_code == 403


def test_remote_socket_client_is_rejected_even_with_loopback_host_header() -> None:
    identity = DeviceIdentity(Ed25519PrivateKey.generate())
    app = create_app(
        FakeAuthorizer(make_verified_entitlement(identity)),
        bind_host="127.0.0.1",
        port=8765,
    )
    remote = TestClient(
        app,
        base_url="http://127.0.0.1:8765",
        client=("203.0.113.8", 50_000),
    )
    assert remote.get("/api/v1/bootstrap").status_code == 403


def test_frame_requires_started_session_and_jpeg_content(browser_client: TestClient) -> None:
    headers = _session_headers(browser_client)
    response = browser_client.post(
        "/api/v1/frame",
        headers={**headers, "Content-Type": "image/jpeg"},
        content=_jpeg(),
    )
    assert response.status_code == 409
    browser_client.post("/api/v1/session/start", headers=headers, json={})
    response = browser_client.post(
        "/api/v1/frame",
        headers={**headers, "Content-Type": "application/octet-stream"},
        content=b"x",
    )
    assert response.status_code == 415


def test_stop_status_and_unavailable_result(browser_client: TestClient) -> None:
    headers = _session_headers(browser_client)
    browser_client.post("/api/v1/session/start", headers=headers, json={})
    stopped = browser_client.post("/api/v1/session/stop", headers=headers, json={})
    assert stopped.json()["state"] == "stopped"
    status = browser_client.get("/api/v1/status", headers={"X-DMOFT-CSRF": headers["X-DMOFT-CSRF"]})
    assert status.status_code == 200
    result = browser_client.get("/api/v1/result", headers={"X-DMOFT-CSRF": headers["X-DMOFT-CSRF"]})
    assert result.status_code == 409


def test_security_headers_and_no_remote_cors(browser_client: TestClient) -> None:
    response = browser_client.get("/")
    assert response.status_code == 200
    assert "default-src 'self'" in response.headers["content-security-policy"]
    assert "access-control-allow-origin" not in response.headers
    assert "getUserMedia" in browser_client.get("/app.js").text


def test_jpeg_dimensions_and_malformed_input() -> None:
    assert jpeg_dimensions(_jpeg()) == (320, 240)
    with pytest.raises(LocalApiError, match="not a JPEG"):
        jpeg_dimensions(b"not-jpeg")


def test_dimension_limit_is_checked_before_receiver() -> None:
    identity = DeviceIdentity(Ed25519PrivateKey.generate())
    app = create_app(
        FakeAuthorizer(make_verified_entitlement(identity)),
        bind_host="127.0.0.1",
        port=8765,
        limits=WebCaptureLimits(
            maximum_width=320,
            maximum_height=240,
            maximum_pixels=76_800,
        ),
        receiver_factory=ImmediateReceiver,
    )
    client = TestClient(
        app,
        base_url="http://127.0.0.1:8765",
        client=("127.0.0.1", 50_000),
    )
    headers = _session_headers(client)
    client.post("/api/v1/session/start", headers=headers, json={})
    ok, encoded = cv2.imencode(".jpg", np.zeros((480, 640, 3), dtype=np.uint8))
    assert ok
    response = client.post(
        "/api/v1/frame",
        headers={**headers, "Content-Type": "image/jpeg"},
        content=encoded.tobytes(),
    )
    assert response.status_code == 413


def test_malformed_jpeg_and_rate_limit_are_rejected() -> None:
    identity = DeviceIdentity(Ed25519PrivateKey.generate())
    app = create_app(
        FakeAuthorizer(make_verified_entitlement(identity)),
        bind_host="127.0.0.1",
        port=8765,
        receiver_factory=NeverCompleteReceiver,
        monotonic=lambda: 100.0,
    )
    client = TestClient(
        app,
        base_url="http://127.0.0.1:8765",
        client=("127.0.0.1", 50_000),
    )
    headers = _session_headers(client)
    client.post("/api/v1/session/start", headers=headers, json={})
    malformed = client.post(
        "/api/v1/frame",
        headers={**headers, "Content-Type": "image/jpeg"},
        content=b"not-jpeg",
    )
    assert malformed.status_code == 413
    limited = client.post(
        "/api/v1/frame",
        headers={**headers, "Content-Type": "image/jpeg"},
        content=_jpeg(),
    )
    assert limited.status_code == 429


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.4", "example.com", ""])
def test_non_loopback_bind_is_refused(host: str) -> None:
    identity = DeviceIdentity(Ed25519PrivateKey.generate())
    with pytest.raises(LocalApiError, match="loopback"):
        create_app(FakeAuthorizer(make_verified_entitlement(identity)), bind_host=host)


def test_browser_session_enforces_total_duration_and_frame_limits() -> None:
    identity = DeviceIdentity(Ed25519PrivateKey.generate())
    current_time = [100.0]
    app = create_app(
        FakeAuthorizer(make_verified_entitlement(identity)),
        bind_host="127.0.0.1",
        port=8765,
        limits=WebCaptureLimits(maximum_session_seconds=1, maximum_frames=1),
        receiver_factory=NeverCompleteReceiver,
        monotonic=lambda: current_time[0],
    )
    client = TestClient(
        app,
        base_url="http://127.0.0.1:8765",
        client=("127.0.0.1", 50_000),
    )
    headers = _session_headers(client)
    client.post("/api/v1/session/start", headers=headers, json={})
    first = client.post(
        "/api/v1/frame",
        headers={**headers, "Content-Type": "image/jpeg"},
        content=_jpeg(),
    )
    assert first.status_code == 200
    current_time[0] += 0.1
    limited = client.post(
        "/api/v1/frame",
        headers={**headers, "Content-Type": "image/jpeg"},
        content=_jpeg(),
    )
    assert limited.status_code == 409
    assert "frame limit" in limited.json()["error"]

    client.post("/api/v1/session/start", headers=headers, json={})
    current_time[0] += 1.0
    expired = client.post(
        "/api/v1/frame",
        headers={**headers, "Content-Type": "image/jpeg"},
        content=_jpeg(),
    )
    assert expired.status_code == 409
    assert "duration limit" in expired.json()["error"]
