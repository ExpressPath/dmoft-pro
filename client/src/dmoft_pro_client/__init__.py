"""DMOFT Pro local capture client."""

from dmoft_pro_client.entitlement import (
    CAMERA_LIVE_FEATURE,
    LICENSE_AUDIENCE,
    OPTICS_ADAPTIVE_FEATURE,
    TRANSPORT_HYBRID_FEATURE,
)
from dmoft_pro_client.hybrid import HybridOffer, HybridTransportKind

__version__ = "0.2.0"

__all__ = [
    "CAMERA_LIVE_FEATURE",
    "LICENSE_AUDIENCE",
    "OPTICS_ADAPTIVE_FEATURE",
    "TRANSPORT_HYBRID_FEATURE",
    "HybridOffer",
    "HybridTransportKind",
    "__version__",
]
