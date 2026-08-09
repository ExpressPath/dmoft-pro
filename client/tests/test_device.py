from __future__ import annotations

import os
from pathlib import Path

import pytest
from cryptography.exceptions import InvalidSignature

from dmoft_pro_client.device import DeviceIdentityStore
from dmoft_pro_client.encoding import b64url_decode
from dmoft_pro_client.errors import DeviceIdentityError, ProClientError
from dmoft_pro_client.storage import read_private_file


def test_device_identity_is_created_once_and_persists(tmp_path: Path) -> None:
    store = DeviceIdentityStore(tmp_path)
    first = store.load_or_create()
    second = store.load_or_create()
    assert first.device_id == second.device_id
    assert len(b64url_decode(first.public_key_base64url, maximum_bytes=32)) == 32
    assert len(b64url_decode(first.public_key_sha256, maximum_bytes=32)) == 32
    if os.name != "nt":
        assert store.path.stat().st_mode & 0o077 == 0


def test_device_signs_exact_utf8_challenge(tmp_path: Path) -> None:
    identity = DeviceIdentityStore(tmp_path).load_or_create()
    challenge = "dmoft-challenge:東京:123"
    signature = b64url_decode(identity.sign_challenge(challenge), maximum_bytes=64)
    identity.public_key.verify(signature, challenge.encode("utf-8"))
    with pytest.raises(InvalidSignature):
        identity.public_key.verify(signature, (challenge + ".").encode("utf-8"))


def test_corrupt_device_key_is_not_silently_replaced(tmp_path: Path) -> None:
    store = DeviceIdentityStore(tmp_path)
    tmp_path.mkdir(exist_ok=True)
    store.path.write_bytes(b"not a key")
    with pytest.raises(DeviceIdentityError, match="cannot load"):
        store.load_or_create()


def test_missing_identity_load_is_explicit(tmp_path: Path) -> None:
    with pytest.raises(DeviceIdentityError, match="does not exist"):
        DeviceIdentityStore(tmp_path).load()


def test_private_state_reader_refuses_links_and_reparse_points(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.write_bytes(b"secret")
    linked = tmp_path / "linked"
    try:
        linked.symlink_to(target)
    except OSError:
        pytest.skip("this Windows account cannot create symbolic links")
    with pytest.raises(ProClientError, match="regular file"):
        read_private_file(linked, maximum_bytes=128)
