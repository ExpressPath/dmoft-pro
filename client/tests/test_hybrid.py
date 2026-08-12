from __future__ import annotations

import json
from dataclasses import replace

import pytest
from dmoft.transfer import DynamicTransferGenerator

from conftest import NOW, make_verified_entitlement
from dmoft_pro_client.device import DeviceIdentity
from dmoft_pro_client.encoding import b64url_encode, canonical_json_bytes
from dmoft_pro_client.entitlement import (
    CAMERA_LIVE_FEATURE,
    TRANSPORT_HYBRID_FEATURE,
    VerifiedEntitlement,
)
from dmoft_pro_client.errors import EntitlementError, HybridTransportError
from dmoft_pro_client.hybrid import (
    HybridEnvelope,
    HybridOffer,
    HybridReceiver,
    HybridSender,
    HybridTransportKind,
    MemoryHybridTransport,
)

SESSION_ID = bytes.fromhex("102132435465768798a9bacbdcedfe0f")
BINDING = bytes.fromhex("20" * 32)


class _Authorizer:
    def __init__(self, entitlement: VerifiedEntitlement) -> None:
        self.entitlement = entitlement
        self.calls = 0

    def authorize(self, required_features: tuple[str, ...]) -> VerifiedEntitlement:
        self.calls += 1
        self.entitlement.require(required_features)
        return self.entitlement


def _offer() -> HybridOffer:
    return HybridOffer(
        session_id=SESSION_ID,
        transfer_id=bytes.fromhex("40" * 16),
        issued_at=NOW,
        expires_at=NOW + 300,
        transport=HybridTransportKind.TLS_LAN,
        endpoint="https://192.0.2.10:7443/dmoft",
        channel_binding_sha256=BINDING,
    )


def test_offer_round_trip_expiry_and_channel_binding() -> None:
    offer = _offer()

    assert HybridOffer.from_bytes(offer.to_bytes()) == offer
    offer.require_active(now=NOW)
    offer.require_channel_binding(BINDING)
    with pytest.raises(HybridTransportError, match="not currently active"):
        offer.require_active(now=NOW + 300)
    with pytest.raises(HybridTransportError, match="does not match"):
        offer.require_channel_binding(bytes(32))


@pytest.mark.parametrize(
    "changes",
    [
        {"version": 2},
        {"session_id": bytes(15)},
        {"transfer_id": bytes(15)},
        {"issued_at": True},
        {"expires_at": NOW},
        {"transport": "tls-lan"},
        {"endpoint": ""},
        {"endpoint": "http://192.0.2.10/dmoft"},
        {"endpoint": "https://user@example.test/dmoft"},
        {"channel_binding_sha256": bytes(31)},
    ],
)
def test_offer_rejects_invalid_structural_fields(changes: dict[str, object]) -> None:
    with pytest.raises(HybridTransportError):
        replace(_offer(), **changes)


def test_offer_parser_rejects_unknown_fields_and_noncanonical_json() -> None:
    document = json.loads(_offer().to_bytes())
    document["unknown"] = True
    with pytest.raises(HybridTransportError, match="malformed"):
        HybridOffer.from_bytes(canonical_json_bytes(document))
    with pytest.raises(HybridTransportError, match="not canonical"):
        HybridOffer.from_bytes(b" " + _offer().to_bytes())


def test_transport_adapter_must_expose_matching_kind_and_channel_binding(
    device: DeviceIdentity,
) -> None:
    authorizer = _Authorizer(
        make_verified_entitlement(device, features=(TRANSPORT_HYBRID_FEATURE,))
    )
    wrong_binding = MemoryHybridTransport(
        kind=HybridTransportKind.TLS_LAN,
        channel_binding_sha256=bytes(32),
    )
    with pytest.raises(HybridTransportError, match="does not match"):
        HybridSender(authorizer=authorizer, offer=_offer(), transport=wrong_binding)

    wrong_kind = MemoryHybridTransport(
        kind=HybridTransportKind.WEBRTC_DATA_CHANNEL,
        channel_binding_sha256=BINDING,
    )
    with pytest.raises(HybridTransportError, match="kind"):
        HybridSender(authorizer=authorizer, offer=_offer(), transport=wrong_kind)


def test_memory_transport_is_bounded_and_close_is_terminal() -> None:
    transport = MemoryHybridTransport(
        kind=HybridTransportKind.TLS_LAN,
        channel_binding_sha256=BINDING,
        maximum_queued_envelopes=1,
    )
    transport.send(b"first")
    with pytest.raises(HybridTransportError, match="full"):
        transport.send(b"second")
    assert transport.receive() == b"first"
    assert transport.receive() is None
    transport.close()
    assert transport.receive() is None
    with pytest.raises(HybridTransportError, match="closed"):
        transport.send(b"after-close")


