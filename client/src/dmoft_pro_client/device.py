"""Per-install Ed25519 device identity generation and storage."""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from dmoft_pro_client.encoding import b64url_encode
from dmoft_pro_client.errors import DeviceIdentityError, ProClientError
from dmoft_pro_client.storage import read_private_file, write_private_file

_DEVICE_KEY_FILE = "device-ed25519-private.pem"
_MAXIMUM_KEY_FILE_BYTES = 8_192
_DEVICE_ID_DIGEST_BYTES = 18
_MAXIMUM_CHALLENGE_UTF8_BYTES = 4_096


def default_state_directory() -> Path:
    """Return a per-user state directory without creating it."""

    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
        return base / "DMOFT Pro"
    state_home = os.environ.get("XDG_STATE_HOME")
    base = Path(state_home) if state_home else Path.home() / ".local" / "state"
    return base / "dmoft-pro"


@dataclass(frozen=True, slots=True)
class DeviceIdentity:
    """An in-memory handle to the installation private key."""

    private_key: Ed25519PrivateKey

    @property
    def public_key(self) -> Ed25519PublicKey:
        return self.private_key.public_key()

    @property
    def public_key_raw(self) -> bytes:
        return self.public_key.public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )

    @property
    def public_key_base64url(self) -> str:
        return b64url_encode(self.public_key_raw)

    @property
    def public_key_sha256(self) -> str:
        return b64url_encode(hashlib.sha256(self.public_key_raw).digest())

    @property
    def device_id(self) -> str:
        digest = hashlib.sha256(self.public_key_raw).digest()[:_DEVICE_ID_DIGEST_BYTES]
        return f"dmoft-device-v1-{b64url_encode(digest)}"

    def sign_challenge(self, challenge: str) -> str:
        if not isinstance(challenge, str) or not challenge:
            raise DeviceIdentityError("activation challenge must be a non-empty string")
        encoded = challenge.encode("utf-8")
        if len(encoded) > _MAXIMUM_CHALLENGE_UTF8_BYTES:
            raise DeviceIdentityError("activation challenge exceeds 4096 UTF-8 bytes")
        return b64url_encode(self.private_key.sign(encoded))


class DeviceIdentityStore:
    """Load or create the private device identity at a fixed local path."""

    def __init__(self, state_directory: Path | None = None) -> None:
        self.state_directory = state_directory or default_state_directory()
        self.path = self.state_directory / _DEVICE_KEY_FILE

    def load(self) -> DeviceIdentity:
        try:
            encoded = read_private_file(self.path, maximum_bytes=_MAXIMUM_KEY_FILE_BYTES)
            loaded = serialization.load_pem_private_key(encoded, password=None)
        except FileNotFoundError as error:
            raise DeviceIdentityError(f"device identity does not exist: {self.path}") from error
        except (OSError, ValueError, TypeError, ProClientError) as error:
            raise DeviceIdentityError(f"cannot load device identity: {self.path}") from error
        if not isinstance(loaded, Ed25519PrivateKey):
            raise DeviceIdentityError("stored device identity is not an Ed25519 private key")
        return DeviceIdentity(loaded)

    def load_or_create(self) -> DeviceIdentity:
        try:
            return self.load()
        except DeviceIdentityError:
            if self.path.exists():
                raise
        identity = DeviceIdentity(Ed25519PrivateKey.generate())
        encoded = identity.private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        try:
            write_private_file(self.path, encoded, replace=False)
        except FileExistsError:
            return self.load()
        except (OSError, ProClientError) as error:
            raise DeviceIdentityError(f"cannot create device identity: {self.path}") from error
        return identity
