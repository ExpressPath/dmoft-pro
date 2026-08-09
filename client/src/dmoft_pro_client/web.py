"""Loopback-only FastAPI capture service for browser getUserMedia frames."""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import cv2
import numpy as np
from dmoft.errors import DmoftError
from dmoft.transfer import DynamicTransferReceiver, TransferProgress
from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response

from dmoft_pro_client.camera import FrameReceiver, Image
from dmoft_pro_client.entitlement import (
    CAMERA_LIVE_FEATURE,
    AccessAuthorizer,
    VerifiedEntitlement,
)
from dmoft_pro_client.errors import EntitlementError, LocalApiError

_STATIC_DIRECTORY = Path(__file__).parent / "static"
_JPEG_START_OF_FRAME_MARKERS = frozenset(
    {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
)


@dataclass(frozen=True, slots=True)
class WebCaptureLimits:
    maximum_jpeg_bytes: int = 2 * 1024 * 1024
    maximum_width: int = 1920
    maximum_height: int = 1080
    maximum_pixels: int = 2_073_600
    maximum_fps: float = 15.0
    maximum_session_seconds: float = 900.0
    maximum_frames: int = 100_000

    def __post_init__(self) -> None:
        if not 64 * 1024 <= self.maximum_jpeg_bytes <= 8 * 1024 * 1024:
            raise ValueError("JPEG byte limit must be between 64 KiB and 8 MiB")
        if not 320 <= self.maximum_width <= 4096:
            raise ValueError("maximum browser-frame width is invalid")
        if not 240 <= self.maximum_height <= 2160:
            raise ValueError("maximum browser-frame height is invalid")
        if not 76_800 <= self.maximum_pixels <= 8_847_360:
            raise ValueError("maximum browser-frame pixel count is invalid")
        if not 1 <= self.maximum_fps <= 15:
            raise ValueError("maximum browser capture FPS must be between 1 and 15")
        if not 1 <= self.maximum_session_seconds <= 3_600:
            raise ValueError("maximum browser session duration must be between 1 and 3600 seconds")
        if not 1 <= self.maximum_frames <= 1_000_000:
            raise ValueError("maximum browser frame count is outside the supported range")


@dataclass(slots=True)
class _WebSession:
    receiver: FrameReceiver
    scanning: bool = False
    recovered: bytes | None = None
    accepted_frames: int = 0
    rejected_frames: int = 0
    last_frame_at: float | None = None
    last_progress: float = 0.0
    total_source_symbols: int = 0
    accepted_source_symbols: int = 0
    captured_frames: int = 0
    started_at: float | None = None


def create_app(
    authorizer: AccessAuthorizer,
    *,
    bind_host: str = "127.0.0.1",
    port: int = 8765,
    limits: WebCaptureLimits | None = None,
    receiver_factory: Callable[[], FrameReceiver] | None = None,
    monotonic: Callable[[], float] = time.monotonic,
) -> FastAPI:
    """Build the local app; it still must be served on the validated bind address."""

    normalized_host = validate_loopback_bind(bind_host)
    active_limits = limits if limits is not None else WebCaptureLimits()
    if isinstance(port, bool) or not 1024 <= port <= 65535:
        raise LocalApiError("local API port must be between 1024 and 65535")
    make_receiver = receiver_factory or DynamicTransferReceiver
    csrf_token = secrets.token_urlsafe(32)
    allowed_origins = _allowed_origins(normalized_host, port)
    session = _WebSession(receiver=make_receiver())
    lock = asyncio.Lock()
    app = FastAPI(
        title="DMOFT Pro Local Camera",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.exception_handler(LocalApiError)
    async def local_api_error_handler(request: Request, error: LocalApiError) -> JSONResponse:
        del request
        return _error(403, str(error))

    @app.middleware("http")
    async def security_headers(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        )
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()"
        return response

    @app.get("/", response_class=FileResponse)
    async def index() -> FileResponse:
        return FileResponse(_STATIC_DIRECTORY / "index.html", media_type="text/html")

    @app.get("/app.js", response_class=FileResponse)
    async def javascript() -> FileResponse:
        return FileResponse(_STATIC_DIRECTORY / "app.js", media_type="text/javascript")

    @app.get("/styles.css", response_class=FileResponse)
    async def stylesheet() -> FileResponse:
        return FileResponse(_STATIC_DIRECTORY / "styles.css", media_type="text/css")

    @app.get("/api/v1/bootstrap")
    async def bootstrap(request: Request) -> JSONResponse:
        _validate_loopback_request(request)
        entitlement = _authorize(authorizer)
        return JSONResponse(
            {
                "csrf_token": csrf_token,
                "license_status": entitlement.status.value,
                "license_warning": entitlement.warning,
                "maximum_fps": active_limits.maximum_fps,
                "maximum_height": active_limits.maximum_height,
                "maximum_width": active_limits.maximum_width,
                "tier": entitlement.claims.tier,
            }
        )

    @app.get("/api/v1/status")
    async def status(request: Request) -> JSONResponse:
        _validate_api_request(request, csrf_token, allowed_origins, require_origin=False)
        entitlement = _authorize(authorizer)
        async with lock:
            return JSONResponse(_status_document(session, entitlement))

    @app.post("/api/v1/session/start")
    async def start(request: Request) -> JSONResponse:
        _validate_api_request(request, csrf_token, allowed_origins, require_origin=True)
        entitlement = _authorize(authorizer)
        async with lock:
            session.receiver = make_receiver()
            session.scanning = True
            session.recovered = None
            session.accepted_frames = 0
            session.rejected_frames = 0
            session.last_frame_at = None
            session.last_progress = 0.0
            session.total_source_symbols = 0
            session.accepted_source_symbols = 0
            session.captured_frames = 0
            session.started_at = monotonic()
            return JSONResponse(_status_document(session, entitlement))

    @app.post("/api/v1/session/stop")
    async def stop(request: Request) -> JSONResponse:
        _validate_api_request(request, csrf_token, allowed_origins, require_origin=True)
        entitlement = _authorize(authorizer)
        async with lock:
            session.scanning = False
            return JSONResponse(_status_document(session, entitlement))

    @app.post("/api/v1/frame")
    async def frame(request: Request) -> JSONResponse:
        _validate_api_request(request, csrf_token, allowed_origins, require_origin=True)
        entitlement = _authorize(authorizer)
        if request.headers.get("content-type", "").split(";", 1)[0].strip() != "image/jpeg":
            return _error(415, "frame content type must be image/jpeg")
        async with lock:
            if not session.scanning:
                return _error(409, "capture session has not been explicitly started")
            observed_at = monotonic()
            if (
                session.started_at is None
                or observed_at - session.started_at >= active_limits.maximum_session_seconds
            ):
                session.scanning = False
                return _error(409, "capture session exceeded its duration limit")
            if session.captured_frames >= active_limits.maximum_frames:
                session.scanning = False
                return _error(409, "capture session exceeded its frame limit")
            minimum_interval = 1.0 / active_limits.maximum_fps
            if (
                session.last_frame_at is not None
                and observed_at - session.last_frame_at < minimum_interval
            ):
                return _error(429, "frame rate exceeds the configured local limit")
            session.last_frame_at = observed_at
            session.captured_frames += 1
            try:
                body = await _read_bounded_body(request, active_limits.maximum_jpeg_bytes)
                width, height = jpeg_dimensions(body)
            except LocalApiError as error:
                session.rejected_frames += 1
                return _error(413, str(error))
            if (
                width > active_limits.maximum_width
                or height > active_limits.maximum_height
                or width * height > active_limits.maximum_pixels
            ):
                session.rejected_frames += 1
                return _error(413, "JPEG dimensions exceed the configured local limits")
            encoded = np.frombuffer(body, dtype=np.uint8)
            decoded = await run_in_threadpool(cv2.imdecode, encoded, cv2.IMREAD_COLOR)
            if decoded is None:
                session.rejected_frames += 1
                return _error(422, "JPEG could not be decoded")
            image = cast(Image, decoded)
            if image.shape[1] != width or image.shape[0] != height:
                session.rejected_frames += 1
                return _error(422, "decoded JPEG dimensions do not match its header")
            try:
                progress = await run_in_threadpool(session.receiver.process_image, image)
            except (DmoftError, ValueError, cv2.error) as error:
                session.rejected_frames += 1
                document = _status_document(session, entitlement)
                document.update({"accepted": False, "message": str(error)[:240]})
                return JSONResponse(document)
            _accept_progress(session, progress)
            if session.receiver.can_recover_object:
                session.recovered = await run_in_threadpool(session.receiver.reconstruct)
                session.scanning = False
            document = _status_document(session, entitlement)
            document.update({"accepted": True, "message": "frame accepted"})
            return JSONResponse(document)

    @app.get("/api/v1/result")
    async def result(request: Request) -> Response:
        _validate_api_request(request, csrf_token, allowed_origins, require_origin=False)
        _authorize(authorizer)
        async with lock:
            if session.recovered is None:
                return _error(409, "encrypted container has not been reconstructed")
            return Response(
                session.recovered,
                media_type="application/octet-stream",
                headers={
                    "Content-Disposition": 'attachment; filename="transfer.dmoft"',
                    "X-DMOFT-Content": "encrypted-container",
                },
            )

    return app


def validate_loopback_bind(host: str) -> str:
    if not isinstance(host, str) or not host:
        raise LocalApiError("local API loopback bind host is empty")
    normalized = host.strip().lower()
    if normalized == "localhost":
        return normalized
    try:
        if ipaddress.ip_address(normalized).is_loopback:
            return normalized
    except ValueError:
        pass
    raise LocalApiError("DMOFT Pro camera API may bind only to a loopback address")


async def _read_bounded_body(request: Request, maximum_bytes: int) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > maximum_bytes:
            raise LocalApiError("JPEG body exceeds the configured byte limit")
        body.extend(chunk)
    if not body:
        raise LocalApiError("JPEG body is empty")
    return bytes(body)


def jpeg_dimensions(data: bytes) -> tuple[int, int]:
    """Read JPEG dimensions before asking OpenCV to allocate decoded pixels."""

    if len(data) < 4 or data[:2] != b"\xff\xd8":
        raise LocalApiError("frame is not a JPEG image")
    position = 2
    while position + 1 < len(data):
        while position < len(data) and data[position] == 0xFF:
            position += 1
        if position >= len(data):
            break
        marker = data[position]
        position += 1
        if marker in {0x00, 0x01, 0xD8} or 0xD0 <= marker <= 0xD7:
            continue
        if marker in {0xD9, 0xDA}:
            break
        if position + 2 > len(data):
            break
        segment_length = int.from_bytes(data[position : position + 2], "big")
        if segment_length < 2 or position + segment_length > len(data):
            raise LocalApiError("JPEG contains a malformed segment")
        if marker in _JPEG_START_OF_FRAME_MARKERS:
            if segment_length < 8:
                raise LocalApiError("JPEG size segment is malformed")
            height = int.from_bytes(data[position + 3 : position + 5], "big")
            width = int.from_bytes(data[position + 5 : position + 7], "big")
            if width < 1 or height < 1:
                raise LocalApiError("JPEG dimensions are zero")
            return width, height
        position += segment_length
    raise LocalApiError("JPEG has no supported size segment")


def _authorize(authorizer: AccessAuthorizer) -> VerifiedEntitlement:
    try:
        return authorizer.authorize((CAMERA_LIVE_FEATURE,))
    except EntitlementError as error:
        raise LocalApiError(str(error)) from error


def _validate_loopback_request(request: Request) -> None:
    hostname = request.url.hostname
    if hostname is None:
        raise LocalApiError("request has no host")
    validate_loopback_bind(hostname)
    client_host = request.client.host if request.client is not None else None
    if client_host is None:
        raise LocalApiError("request has no client address")
    validate_loopback_bind(client_host)


def _validate_api_request(
    request: Request,
    csrf_token: str,
    allowed_origins: frozenset[str],
    *,
    require_origin: bool,
) -> None:
    _validate_loopback_request(request)
    supplied = request.headers.get("x-dmoft-csrf", "")
    if not hmac.compare_digest(supplied, csrf_token):
        raise LocalApiError("local API CSRF token is missing or invalid")
    origin = request.headers.get("origin")
    if require_origin and origin not in allowed_origins:
        raise LocalApiError("request Origin is not the configured loopback UI")


def _allowed_origins(host: str, port: int) -> frozenset[str]:
    candidates = {"localhost", "127.0.0.1"}
    candidates.add(f"[{host}]" if ":" in host else host)
    return frozenset(f"http://{candidate}:{port}" for candidate in candidates)


def _status_document(
    session: _WebSession,
    entitlement: VerifiedEntitlement,
) -> dict[str, object]:
    state = (
        "recovered"
        if session.recovered is not None
        else ("scanning" if session.scanning else "stopped")
    )
    return {
        "accepted_frames": session.accepted_frames,
        "accepted_source_symbols": session.accepted_source_symbols,
        "completed": session.recovered is not None,
        "captured_frames": session.captured_frames,
        "independent_progress": session.last_progress,
        "license_status": entitlement.status.value,
        "license_warning": entitlement.warning,
        "rejected_frames": session.rejected_frames,
        "state": state,
        "total_source_symbols": session.total_source_symbols,
    }


def _accept_progress(session: _WebSession, progress: TransferProgress) -> None:
    session.accepted_frames += 1
    session.accepted_source_symbols = progress.accepted_source_symbols
    session.total_source_symbols = progress.total_source_symbols
    session.last_progress = progress.independent_progress


def _error(status_code: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status_code)
