"""Small strict encoders shared by entitlement and activation code."""

from __future__ import annotations

import base64
import binascii
import json
import re
from typing import Any

_BASE64URL_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


def b64url_encode(value: bytes) -> str:
    """Encode bytes as canonical, unpadded base64url."""

    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def b64url_decode(value: str, *, maximum_bytes: int) -> bytes:
    """Strictly decode one non-empty, unpadded, canonical base64url segment."""

    if not value or "=" in value or _BASE64URL_PATTERN.fullmatch(value) is None:
        raise ValueError("value is not unpadded base64url")
    if len(value) % 4 == 1:
        raise ValueError("base64url value has an impossible length")
    maximum_characters = ((maximum_bytes + 2) // 3) * 4
    if len(value) > maximum_characters:
        raise ValueError("base64url value exceeds its size limit")
    padding = "=" * ((4 - len(value) % 4) % 4)
    try:
        decoded = base64.b64decode(value + padding, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("base64url value is malformed") from error
    if len(decoded) > maximum_bytes or b64url_encode(decoded) != value:
        raise ValueError("base64url value is not canonical")
    return decoded


def canonical_json_bytes(value: Any) -> bytes:
    """Return deterministic UTF-8 JSON without insignificant whitespace."""

    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def strict_json_object(data: bytes, *, maximum_bytes: int) -> dict[str, Any]:
    """Parse one UTF-8 JSON object while rejecting duplicate member names."""

    if not data or len(data) > maximum_bytes:
        raise ValueError("JSON object is empty or exceeds its size limit")

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON member: {key}")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON value is forbidden: {value}")

    try:
        parsed = json.loads(
            data.decode("utf-8"),
            object_pairs_hook=reject_duplicates,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("value is not a valid UTF-8 JSON object") from error
    if not isinstance(parsed, dict) or not all(isinstance(key, str) for key in parsed):
        raise ValueError("top-level JSON value must be an object")
    return parsed
