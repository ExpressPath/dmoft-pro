from __future__ import annotations

from collections.abc import Iterable

import numpy as np
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from dmoft.transfer import TransferProgress

from conftest import make_verified_entitlement
from dmoft_pro_client.camera import (
    AdaptiveCaptureController,
    CameraError,
    CameraLimits,
    CameraScanner,
    CameraScannerState,
)
from dmoft_pro_client.device import DeviceIdentity
from dmoft_pro_client.entitlement import (
    CAMERA_LIVE_FEATURE,
    OPTICS_ADAPTIVE_FEATURE,
    VerifiedEntitlement,
)


class FakeAuthorizer:
    def __init__(self, entitlement: VerifiedEntitlement) -> None:
        self.entitlement = entitlement
        self.calls: list[tuple[str, ...]] = []

    def authorize(self, required_features: Iterable[str]) -> VerifiedEntitlement:
        required = tuple(required_features)
        self.calls.append(required)
        self.entitlement.require(required)
        return self.entitlement


class FakeCapture:
    def __init__(self, frames: list[np.ndarray | None], *, opened: bool = True) -> None:
        self.frames = frames
        self.opened = opened
        self.released = False
        self.properties: list[tuple[int, float]] = []

    def isOpened(self) -> bool:
        return self.opened

    def read(self) -> tuple[bool, np.ndarray | None]:
        if not self.frames:
            return False, None
        frame = self.frames.pop(0)
        return frame is not None, frame

    def set(self, property_id: int, value: float) -> bool:
        self.properties.append((property_id, value))
        return True

    def release(self) -> None:
        self.released = True


class FakeReceiver:
    def __init__(self, *, complete_after: int = 1) -> None:
        self.complete_after = complete_after
        self.accepted = 0

    @property
    def can_recover_object(self) -> bool:
        return self.accepted >= self.complete_after

    def process_image(self, image: np.ndarray) -> TransferProgress:
        assert image.dtype == np.uint8
        self.accepted += 1
        return TransferProgress(
            accepted_source_symbols=self.accepted,
            total_source_symbols=self.complete_after,
            independent_progress=min(1.0, self.accepted / self.complete_after),
            object_recoverable=self.can_recover_object,
        )

    def reconstruct(self) -> bytes:
        return b"encrypted-container"


class FakeClock:
    def __init__(self) -> None:
        self.value = 0.0

    def monotonic(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.value += max(0.0, seconds)


@pytest.fixture
def entitlement() -> VerifiedEntitlement:
    return make_verified_entitlement(DeviceIdentity(Ed25519PrivateKey.generate()))


def test_camera_must_be_explicitly_started(entitlement: VerifiedEntitlement) -> None:
    scanner = CameraScanner(FakeAuthorizer(entitlement), receiver_factory=FakeReceiver)
    with pytest.raises(CameraError, match="explicitly started"):
        scanner.scan(maximum_frames=1)


def test_camera_feeds_community_receiver_and_always_releases(
    entitlement: VerifiedEntitlement,
) -> None:
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    capture = FakeCapture([frame, frame.copy()])
    clock = FakeClock()
    authorizer = FakeAuthorizer(entitlement)
    events = []
    scanner = CameraScanner(
        authorizer,
        receiver_factory=lambda: FakeReceiver(complete_after=2),
        capture_factory=lambda index: capture,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
    )
    scanner.start(0)
    result = scanner.scan(on_event=events.append, maximum_frames=2)
    assert result.encrypted_container == b"encrypted-container"
    assert result.accepted_frames == 2
    assert capture.released
    assert scanner.state is CameraScannerState.STOPPED
    assert authorizer.calls == [(CAMERA_LIVE_FEATURE,)]
    assert len(events) == 2


def test_adaptive_mode_requires_separate_feature(entitlement: VerifiedEntitlement) -> None:
    capture = FakeCapture([np.zeros((240, 320, 3), dtype=np.uint8)])
    authorizer = FakeAuthorizer(entitlement)
    scanner = CameraScanner(
        authorizer,
        receiver_factory=FakeReceiver,
        capture_factory=lambda index: capture,
    )
    scanner.start(adaptive=True)
    scanner.stop()
    assert set(authorizer.calls[0]) == {CAMERA_LIVE_FEATURE, OPTICS_ADAPTIVE_FEATURE}


def test_unavailable_camera_is_reported_and_released(entitlement: VerifiedEntitlement) -> None:
    capture = FakeCapture([], opened=False)
    scanner = CameraScanner(
        FakeAuthorizer(entitlement),
        receiver_factory=FakeReceiver,
        capture_factory=lambda index: capture,
    )
    with pytest.raises(CameraError, match="unavailable"):
        scanner.start()
    assert capture.released


def test_oversized_frames_are_rejected_without_decoder_use(
    entitlement: VerifiedEntitlement,
) -> None:
    capture = FakeCapture([np.zeros((600, 800, 3), dtype=np.uint8)])
    receiver = FakeReceiver()
    clock = FakeClock()
    scanner = CameraScanner(
        FakeAuthorizer(entitlement),
        receiver_factory=lambda: receiver,
        limits=CameraLimits(maximum_width=640, maximum_height=480, maximum_pixels=307_200),
        capture_factory=lambda index: capture,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
    )
    scanner.start()
    result = scanner.scan(maximum_frames=1)
    assert not result.completed
    assert result.rejected_frames == 1
    assert receiver.accepted == 0


def test_repeated_read_failures_stop_safely(entitlement: VerifiedEntitlement) -> None:
    capture = FakeCapture([None, None])
    clock = FakeClock()
    scanner = CameraScanner(
        FakeAuthorizer(entitlement),
        receiver_factory=FakeReceiver,
        limits=CameraLimits(consecutive_read_failures=2),
        capture_factory=lambda index: capture,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
    )
    scanner.start()
    with pytest.raises(CameraError, match="repeatedly failed"):
        scanner.scan(maximum_seconds=1)
    assert capture.released


def test_adaptive_controller_reduces_and_recovers_fps() -> None:
    controller = AdaptiveCaptureController(initial_fps=10, minimum_fps=4, maximum_fps=12)
    for _ in range(20):
        controller.observe(accepted=False)
    assert controller.current_fps == 8
    for _ in range(20):
        controller.observe(accepted=True)
    assert controller.current_fps == 9


def test_each_camera_start_uses_a_fresh_receiver(entitlement: VerifiedEntitlement) -> None:
    captures = [
        FakeCapture([np.zeros((240, 320, 3), dtype=np.uint8)]),
        FakeCapture([np.zeros((240, 320, 3), dtype=np.uint8)]),
    ]
    receivers: list[FakeReceiver] = []

    def make_receiver() -> FakeReceiver:
        receiver = FakeReceiver()
        receivers.append(receiver)
        return receiver

    scanner = CameraScanner(
        FakeAuthorizer(entitlement),
        receiver_factory=make_receiver,
        capture_factory=lambda index: captures.pop(0),
    )
    scanner.start()
    assert scanner.scan(maximum_frames=1).completed
    scanner.start()
    assert scanner.scan(maximum_frames=1).completed
    assert len(receivers) == 2
    assert receivers[0] is not receivers[1]
