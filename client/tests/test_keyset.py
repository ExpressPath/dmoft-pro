from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from dmoft_pro_client.encoding import b64url_encode, canonical_json_bytes
from dmoft_pro_client.entitlement import IssuerKeySet
from dmoft_pro_client.errors import ActivationError
from dmoft_pro_client.keyset import fetch_pinned_keyset


class _Headers:
    def get_content_type(self) -> str:
        return "application/json"


class _Response:
    headers = _Headers()

    def __init__(self, body: bytes) -> None:
        self.body = body

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self, maximum: int) -> bytes:
        return self.body[:maximum]


class _Opener:
    def __init__(self, body: bytes) -> None:
        self.body = body

    def open(self, request: object, timeout: float) -> _Response:
        assert timeout == 10.0
        return _Response(self.body)


def _keyset() -> bytes:
    public = (
        Ed25519PrivateKey.generate()
        .public_key()
        .public_bytes(
            serialization.Encoding.Raw,
            serialization.PublicFormat.Raw,
        )
    )
    return canonical_json_bytes(
        {"keys": [{"alg": "EdDSA", "kid": "key-2026", "public_key": b64url_encode(public)}], "v": 1}
    )


def test_keyset_fetch_requires_out_of_band_fingerprint_before_atomic_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = _keyset()
    monkeypatch.setattr(
        "dmoft_pro_client.keyset.urllib.request.build_opener",
        lambda *handlers: _Opener(body),
    )
    destination = tmp_path / "issuer-keyset.json"
    digest = hashlib.sha256(body).hexdigest()
    assert fetch_pinned_keyset("https://licenses.test/keyset", digest, destination) == digest
    assert IssuerKeySet.from_file(destination) is not None


def test_keyset_fetch_rejects_mismatch_http_and_redirectless_envelope(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = _keyset()
    monkeypatch.setattr(
        "dmoft_pro_client.keyset.urllib.request.build_opener",
        lambda *handlers: _Opener(body),
    )
    destination = tmp_path / "issuer-keyset.json"
    with pytest.raises(ActivationError, match="does not match"):
        fetch_pinned_keyset("https://licenses.test/keyset", "0" * 64, destination)
    assert not destination.exists()
    with pytest.raises(ActivationError, match="HTTPS"):
        fetch_pinned_keyset(
            "http://licenses.test/keyset",
            hashlib.sha256(body).hexdigest(),
            destination,
        )
