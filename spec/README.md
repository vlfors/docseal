# DocSeal Specification Artifacts

- `schemas/` — JSON Schemas for `manifest.json`, `statement.json`, signature envelopes, and anchor files.
- `vectors/` — language-neutral test vectors. Every implementation, including independent verifiers, must reproduce them byte for byte.

The normative text is [docs/FORMAT-v0.1.md](../docs/FORMAT-v0.1.md). Changes here follow the rules in [SECURITY.md](../SECURITY.md#cryptographic-changes): test vectors, negative tests, and a spec update before code is merged.
