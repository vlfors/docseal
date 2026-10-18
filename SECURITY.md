# Security Policy

## Supported versions

Until the first stable release, security fixes are released only for the latest published version.

## Reporting a vulnerability

Do not disclose a potential vulnerability in a public issue.

Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**, or open [this form](https://github.com/vlfors/docseal/security/advisories/new) directly. Only you and the maintainers can see the report. We work on the fix with you there, publish the fixed version, and then the advisory, crediting you if you wish.

If you cannot use GitHub, open a neutral issue without technical details asking to be contacted privately.

A useful report includes:

- the affected version;
- a minimal example package or input;
- expected and actual behavior;
- the potential impact;
- details of the runtime environment.

Do not attach real documents, private keys, tokens, personal data, or enterprise certificates.

## Scope of security reports

Security issues include:

- accepting a modified document as valid;
- bypassing signature, trust-policy, or timestamp verification;
- divergent results across runtimes;
- path traversal, ZIP bombs, and other attacks on the container;
- code execution or automatic plugin loading from a package;
- leakage of private keys or documents;
- algorithm or format-version downgrade;
- a misleading verdict that presents a partial verification as complete.

## Cryptographic changes

Changes to the signed payload, the Merkle scheme, canonicalization, the key format, or anchor verification require:

- test vectors;
- negative mutation tests;
- a compatibility check;
- a dedicated security review;
- an updated specification before the code is merged.

The project does not accept custom implementations of cryptographic primitives without exceptional justification and an external audit.

## Disclosure

After a fix, an advisory is published describing the impact, affected versions, the fixed version, and any required user action. Coordinated-disclosure timelines are agreed with the reporter.
