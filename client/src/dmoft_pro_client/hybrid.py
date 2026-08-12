"""Entitlement-gated coordinator for optically bound local packet transports."""

from __future__ import annotations

import hashlib
import hmac
import time
from collections import deque
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol
from urllib.parse import urlsplit

from dmoft.optical.transport_header import TransportFrameHeader
from dmoft.protocol import DEFAULT_RESOURCE_LIMITS, ResourceLimits
from dmoft.transfer import DynamicTransferReceiver, TransferPacket, TransferProgress

from dmoft_pro_client.encoding import (
    b64url_decode,
    b64url_encode,
    canonical_json_bytes,
    strict_json_object,
)
from dmoft_pro_client.entitlement import TRANSPORT_HYBRID_FEATURE, AccessAuthorizer
from dmoft_pro_client.errors import HybridTransportError

HYBRID_OFFER_VERSION = 1
HYBRID_ENVELOPE_VERSION = 1
MAXIMUM_OFFER_LIFETIME_SECONDS = 5 * 60
MAXIMUM_ENDPOINT_CHARACTERS = 512
MAXIMUM_ENVELOPE_BYTES = 128 * 1024
_OFFER_FIELDS = frozenset(
    {
        "v",
        "session_id",
        "transfer_id",
        "issued_at",
        "expires_at",
        "transport",
        "endpoint",
        "channel_binding_sha256",
    }
)
_ENVELOPE_FIELDS = frozenset(
    {"v", "session_id", "transfer_id", "sequence", "header", "payload", "digest"}
)
_ENVELOPE_DOMAIN = b"DMOFT-HYBRID-ENVELOPE-v1\x00"


class HybridTransportKind(StrEnum):
    TLS_LAN = "tls-lan"
    WEBRTC_DATA_CHANNEL = "webrtc-data-channel"


@dataclass(frozen=True, slots=True)
class HybridOffer:
    session_id: bytes
    transfer_id: bytes
    issued_at: int
    expires_at: int
    transport: HybridTransportKind
    endpoint: str
    channel_binding_sha256: bytes
    version: int = HYBRID_OFFER_VERSION

    def __post_init__(self) -> None:
        if self.version != HYBRID_OFFER_VERSION:
            raise HybridTransportError("unsupported hybrid offer version")
        if type(self.session_id) is not bytes or len(self.session_id) != 16:
            raise HybridTransportError("hybrid offer session ID must be 16 bytes")
        if type(self.transfer_id) is not bytes or len(self.transfer_id) != 16:
            raise HybridTransportError("hybrid offer transfer ID must be 16 bytes")
        if type(self.issued_at) is not int or type(self.expires_at) is not int:
            raise HybridTransportError("hybrid offer times must be integers")
        if not self.issued_at < self.expires_at <= self.issued_at + MAXIMUM_OFFER_LIFETIME_SECONDS:
            raise HybridTransportError(
                "hybrid offer lifetime must be positive and at most five minutes"
            )
        if not isinstance(self.transport, HybridTransportKind):
            raise HybridTransportError("hybrid offer transport kind is invalid")
        if not 1 <= len(self.endpoint) <= MAXIMUM_ENDPOINT_CHARACTERS:
            raise HybridTransportError("hybrid endpoint length is invalid")
        parsed = urlsplit(self.endpoint)
        allowed_schemes = {
            HybridTransportKind.TLS_LAN: {"https", "wss"},
            HybridTransportKind.WEBRTC_DATA_CHANNEL: {"webrtc"},
        }[self.transport]
        if parsed.scheme not in allowed_schemes or not parsed.netloc:
            raise HybridTransportError("hybrid endpoint scheme does not match its transport")
        if parsed.username is not None or parsed.password is not None or parsed.fragment:
            raise HybridTransportError("hybrid endpoint must not contain credentials or a fragment")
        if type(self.channel_binding_sha256) is not bytes or len(self.channel_binding_sha256) != 32:
            raise HybridTransportError("hybrid channel binding must be a SHA-256 digest")

    def require_active(self, *, now: int | None = None) -> None:
        current = int(time.time()) if now is None else now
        if type(current) is not int or not self.issued_at <= current < self.expires_at:
            raise HybridTransportError("hybrid offer is not currently active")

    def require_channel_binding(self, observed_sha256: bytes) -> None:
        if type(observed_sha256) is not bytes or len(observed_sha256) != 32:
            raise HybridTransportError("observed hybrid channel binding is invalid")
        if not hmac.compare_digest(self.channel_binding_sha256, observed_sha256):
            raise HybridTransportError("hybrid channel binding does not match the optical offer")

    def to_bytes(self) -> bytes:
        return canonical_json_bytes(
            {
                "v": self.version,
                "session_id": b64url_encode(self.session_id),
                "transfer_id": b64url_encode(self.transfer_id),
                "issued_at": self.issued_at,
                "expires_at": self.expires_at,
                "transport": self.transport.value,
                "endpoint": self.endpoint,
                "channel_binding_sha256": b64url_encode(self.channel_binding_sha256),
            }
        )

    @classmethod
    def from_bytes(cls, encoded: bytes) -> HybridOffer:
        try:
            document = strict_json_object(encoded, maximum_bytes=4096)
            if set(document) != _OFFER_FIELDS:
                raise ValueError("hybrid offer fields are invalid")
            if document["v"] != HYBRID_OFFER_VERSION:
                raise ValueError("hybrid offer version is invalid")
            issued_at = _strict_int(document["issued_at"], "issued_at")
            expires_at = _strict_int(document["expires_at"], "expires_at")
            transport_value = document["transport"]
            endpoint = document["endpoint"]
            if not isinstance(transport_value, str) or not isinstance(endpoint, str):
                raise ValueError("hybrid offer strings are invalid")
            offer = cls(
                session_id=b64url_decode(_strict_string(document["session_id"]), maximum_bytes=16),
                transfer_id=b64url_decode(
                    _strict_string(document["transfer_id"]), maximum_bytes=16
                ),
                issued_at=issued_at,
                expires_at=expires_at,
                transport=HybridTransportKind(transport_value),
                endpoint=endpoint,
                channel_binding_sha256=b64url_decode(
                    _strict_string(document["channel_binding_sha256"]), maximum_bytes=32
                ),
            )
        except (KeyError, ValueError, TypeError, HybridTransportError) as error:
            raise HybridTransportError("hybrid offer is malformed") from error
        if offer.to_bytes() != encoded:
            raise HybridTransportError("hybrid offer is not canonical")
        return offer


