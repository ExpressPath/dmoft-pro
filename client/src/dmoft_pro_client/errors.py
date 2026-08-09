"""Expected error hierarchy for the DMOFT Pro client."""


class ProClientError(Exception):
    """Base class for errors safe to present to a local user."""


class DeviceIdentityError(ProClientError):
    """The per-install device identity could not be created or loaded."""


class EntitlementError(ProClientError):
    """A license token is invalid, expired, or insufficient."""


class ActivationError(ProClientError):
    """The activation service request or response failed."""


class CameraError(ProClientError):
    """The camera could not be safely opened or read."""


class LocalApiError(ProClientError):
    """The localhost-only API configuration is unsafe or invalid."""
