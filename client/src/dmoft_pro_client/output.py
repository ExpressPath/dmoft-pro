"""Safe output for reconstructed encrypted containers (never plaintext)."""

from __future__ import annotations

import os
import secrets
from contextlib import suppress
from pathlib import Path

from dmoft_pro_client.errors import ProClientError


def save_encrypted_container(path: Path, data: bytes, *, overwrite: bool = False) -> None:
    """Atomically save an explicitly requested encrypted-container output."""

    expanded = path.expanduser()
    if expanded.is_symlink():
        raise ProClientError("refusing to replace a symlinked output file")
    destination = expanded.absolute()
    if destination.exists() and not overwrite:
        raise ProClientError(f"output already exists (use --overwrite): {destination}")
    if not destination.parent.is_dir():
        raise ProClientError(f"output directory does not exist: {destination.parent}")
    temporary = destination.parent / f".{destination.name}.{secrets.token_hex(12)}.tmp"
    descriptor = -1
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_BINARY"):
            flags |= os.O_BINARY
        descriptor = os.open(temporary, flags, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = -1
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if destination.exists() and destination.is_symlink():
            raise ProClientError("refusing to replace a symlinked output file")
        os.replace(temporary, destination)
        try:
            destination.chmod(0o600)
        except OSError:
            if os.name != "nt":
                raise
    except OSError as error:
        raise ProClientError(f"cannot save encrypted container: {destination}") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        with suppress(OSError):
            temporary.unlink(missing_ok=True)
