from __future__ import annotations

import pytest

from dmoft_pro_client.encoding import b64url_decode, b64url_encode, strict_json_object


def test_base64url_is_canonical_and_bounded() -> None:
    assert b64url_decode(b64url_encode(b"\x00\xff"), maximum_bytes=2) == b"\x00\xff"
    for value in ("", "abc=", "a", "ab+/"):
        with pytest.raises(ValueError):
            b64url_decode(value, maximum_bytes=8)
    with pytest.raises(ValueError, match="size"):
        b64url_decode(b64url_encode(b"too long"), maximum_bytes=2)


def test_strict_json_rejects_duplicates_nonobjects_and_nonfinite() -> None:
    assert strict_json_object(b'{"a":1}', maximum_bytes=16) == {"a": 1}
    for value in (b'{"a":1,"a":2}', b"[]", b'{"a":NaN}', b"\xff"):
        with pytest.raises(ValueError):
            strict_json_object(value, maximum_bytes=64)
    with pytest.raises(ValueError, match="size"):
        strict_json_object(b"{}", maximum_bytes=1)
