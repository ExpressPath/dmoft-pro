"""Command-line entry point for DMOFT Pro activation and local capture."""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
from dataclasses import asdict
from pathlib import Path

import cv2
import uvicorn
from dmoft import __version__ as community_version

from dmoft_pro_client import __version__
from dmoft_pro_client.activation import (
    AccountServiceClient,
    ActivationServiceClient,
    HttpJsonTransport,
)
from dmoft_pro_client.camera import CameraLimits, CameraScanEvent, CameraScanner
from dmoft_pro_client.device import DeviceIdentity, DeviceIdentityStore, default_state_directory
from dmoft_pro_client.entitlement import (
    CAMERA_LIVE_FEATURE,
    EntitlementVerifier,
    IssuerKeySet,
    LicenseStore,
    StoredEntitlementAuthorizer,
    VerifiedEntitlement,
)
from dmoft_pro_client.errors import ProClientError
from dmoft_pro_client.keyset import fetch_pinned_keyset
from dmoft_pro_client.output import save_encrypted_container
from dmoft_pro_client.storage import read_private_file
from dmoft_pro_client.web import WebCaptureLimits, create_app, validate_loopback_bind

_DEFAULT_SERVER_URL = "https://licenses.dmoft.example"
_MAXIMUM_ACCESS_TOKEN_BYTES = 32_768


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="dmoft-pro", description=__doc__)
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--state-dir",
        type=Path,
        default=default_state_directory(),
        help="private device/license state directory",
    )
    network = argparse.ArgumentParser(add_help=False)
    network.add_argument(
        "--server-url",
        default=os.environ.get("DMOFT_PRO_LICENSE_SERVER", _DEFAULT_SERVER_URL),
    )
    network.add_argument(
        "--access-token-file",
        type=Path,
        default=_optional_environment_path("DMOFT_PRO_ACCESS_TOKEN_FILE"),
        help="private file containing the OIDC bearer access token",
    )
    common.add_argument(
        "--issuer-keys",
        type=Path,
        default=_optional_environment_path("DMOFT_PRO_ISSUER_KEYS"),
        help="trusted Ed25519 issuer keyset JSON",
    )
    common.add_argument(
        "--issuer",
        default=os.environ.get("DMOFT_PRO_LICENSE_ISSUER"),
        help="exact signed license issuer",
    )

    doctor = commands.add_parser("doctor", parents=[common], help="inspect local readiness")
    doctor.set_defaults(handler=_doctor)

    checkout = commands.add_parser(
        "checkout", parents=[network], help="create a Stripe Checkout Session"
    )
    checkout.add_argument("--plan", choices=["pro_monthly", "pro_annual"], required=True)
    checkout.set_defaults(handler=_checkout)

    portal = commands.add_parser(
        "portal", parents=[network], help="create a Stripe Customer Portal Session"
    )
    portal.set_defaults(handler=_portal)

    activate = commands.add_parser(
        "activate", parents=[common, network], help="activate after Checkout"
    )
    activate.add_argument("--checkout-session-id", required=True)
    activate.add_argument("--device-name", default=platform.node() or "DMOFT Pro device")
    activate.set_defaults(handler=_activate)

    enroll = commands.add_parser(
        "enroll", parents=[common, network], help="enroll an additional licensed device"
    )
    enroll.add_argument("--device-name", default=platform.node() or "DMOFT Pro device")
    enroll.set_defaults(handler=_enroll)

    refresh = commands.add_parser("refresh", parents=[common], help="refresh the offline license")
    refresh.add_argument(
        "--server-url",
        default=os.environ.get("DMOFT_PRO_LICENSE_SERVER", _DEFAULT_SERVER_URL),
    )
    refresh.set_defaults(handler=_refresh)

    devices = commands.add_parser(
        "devices-list", parents=[network], help="list devices registered to the account"
    )
    devices.set_defaults(handler=_devices_list)

    revoke = commands.add_parser(
        "devices-revoke", parents=[network], help="revoke one registered device"
    )
    revoke.add_argument("device_id")
    revoke.set_defaults(handler=_devices_revoke)

    keyset = commands.add_parser("keyset-fetch", help="fetch a fingerprint-pinned issuer keyset")
    keyset.add_argument("--url", required=True, help="absolute HTTPS keyset endpoint")
    keyset.add_argument("--sha256", required=True, help="out-of-band expected SHA-256")
    keyset.add_argument("--output", type=Path, required=True)
    keyset.add_argument("--overwrite", action="store_true")
    keyset.set_defaults(handler=_keyset_fetch)

    scan = commands.add_parser("scan-camera", parents=[common], help="scan with an OpenCV camera")
    scan.add_argument("--camera", type=int, default=0)
    scan.add_argument("--fps", type=float, default=10.0)
    scan.add_argument("--maximum-width", type=int, default=1920)
    scan.add_argument("--maximum-height", type=int, default=1080)
    scan.add_argument("--maximum-seconds", type=float, default=900.0)
    scan.add_argument("--maximum-frames", type=int, default=100_000)
    scan.add_argument("--adaptive", action="store_true")
    scan.add_argument("--output", type=Path, required=True)
    scan.add_argument("--overwrite", action="store_true")
    scan.set_defaults(handler=_scan_camera)

    serve = commands.add_parser("serve", parents=[common], help="serve the loopback browser UI")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--maximum-fps", type=float, default=15.0)
    serve.add_argument("--maximum-width", type=int, default=1920)
    serve.add_argument("--maximum-height", type=int, default=1080)
    serve.set_defaults(handler=_serve)
    return parser


