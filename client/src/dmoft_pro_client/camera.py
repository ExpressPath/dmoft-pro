"""Explicit, entitlement-gated OpenCV camera capture for Community DMOFT."""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, cast

import cv2
import numpy as np
from dmoft.errors import DmoftError
from dmoft.transfer import DynamicTransferReceiver, TransferProgress
from numpy.typing import NDArray

from dmoft_pro_client.entitlement import (
    CAMERA_LIVE_FEATURE,
    OPTICS_ADAPTIVE_FEATURE,
    AccessAuthorizer,
    VerifiedEntitlement,
)
from dmoft_pro_client.errors import CameraError

Image = NDArray[np.uint8]


class CaptureDevice(Protocol):
    def isOpened(self) -> bool: ...

    def read(self) -> tuple[bool, Image | None]: ...

    def set(self, property_id: int, value: float) -> bool: ...

    def release(self) -> None: ...


class FrameReceiver(Protocol):
    @property
    def can_recover_object(self) -> bool: ...

    def process_image(self, image: Image) -> TransferProgress: ...

    def reconstruct(self) -> bytes: ...


class CameraScannerState(StrEnum):
    STOPPED = "stopped"
    RUNNING = "running"


@dataclass(frozen=True, slots=True)
class CameraLimits:
    maximum_width: int = 1920
    maximum_height: int = 1080
    maximum_pixels: int = 2_073_600
    target_fps: float = 10.0
    maximum_fps: float = 15.0
    maximum_scan_seconds: float = 900.0
    maximum_frames: int = 100_000
    consecutive_read_failures: int = 20

    def __post_init__(self) -> None:
        if not 320 <= self.maximum_width <= 4096:
            raise ValueError("maximum camera width must be between 320 and 4096")
        if not 240 <= self.maximum_height <= 2160:
            raise ValueError("maximum camera height must be between 240 and 2160")
        if not 76_800 <= self.maximum_pixels <= 8_847_360:
            raise ValueError("maximum camera pixels are outside the supported range")
        if not 1.0 <= self.target_fps <= self.maximum_fps <= 15.0:
            raise ValueError("camera FPS must satisfy 1 <= target <= maximum <= 15")
        if not 1.0 <= self.maximum_scan_seconds <= 3_600.0:
            raise ValueError("maximum scan duration must be between 1 and 3600 seconds")
        if not 1 <= self.maximum_frames <= 1_000_000:
            raise ValueError("maximum frame count is outside the supported range")
        if not 1 <= self.consecutive_read_failures <= 120:
            raise ValueError("consecutive read-failure limit is outside the supported range")


@dataclass(frozen=True, slots=True)
class CameraScanEvent:
    frame_number: int
    accepted: bool
    accepted_source_symbols: int
    total_source_symbols: int
    independent_progress: float
    message: str


@dataclass(frozen=True, slots=True)
class CameraScanResult:
    encrypted_container: bytes | None
    captured_frames: int
    accepted_frames: int
    rejected_frames: int
    elapsed_seconds: float
    completed: bool
    entitlement: VerifiedEntitlement


class AdaptiveCaptureController:
    """Conservatively adapt processing FPS from recent decoder acceptance."""

    def __init__(self, *, initial_fps: float, minimum_fps: float = 4.0, maximum_fps: float) -> None:
        if not 1 <= minimum_fps <= initial_fps <= maximum_fps <= 15:
            raise ValueError("adaptive FPS bounds are invalid")
        self.minimum_fps = minimum_fps
        self.maximum_fps = maximum_fps
        self.current_fps = initial_fps
        self._window: deque[bool] = deque(maxlen=20)

    def observe(self, *, accepted: bool) -> float:
        self._window.append(accepted)
        if len(self._window) < 20:
            return self.current_fps
        acceptance_rate = sum(self._window) / len(self._window)
        if acceptance_rate < 0.70:
            self.current_fps = max(self.minimum_fps, self.current_fps - 2.0)
        elif acceptance_rate > 0.95:
            self.current_fps = min(self.maximum_fps, self.current_fps + 1.0)
        self._window.clear()
        return self.current_fps


