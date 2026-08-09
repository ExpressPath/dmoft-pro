# Contributing

Community protocol, interoperability, cryptographic, FEC, and file-safety changes
belong in `dmoft-community` first. Pro changes should be limited to live capture,
adaptive product integration, entitlement, billing, and explicitly documented
commercial capabilities.

Before submitting a change:

1. Run the complete checks in the affected subproject.
2. Add tests for success, malformed input, resource limits, and authorization
   failure paths.
3. Never commit `.env` files, Stripe secrets, webhook secrets, signing private
   keys, device private keys, real license tokens, or captured confidential data.
4. Keep the local camera service bound to loopback unless a separately reviewed
   authenticated transport is introduced.
5. Mark planned features as planned; do not advertise them as implemented.

Contributions are accepted under the repository's Business Source License 1.1.