def main(arguments: list[str] | None = None) -> int:
    parser = build_parser()
    namespace = parser.parse_args(arguments)
    try:
        handler = namespace.handler
        return int(handler(namespace))
    except (ProClientError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


def _doctor(arguments: argparse.Namespace) -> int:
    state_directory = Path(arguments.state_dir)
    report: dict[str, object] = {
        "camera_backend": hasattr(cv2, "VideoCapture"),
        "community_dmoft": community_version,
        "pro_client": __version__,
        "state_directory": str(state_directory),
    }
    ready = True
    try:
        device = DeviceIdentityStore(state_directory).load()
        report.update(
            {
                "device_id": device.device_id,
                "device_identity": "ready",
                "device_public_key": device.public_key_base64url,
            }
        )
    except ProClientError as error:
        ready = False
        report.update({"device_identity": "missing", "device_error": str(error)})
        device = None
    try:
        verifier = _verifier(arguments)
        report["issuer_keyset"] = "ready"
    except ProClientError as error:
        ready = False
        report.update({"issuer_keyset": "invalid", "issuer_error": str(error)})
        verifier = None
    if device is not None and verifier is not None:
        try:
            entitlement = verifier.verify(
                LicenseStore(state_directory).load(),
                device=device,
                required_features=(CAMERA_LIVE_FEATURE,),
            )
            report.update(
                {
                    "license": entitlement.status.value,
                    "license_expires_at": entitlement.claims.expires_at,
                    "license_grace_until": entitlement.claims.grace_until,
                    "license_tier": entitlement.claims.tier,
                    "license_warning": entitlement.warning,
                }
            )
        except ProClientError as error:
            ready = False
            report.update({"license": "invalid", "license_error": str(error)})
    report["ready"] = ready
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if ready else 2


def _activate(arguments: argparse.Namespace) -> int:
    state_directory = Path(arguments.state_dir)
    device = DeviceIdentityStore(state_directory).load_or_create()
    client = _activation_client(arguments, device, require_access_token=True)
    result = client.activate(
        arguments.checkout_session_id,
        device_name=arguments.device_name,
    )
    _print_license_result(
        result.entitlement.status.value,
        result.refresh_after,
        result.entitlement.warning,
    )
    return 0


def _checkout(arguments: argparse.Namespace) -> int:
    result = _account_client(arguments).create_checkout(arguments.plan)
    print(
        json.dumps(
            {
                "checkout_session_id": result.checkout_session_id,
                "url": result.url,
            },
            sort_keys=True,
        )
    )
    return 0


def _portal(arguments: argparse.Namespace) -> int:
    print(json.dumps({"url": _account_client(arguments).create_portal_session()}, sort_keys=True))
    return 0


def _enroll(arguments: argparse.Namespace) -> int:
    state_directory = Path(arguments.state_dir)
    device = DeviceIdentityStore(state_directory).load_or_create()
    result = _activation_client(arguments, device, require_access_token=True).enroll(
        device_name=arguments.device_name
    )
    _print_license_result(
        result.entitlement.status.value,
        result.refresh_after,
        result.entitlement.warning,
    )
    return 0


def _refresh(arguments: argparse.Namespace) -> int:
    state_directory = Path(arguments.state_dir)
    device = DeviceIdentityStore(state_directory).load()
    result = _activation_client(arguments, device, require_access_token=False).refresh()
    _print_license_result(
        result.entitlement.status.value,
        result.refresh_after,
        result.entitlement.warning,
    )
    return 0


def _devices_list(arguments: argparse.Namespace) -> int:
    records = _account_client(arguments).list_devices()
    print(json.dumps({"devices": [asdict(record) for record in records]}, sort_keys=True))
    return 0


def _devices_revoke(arguments: argparse.Namespace) -> int:
    record = _account_client(arguments).revoke_device(arguments.device_id)
    print(json.dumps(asdict(record), sort_keys=True))
    if record.offline_token_valid_until is not None:
        print(
            "warning: an already-issued offline token may remain usable until "
            f"{record.offline_token_valid_until}",
            file=sys.stderr,
        )
    return 0


def _keyset_fetch(arguments: argparse.Namespace) -> int:
    fingerprint = fetch_pinned_keyset(
        arguments.url,
        arguments.sha256,
        Path(arguments.output),
        overwrite=bool(arguments.overwrite),
    )
    print(
        json.dumps(
            {
                "output": str(Path(arguments.output).expanduser().absolute()),
                "sha256": fingerprint,
            },
            sort_keys=True,
        )
    )
    return 0


def _scan_camera(arguments: argparse.Namespace) -> int:
    authorizer, _ = _authorizer(arguments)
    limits = CameraLimits(
        maximum_width=arguments.maximum_width,
        maximum_height=arguments.maximum_height,
        maximum_pixels=arguments.maximum_width * arguments.maximum_height,
        target_fps=arguments.fps,
        maximum_fps=15.0,
        maximum_scan_seconds=arguments.maximum_seconds,
        maximum_frames=arguments.maximum_frames,
    )
    scanner = CameraScanner(authorizer, limits=limits)
    entitlement = scanner.start(arguments.camera, adaptive=arguments.adaptive)
    if entitlement.warning:
        print(f"warning: {entitlement.warning}", file=sys.stderr)
    try:
        result = scanner.scan(on_event=_print_scan_event)
    except KeyboardInterrupt:
        scanner.stop()
        print("Camera capture stopped by user.", file=sys.stderr)
        return 130
    if not result.completed or result.encrypted_container is None:
        print(
            f"No complete object after {result.captured_frames} frames "
            f"({result.accepted_frames} accepted).",
            file=sys.stderr,
        )
        return 3
    save_encrypted_container(
        Path(arguments.output),
        result.encrypted_container,
        overwrite=bool(arguments.overwrite),
    )
    print(
        json.dumps(
            {
                "accepted_frames": result.accepted_frames,
                "captured_frames": result.captured_frames,
                "encrypted_bytes": len(result.encrypted_container),
                "output": str(Path(arguments.output).expanduser().resolve()),
                "rejected_frames": result.rejected_frames,
            },
            sort_keys=True,
        )
    )
    return 0


def _serve(arguments: argparse.Namespace) -> int:
    host = validate_loopback_bind(arguments.host)
    authorizer, entitlement = _authorizer(arguments)
    if entitlement.warning:
        print(f"warning: {entitlement.warning}", file=sys.stderr)
    limits = WebCaptureLimits(
        maximum_width=arguments.maximum_width,
        maximum_height=arguments.maximum_height,
        maximum_pixels=arguments.maximum_width * arguments.maximum_height,
        maximum_fps=arguments.maximum_fps,
    )
    application = create_app(
        authorizer,
        bind_host=host,
        port=arguments.port,
        limits=limits,
    )
    print(f"DMOFT Pro local camera UI: http://{_display_host(host)}:{arguments.port}")
    uvicorn.run(application, host=host, port=arguments.port, access_log=False)
    return 0


def _activation_client(
    arguments: argparse.Namespace,
    device: DeviceIdentity,
    *,
    require_access_token: bool,
) -> ActivationServiceClient:
    state_directory = Path(arguments.state_dir)
    return ActivationServiceClient(
        HttpJsonTransport(
            arguments.server_url,
            bearer_token=_access_token(arguments, required=require_access_token),
        ),
        verifier=_verifier(arguments),
        license_store=LicenseStore(state_directory),
        device=device,
    )


def _account_client(arguments: argparse.Namespace) -> AccountServiceClient:
    return AccountServiceClient(
        HttpJsonTransport(
            arguments.server_url,
            bearer_token=_access_token(arguments, required=True),
        )
    )


def _authorizer(
    arguments: argparse.Namespace,
) -> tuple[StoredEntitlementAuthorizer, VerifiedEntitlement]:
    state_directory = Path(arguments.state_dir)
    device = DeviceIdentityStore(state_directory).load()
    authorizer = StoredEntitlementAuthorizer(
        LicenseStore(state_directory),
        _verifier(arguments),
        device,
    )
    entitlement = authorizer.authorize((CAMERA_LIVE_FEATURE,))
    return authorizer, entitlement


def _verifier(arguments: argparse.Namespace) -> EntitlementVerifier:
    keyset_path = arguments.issuer_keys
    issuer = arguments.issuer
    if keyset_path is None:
        raise ProClientError("--issuer-keys or DMOFT_PRO_ISSUER_KEYS is required")
    if not issuer:
        raise ProClientError("--issuer or DMOFT_PRO_LICENSE_ISSUER is required")
    return EntitlementVerifier(
        IssuerKeySet.from_file(Path(keyset_path)),
        expected_issuer=issuer,
    )


def _print_scan_event(event: CameraScanEvent) -> None:
    if event.accepted:
        print(
            f"frame={event.frame_number} accepted progress={event.independent_progress:.1%}",
            file=sys.stderr,
        )


def _print_license_result(status: str, refresh_after: int, warning: str | None) -> None:
    print(json.dumps({"license_status": status, "refresh_after": refresh_after}, sort_keys=True))
    if warning:
        print(f"warning: {warning}", file=sys.stderr)


def _optional_environment_path(variable: str) -> Path | None:
    value = os.environ.get(variable)
    return Path(value) if value else None


def _access_token(arguments: argparse.Namespace, *, required: bool) -> str | None:
    environment_token = os.environ.get("DMOFT_PRO_ACCESS_TOKEN")
    token_file = getattr(arguments, "access_token_file", None)
    token: str | None
    if environment_token is not None and token_file is not None:
        raise ProClientError(
            "set only one of DMOFT_PRO_ACCESS_TOKEN and --access-token-file/"
            "DMOFT_PRO_ACCESS_TOKEN_FILE"
        )
    if token_file is not None:
        try:
            encoded = read_private_file(Path(token_file), maximum_bytes=_MAXIMUM_ACCESS_TOKEN_BYTES)
            token = encoded.decode("ascii")
        except (OSError, UnicodeDecodeError, ProClientError) as error:
            raise ProClientError(f"cannot read OIDC access-token file: {token_file}") from error
        token = token.rstrip("\r\n")
    else:
        token = environment_token
    if required and not token:
        raise ProClientError(
            "DMOFT_PRO_ACCESS_TOKEN or --access-token-file is required for this account operation"
        )
    return token


def _display_host(host: str) -> str:
    return f"[{host}]" if ":" in host else host


if __name__ == "__main__":
    raise SystemExit(main())