class CameraScanner:
    """Feed bounded camera frames into the unchanged Community stream decoder."""

    def __init__(
        self,
        authorizer: AccessAuthorizer,
        *,
        receiver_factory: Callable[[], FrameReceiver] | None = None,
        limits: CameraLimits | None = None,
        capture_factory: Callable[[int], CaptureDevice] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.authorizer = authorizer
        self.receiver_factory = receiver_factory or DynamicTransferReceiver
        self.receiver: FrameReceiver | None = None
        self.limits = limits if limits is not None else CameraLimits()
        self.capture_factory = capture_factory or _open_cv_capture
        self.monotonic = monotonic
        self.sleep = sleep
        self._capture: CaptureDevice | None = None
        self._state = CameraScannerState.STOPPED
        self._entitlement: VerifiedEntitlement | None = None
        self._adaptive: AdaptiveCaptureController | None = None

    @property
    def state(self) -> CameraScannerState:
        return self._state

    def start(self, camera_index: int = 0, *, adaptive: bool = False) -> VerifiedEntitlement:
        """Explicitly acquire the camera after checking the required entitlement."""

        if self._state is CameraScannerState.RUNNING:
            raise CameraError("camera scanner is already running")
        if isinstance(camera_index, bool) or not 0 <= camera_index <= 32:
            raise CameraError("camera index must be between 0 and 32")
        required = [CAMERA_LIVE_FEATURE]
        if adaptive:
            required.append(OPTICS_ADAPTIVE_FEATURE)
        entitlement = self.authorizer.authorize(required)
        receiver = self.receiver_factory()
        try:
            capture = self.capture_factory(camera_index)
        except Exception as error:
            raise CameraError(f"camera {camera_index} could not be opened") from error
        try:
            opened = capture.isOpened()
        except Exception as error:
            with suppress(Exception):
                capture.release()
            raise CameraError(f"camera {camera_index} could not be queried") from error
        if not opened:
            capture.release()
            raise CameraError(f"camera {camera_index} is unavailable or permission was denied")
        try:
            capture.set(cv2.CAP_PROP_FRAME_WIDTH, float(self.limits.maximum_width))
            capture.set(cv2.CAP_PROP_FRAME_HEIGHT, float(self.limits.maximum_height))
            capture.set(cv2.CAP_PROP_FPS, self.limits.target_fps)
        except Exception as error:
            with suppress(Exception):
                capture.release()
            raise CameraError("camera constraints could not be configured") from error
        self._capture = capture
        self.receiver = receiver
        self._entitlement = entitlement
        self._adaptive = (
            AdaptiveCaptureController(
                initial_fps=self.limits.target_fps,
                maximum_fps=self.limits.maximum_fps,
            )
            if adaptive
            else None
        )
        self._state = CameraScannerState.RUNNING
        return entitlement

    def stop(self) -> None:
        """Idempotently release the camera."""

        capture, self._capture = self._capture, None
        self._state = CameraScannerState.STOPPED
        if capture is not None:
            with suppress(Exception):
                capture.release()

    def scan(
        self,
        *,
        on_event: Callable[[CameraScanEvent], None] | None = None,
        maximum_frames: int | None = None,
        maximum_seconds: float | None = None,
    ) -> CameraScanResult:
        if self._state is not CameraScannerState.RUNNING or self._capture is None:
            raise CameraError("camera scanner must be explicitly started before scanning")
        entitlement = self._entitlement
        if entitlement is None:
            raise CameraError("camera entitlement was not established")
        receiver = self.receiver
        if receiver is None:
            raise CameraError("camera frame receiver was not established")
        frame_limit = self.limits.maximum_frames if maximum_frames is None else maximum_frames
        duration_limit = (
            self.limits.maximum_scan_seconds if maximum_seconds is None else maximum_seconds
        )
        if not 1 <= frame_limit <= self.limits.maximum_frames:
            raise CameraError("requested frame limit exceeds the configured resource limit")
        if not 0.1 <= duration_limit <= self.limits.maximum_scan_seconds:
            raise CameraError("requested duration exceeds the configured resource limit")

        started_at = self.monotonic()
        next_frame_at = started_at
        next_authorization_at = started_at + 30.0
        captured = accepted = rejected = consecutive_failures = 0
        reconstructed: bytes | None = None
        try:
            while captured < frame_limit and self.monotonic() - started_at < duration_limit:
                if self.monotonic() >= next_authorization_at:
                    required = [CAMERA_LIVE_FEATURE]
                    if self._adaptive is not None:
                        required.append(OPTICS_ADAPTIVE_FEATURE)
                    entitlement = self.authorizer.authorize(required)
                    next_authorization_at = self.monotonic() + 30.0
                current_fps = (
                    self._adaptive.current_fps
                    if self._adaptive is not None
                    else self.limits.target_fps
                )
                wait_seconds = next_frame_at - self.monotonic()
                if wait_seconds > 0:
                    self.sleep(wait_seconds)
                next_frame_at = max(next_frame_at + (1.0 / current_fps), self.monotonic())
                try:
                    ok, frame = self._capture.read()
                except Exception as error:
                    raise CameraError("camera backend failed while reading a frame") from error
                if not ok or frame is None:
                    consecutive_failures += 1
                    if consecutive_failures >= self.limits.consecutive_read_failures:
                        raise CameraError("camera repeatedly failed to return a frame")
                    self.sleep(min(0.05 * consecutive_failures, 0.5))
                    continue
                consecutive_failures = 0
                captured += 1
                rejection_message = _validate_camera_frame(frame, self.limits)
                if rejection_message is not None:
                    rejected += 1
                    self._notify(on_event, captured, None, rejection_message)
                    if self._adaptive is not None:
                        self._adaptive.observe(accepted=False)
                    continue
                try:
                    progress = receiver.process_image(frame)
                except (DmoftError, ValueError, cv2.error) as error:
                    rejected += 1
                    self._notify(on_event, captured, None, str(error)[:240])
                    if self._adaptive is not None:
                        self._adaptive.observe(accepted=False)
                    continue
                accepted += 1
                self._notify(on_event, captured, progress, "frame accepted")
                if self._adaptive is not None:
                    self._adaptive.observe(accepted=True)
                if receiver.can_recover_object:
                    reconstructed = receiver.reconstruct()
                    break
        finally:
            self.stop()
        elapsed = max(0.0, self.monotonic() - started_at)
        return CameraScanResult(
            encrypted_container=reconstructed,
            captured_frames=captured,
            accepted_frames=accepted,
            rejected_frames=rejected,
            elapsed_seconds=elapsed,
            completed=reconstructed is not None,
            entitlement=entitlement,
        )

    @staticmethod
    def _notify(
        callback: Callable[[CameraScanEvent], None] | None,
        frame_number: int,
        progress: TransferProgress | None,
        message: str,
    ) -> None:
        if callback is None:
            return
        callback(
            CameraScanEvent(
                frame_number=frame_number,
                accepted=progress is not None,
                accepted_source_symbols=(progress.accepted_source_symbols if progress else 0),
                total_source_symbols=(progress.total_source_symbols if progress else 0),
                independent_progress=(progress.independent_progress if progress else 0.0),
                message=message,
            )
        )


def _open_cv_capture(camera_index: int) -> CaptureDevice:
    return cast(CaptureDevice, cv2.VideoCapture(camera_index))


def _validate_camera_frame(frame: Image, limits: CameraLimits) -> str | None:
    if not isinstance(frame, np.ndarray) or frame.dtype != np.uint8:
        return "camera frame is not an unsigned 8-bit image"
    if frame.ndim != 3 or frame.shape[2] not in (3, 4):
        return "camera frame must contain BGR or BGRA channels"
    height, width = frame.shape[:2]
    if (
        width < 64
        or height < 64
        or width > limits.maximum_width
        or height > limits.maximum_height
        or width * height > limits.maximum_pixels
    ):
        return "camera frame dimensions exceed the configured limits"
    return None