def test_hybrid_sender_receiver_round_trip_and_reauthorize_each_operation(
    device: DeviceIdentity,
) -> None:
    entitlement = make_verified_entitlement(
        device,
        features=(CAMERA_LIVE_FEATURE, TRANSPORT_HYBRID_FEATURE),
    )
    sender_authorizer = _Authorizer(entitlement)
    receiver_authorizer = _Authorizer(entitlement)
    transport = MemoryHybridTransport(
        kind=HybridTransportKind.TLS_LAN,
        channel_binding_sha256=BINDING,
    )
    offer = _offer()
    sender = HybridSender(
        authorizer=sender_authorizer,
        offer=offer,
        transport=transport,
    )
    receiver = HybridReceiver(
        authorizer=receiver_authorizer,
        offer=offer,
        transport=transport,
    )
    data = b"receiver-bound encrypted object"
    packet = DynamicTransferGenerator(data, session_id=SESSION_ID).next_packet()

    sender.send_packet(packet, now=NOW + 1)
    progress = receiver.receive_once(now=NOW + 1)

    assert progress is not None and progress.object_recoverable
    assert receiver.reconstruct() == data
    assert sender_authorizer.calls == 1
    assert receiver_authorizer.calls == 2


def test_optical_and_network_duplicate_merge_is_safe(device: DeviceIdentity) -> None:
    entitlement = make_verified_entitlement(device, features=(TRANSPORT_HYBRID_FEATURE,))
    authorizer = _Authorizer(entitlement)
    transport = MemoryHybridTransport(
        kind=HybridTransportKind.TLS_LAN,
        channel_binding_sha256=BINDING,
    )
    offer = _offer()
    sender = HybridSender(
        authorizer=authorizer,
        offer=offer,
        transport=transport,
    )
    receiver = HybridReceiver(
        authorizer=authorizer,
        offer=offer,
        transport=transport,
    )
    packet = DynamicTransferGenerator(b"encrypted", session_id=SESSION_ID).next_packet()

    sender.send_packet(packet, now=NOW)
    receiver.add_optical_packet(packet, now=NOW)
    duplicate = receiver.receive_once(now=NOW)

    assert duplicate is not None and duplicate.duplicate_frame


def test_hybrid_requires_entitlement_and_rejects_tampered_envelope(
    device: DeviceIdentity,
) -> None:
    no_hybrid = _Authorizer(make_verified_entitlement(device, features=(CAMERA_LIVE_FEATURE,)))
    transport = MemoryHybridTransport(
        kind=HybridTransportKind.TLS_LAN,
        channel_binding_sha256=BINDING,
    )
    offer = _offer()
    packet = DynamicTransferGenerator(b"encrypted", session_id=SESSION_ID).next_packet()
    sender = HybridSender(
        authorizer=no_hybrid,
        offer=offer,
        transport=transport,
    )
    with pytest.raises(EntitlementError, match=r"transport\.hybrid"):
        sender.send_packet(packet, now=NOW)

    encoded = HybridEnvelope(offer.transfer_id, packet.header, packet.payload).to_bytes()
    document = json.loads(encoded)
    document["payload"] = b64url_encode(bytes([packet.payload[0] ^ 1]) + packet.payload[1:])
    tampered = canonical_json_bytes(document)
    with pytest.raises(HybridTransportError, match="digest"):
        HybridEnvelope.from_bytes(tampered)


def test_receiver_rejects_envelope_for_another_transfer(device: DeviceIdentity) -> None:
    entitlement = make_verified_entitlement(device, features=(TRANSPORT_HYBRID_FEATURE,))
    authorizer = _Authorizer(entitlement)
    transport = MemoryHybridTransport(
        kind=HybridTransportKind.TLS_LAN,
        channel_binding_sha256=BINDING,
    )
    offer = _offer()
    receiver = HybridReceiver(authorizer=authorizer, offer=offer, transport=transport)
    packet = DynamicTransferGenerator(b"encrypted", session_id=SESSION_ID).next_packet()
    transport.send(HybridEnvelope(bytes(16), packet.header, packet.payload).to_bytes())

    with pytest.raises(HybridTransportError, match="different hybrid transfer"):
        receiver.receive_once(now=NOW)
