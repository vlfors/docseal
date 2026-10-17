# Independent Python verifier

`docseal_verify.py` is a second, independent implementation of the DocSeal v0.1 verifier. It was written from [the format specification](../../docs/FORMAT-v0.1.md), not from the TypeScript code, and both implementations must agree on every [test vector](../../spec/vectors/). Agreement shows that the specification is complete enough to implement without reading our code.

It checks format, integrity, signatures, pinned-key trust, and that an anchor is bound to the package. It does not contact Bitcoin, so a bound time proof is reported as `unsupported`.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python docseal_verify.py vectors ../../spec/vectors
.venv/bin/python docseal_verify.py verify contract.dseal --trust trusted-keys.json [--json]
```

Exit codes for `verify` match the CLI: `0` valid, `1` invalid, `2` indeterminate, `3` error.

## What it does differently on purpose

- **JSON** is parsed with `object_pairs_hook` and extra checks, because Python's `json` silently accepts duplicate keys, `NaN`, and lone surrogates.
- **ZIP** central directories are parsed by hand rather than with `zipfile`, which hides duplicate names and symlink attributes.
- **Ed25519** uses the `cryptography` package, plus a check against the eight small-order points (the same list as libsodium's `has_small_order`). OpenSSL accepts some small-order public keys, and with such a key one signature verifies every message; the shared vectors include those cases. It also checks that `A` and `R` are in the prime-order subgroup, with a few lines of curve arithmetic: OpenSSL uses the cofactorless equation and `@noble/curves` the cofactored one, and only that rule makes them agree.
- **JCS numbers** are formatted with ECMAScript rules from Python's shortest `repr`, and integers beyond 2^53 are rounded to the nearest double first.
