from __future__ import annotations

from pathlib import Path

import pytest

from dmoft_pro_client.errors import ProClientError
from dmoft_pro_client.output import save_encrypted_container


def test_encrypted_output_is_atomic_and_refuses_overwrite(tmp_path: Path) -> None:
    output = tmp_path / "transfer.dmoft"
    save_encrypted_container(output, b"ciphertext")
    assert output.read_bytes() == b"ciphertext"
    with pytest.raises(ProClientError, match="already exists"):
        save_encrypted_container(output, b"replacement")
    save_encrypted_container(output, b"replacement", overwrite=True)
    assert output.read_bytes() == b"replacement"


def test_output_parent_must_exist(tmp_path: Path) -> None:
    with pytest.raises(ProClientError, match="does not exist"):
        save_encrypted_container(tmp_path / "missing" / "transfer.dmoft", b"data")
