"""Pinned bootstrap for the public DMOFT Pro license-verification keyset."""

from __future__ import annotations

import hashlib
import hmac
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from dmoft_pro_client.entitlement import IssuerKeySet
from dmoft_pro_client.errors import ActivationError, EntitlementError, ProClientError
from dmoft_pro_client.storage import write_private_file

_MAXIMUM_KEYSET_BYTES = 64 * 1024
_SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")


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


def fetch_pinned_keyset(
    url: str,
    expected_sha256: str,
    destination: Path,
    *,
    overwrite: bool = False,
    timeout_seconds: float = 10.0,
) -> str:
    """Download, fingerprint, strictly parse, then atomically store a keyset."""

    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ActivationError("keyset URL must be an absolute HTTPS URL without extra data")
    if _SHA256_PATTERN.fullmatch(expected_sha256) is None:
        raise ActivationError("expected keyset SHA-256 must contain exactly 64 hexadecimal digits")
    if not 1.0 <= timeout_seconds <= 60.0:
        raise ValueError("keyset timeout must be between 1 and 60 seconds")
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "dmoft-pro-client/0.1",
        },
        method="GET",
    )
    opener = urllib.request.build_opener(_NoRedirectHandler())
    try:
        with opener.open(request, timeout=timeout_seconds) as response:
            if response.headers.get_content_type() != "application/json":
                raise ActivationError("keyset service returned a non-JSON response")
            body = response.read(_MAXIMUM_KEYSET_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise ActivationError(f"keyset service rejected the request (HTTP {error.code})") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ActivationError("keyset service could not be reached") from error
    if len(body) > _MAXIMUM_KEYSET_BYTES:
        raise ActivationError("keyset response exceeds 64 KiB")
    observed = hashlib.sha256(body).hexdigest()
    if not hmac.compare_digest(observed, expected_sha256.lower()):
        raise ActivationError("keyset SHA-256 does not match the out-of-band fingerprint")
    try:
        IssuerKeySet.from_bytes(body)
        write_private_file(destination, body, replace=overwrite)
    except FileExistsError as error:
        raise ActivationError(f"keyset already exists (use --overwrite): {destination}") from error
    except (EntitlementError, OSError, ProClientError) as error:
        raise ActivationError("keyset could not be validated or stored") from error
    return observed