@dataclass(frozen=True, slots=True)
class HybridEnvelope:
    transfer_id: bytes
    header: TransportFrameHeader
    payload: bytes

    def __post_init__(self) -> None:
        if type(self.transfer_id) is not bytes or len(self.transfer_id) != 16:
            raise HybridTransportError("hybrid envelope transfer ID must be 16 bytes")
        self.header.validate()
        if type(self.payload) is not bytes or len(self.payload) != self.header.payload_length:
            raise HybridTransportError("hybrid payload length does not match its header")

    @property
    def digest(self) -> bytes:
        return hashlib.sha256(
            _ENVELOPE_DOMAIN + self.transfer_id + self.header.to_bytes() + self.payload
        ).digest()

    def to_packet(self) -> TransferPacket:
        return TransferPacket(self.header, self.payload)

    def to_bytes(self) -> bytes:
        encoded = canonical_json_bytes(
            {
                "v": HYBRID_ENVELOPE_VERSION,
                "session_id": b64url_encode(self.header.session_id),
                "transfer_id": b64url_encode(self.transfer_id),
                "sequence": self.header.frame_sequence_number,
                "header": b64url_encode(self.header.to_bytes()),
                "payload": b64url_encode(self.payload),
                "digest": b64url_encode(self.digest),
            }
        )
        if len(encoded) > MAXIMUM_ENVELOPE_BYTES:
            raise HybridTransportError("hybrid envelope exceeds its size limit")
        return encoded

    @classmethod
    def from_bytes(cls, encoded: bytes) -> HybridEnvelope:
        try:
            document = strict_json_object(encoded, maximum_bytes=MAXIMUM_ENVELOPE_BYTES)
            if set(document) != _ENVELOPE_FIELDS or document["v"] != HYBRID_ENVELOPE_VERSION:
                raise ValueError("hybrid envelope fields or version are invalid")
            session_id = b64url_decode(_strict_string(document["session_id"]), maximum_bytes=16)
            transfer_id = b64url_decode(_strict_string(document["transfer_id"]), maximum_bytes=16)
            sequence = _strict_int(document["sequence"], "sequence")
            header_bytes = b64url_decode(_strict_string(document["header"]), maximum_bytes=60)
            payload = b64url_decode(_strict_string(document["payload"]), maximum_bytes=64 * 1024)
            digest = b64url_decode(_strict_string(document["digest"]), maximum_bytes=32)
            header = TransportFrameHeader.from_bytes(header_bytes)
            envelope = cls(transfer_id=transfer_id, header=header, payload=payload)
        except (KeyError, ValueError, TypeError, HybridTransportError) as error:
            raise HybridTransportError("hybrid envelope is malformed") from error
        if (
            session_id != envelope.header.session_id
            or sequence != envelope.header.frame_sequence_number
        ):
            raise HybridTransportError("hybrid envelope metadata does not match its header")
        if not hmac.compare_digest(digest, envelope.digest):
            raise HybridTransportError("hybrid envelope digest does not match")
        if envelope.to_bytes() != encoded:
            raise HybridTransportError("hybrid envelope is not canonical")
        return envelope


