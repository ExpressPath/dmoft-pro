"""Bounded, symlink-resistant local state-file helpers."""

from __future__ import annotations

import os
import secrets
import stat
from contextlib import suppress
from pathlib import Path

from dmoft_pro_client.errors import ProClientError


def _is_link_or_reparse(metadata: os.stat_result) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    attributes = getattr(metadata, "st_file_attributes", 0)
    return stat.S_ISLNK(metadata.st_mode) or bool(reparse_flag and attributes & reparse_flag)


def _open_flags(base: int) -> int:
    flags = base
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    return flags


def ensure_private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    metadata = path.lstat()
    if _is_link_or_reparse(metadata) or not stat.S_ISDIR(metadata.st_mode):
        raise ProClientError(f"state directory is not a real directory: {path}")
    try:
        path.chmod(0o700)
    except OSError as error:
        if os.name != "nt":
            raise ProClientError(f"cannot restrict state directory permissions: {path}") from error


def read_private_file(path: Path, *, maximum_bytes: int) -> bytes:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        raise
    if _is_link_or_reparse(metadata) or not stat.S_ISREG(metadata.st_mode):
        raise ProClientError(f"state path is not a regular file: {path}")
    if metadata.st_size > maximum_bytes:
        raise ProClientError(f"state file exceeds {maximum_bytes} bytes: {path}")
    descriptor = -1
    try:
        descriptor = os.open(path, _open_flags(os.O_RDONLY))
        opened = os.fstat(descriptor)
        if (
            _is_link_or_reparse(opened)
            or not stat.S_ISREG(opened.st_mode)
            or (metadata.st_dev, metadata.st_ino) != (opened.st_dev, opened.st_ino)
        ):
            raise ProClientError(f"state path changed while opening: {path}")
        if opened.st_size > maximum_bytes:
            raise ProClientError(f"state file exceeds {maximum_bytes} bytes: {path}")
        if os.name != "nt" and opened.st_mode & 0o077:
            try:
                descriptor_chmod = getattr(os, "fchmod", None)
                if descriptor_chmod is None:
                    raise OSError("descriptor chmod is unavailable")
                descriptor_chmod(descriptor, 0o600)
            except OSError as error:
                raise ProClientError(f"cannot restrict state file permissions: {path}") from error
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = -1
            data = stream.read(maximum_bytes + 1)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if len(data) > maximum_bytes:
        raise ProClientError(f"state file exceeds {maximum_bytes} bytes: {path}")
    return data


def write_private_file(path: Path, data: bytes, *, replace: bool) -> None:
    """Write a user-private file; optionally replace it using an atomic rename."""

    ensure_private_directory(path.parent)
    try:
        existing = path.lstat()
    except FileNotFoundError:
        existing = None
    if existing is not None and _is_link_or_reparse(existing):
        raise ProClientError(f"refusing to replace a linked state file: {path}")
    if not replace:
        flags = _open_flags(os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        descriptor = os.open(path, flags, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                descriptor = -1
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            if descriptor >= 0:
                os.close(descriptor)
        try:
            path.chmod(0o600)
        except OSError:
            if os.name != "nt":
                raise
        return

    temporary = path.parent / f".{path.name}.{secrets.token_hex(12)}.tmp"
    flags = _open_flags(os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = -1
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            current = path.lstat()
        except FileNotFoundError:
            current = None
        if current is not None and _is_link_or_reparse(current):
            raise ProClientError(f"refusing to replace a linked state file: {path}")
        os.replace(temporary, path)
        try:
            path.chmod(0o600)
        except OSError:
            if os.name != "nt":
                raise
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        with suppress(OSError):
            temporary.unlink(missing_ok=True)