class HybridPacketTransport(Protocol):
    @property
    def kind(self) -> HybridTransportKind: ...

    @property
    def channel_binding_sha256(self) -> bytes: ...

    def send(self, encoded_envelope: bytes) -> None: ...

    def receive(self) -> bytes | None: ...

    def close(self) -> None: ...


class MemoryHybridTransport:
    """Bounded deterministic adapter for tests; it performs no network I/O."""

    def __init__(
        self,
        *,
        kind: HybridTransportKind,
        channel_binding_sha256: bytes,
        maximum_queued_envelopes: int = 128,
    ) -> None:
        if maximum_queued_envelopes <= 0:
            raise ValueError("hybrid queue limit must be positive")
        if not isinstance(kind, HybridTransportKind):
            raise ValueError("hybrid transport kind is invalid")
        if type(channel_binding_sha256) is not bytes or len(channel_binding_sha256) != 32:
            raise ValueError("hybrid transport channel binding must be 32 bytes")
        self.kind = kind
        self.channel_binding_sha256 = bytes(channel_binding_sha256)
        self.maximum_queued_envelopes = maximum_queued_envelopes
        self._queue: deque[bytes] = deque()
        self._closed = False

    def send(self, encoded_envelope: bytes) -> None:
        if self._closed:
            raise HybridTransportError("hybrid transport is closed")
        if not encoded_envelope or len(encoded_envelope) > MAXIMUM_ENVELOPE_BYTES:
            raise HybridTransportError("hybrid envelope size is invalid")
        if len(self._queue) >= self.maximum_queued_envelopes:
            raise HybridTransportError("hybrid transport queue is full")
        self._queue.append(bytes(encoded_envelope))

    def receive(self) -> bytes | None:
        if self._queue:
            return self._queue.popleft()
        if self._closed:
            return None
        return None

    def close(self) -> None:
        self._closed = True


class HybridSender:
    def __init__(
        self,
        *,
        authorizer: AccessAuthorizer,
        offer: HybridOffer,
        transport: HybridPacketTransport,
    ) -> None:
        _validate_transport_binding(offer, transport)
        self.authorizer = authorizer
        self.offer = offer
        self.transport = transport

    def send_packet(self, packet: TransferPacket, *, now: int | None = None) -> None:
        self.authorizer.authorize((TRANSPORT_HYBRID_FEATURE,))
        self.offer.require_active(now=now)
        if packet.header.session_id != self.offer.session_id:
            raise HybridTransportError("packet belongs to a different hybrid session")
        self.transport.send(
            HybridEnvelope(self.offer.transfer_id, packet.header, packet.payload).to_bytes()
        )


class HybridReceiver:
    def __init__(
        self,
        *,
        authorizer: AccessAuthorizer,
        offer: HybridOffer,
        transport: HybridPacketTransport,
        limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
    ) -> None:
        _validate_transport_binding(offer, transport)
        self.authorizer = authorizer
        self.offer = offer
        self.transport = transport
        self.receiver = DynamicTransferReceiver(
            expected_session_id=offer.session_id,
            limits=limits,
        )

    @property
    def can_recover_object(self) -> bool:
        return self.receiver.can_recover_object

    def receive_once(self, *, now: int | None = None) -> TransferProgress | None:
        self.authorizer.authorize((TRANSPORT_HYBRID_FEATURE,))
        self.offer.require_active(now=now)
        encoded = self.transport.receive()
        if encoded is None:
            return None
        envelope = HybridEnvelope.from_bytes(encoded)
        if envelope.header.session_id != self.offer.session_id:
            raise HybridTransportError("envelope belongs to a different hybrid session")
        if envelope.transfer_id != self.offer.transfer_id:
            raise HybridTransportError("envelope belongs to a different hybrid transfer")
        return self.receiver.add_packet(envelope.to_packet())

    def add_optical_packet(
        self,
        packet: TransferPacket,
        *,
        now: int | None = None,
    ) -> TransferProgress:
        self.authorizer.authorize((TRANSPORT_HYBRID_FEATURE,))
        self.offer.require_active(now=now)
        return self.receiver.add_packet(packet)

    def reconstruct(self) -> bytes:
        self.authorizer.authorize((TRANSPORT_HYBRID_FEATURE,))
        return self.receiver.reconstruct()


def _strict_int(value: object, field_name: str) -> int:
    if type(value) is not int:
        raise ValueError(f"{field_name} must be an integer")
    return value


def _strict_string(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("hybrid field must be a string")
    return value


def _validate_transport_binding(
    offer: HybridOffer,
    transport: HybridPacketTransport,
) -> None:
    if transport.kind is not offer.transport:
        raise HybridTransportError("hybrid adapter kind does not match the optical offer")
    offer.require_channel_binding(transport.channel_binding_sha256)
