# Contributing to DocSeal

Thank you for helping. DocSeal is verification software: a bug can make a forged document look valid, so changes are held to a high bar of tests and review. Small, focused pull requests are easiest to review.

**Security issues** go through [SECURITY.md](SECURITY.md), never a public issue.

## Setup

Requires Node.js ≥ 22, pnpm through Corepack, and Python ≥ 3.10 for the independent verifier.

```bash
corepack enable
pnpm install
python3 -m venv verifiers/python/.venv
verifiers/python/.venv/bin/pip install --require-hashes -r verifiers/python/requirements.txt
```

## Before you open a pull request

```bash
pnpm check              # lint, typecheck, all tests
pnpm vectors:python     # the Python verifier reproduces every vector
pnpm coverage           # at least 90 % of lines (currently about 97 %)
pnpm smoke              # the packed packages work when installed with npm
```

For changes to parsing or verification, also run the deeper fuzzing locally:

```bash
pnpm fuzz               # properties and robustness, 5000 cases each
pnpm fuzz:differential  # TypeScript against Python on 3000 mutated packages
```

`pnpm mutation` runs Stryker over the core (hours on a laptop); run it for larger changes to the verification logic and look at the surviving mutants in `reports/mutation/index.html`. See [docs/TESTING.md](docs/TESTING.md).

## What a change needs

- **A test for every behavior change**, and a negative test for every new rejection. A rule that can be removed without a test failing is not enforced.
- **Changes to what a package means need more.** The format is specified in [docs/FORMAT-v0.1.md](docs/FORMAT-v0.1.md), and v0.1 is frozen: a change that alters the verdict for any package belongs to the next format version, not to v0.1. Errata that make the text match the behavior both implementations already share are welcome. A change to the next format version updates, in the same pull request, the specification, the TypeScript implementation, the Python verifier in `verifiers/python/`, and the vectors in `spec/vectors/` (`pnpm vectors:update`, then review every changed file). Golden packages must rebuild byte for byte.
- **Threats**: if the change concerns an attack, add or update its row in [THREAT_MODEL.md](THREAT_MODEL.md) and the test that covers it.
- **No new cryptography.** DocSeal adapts vetted libraries (`@noble/*`, WebCrypto); it does not implement primitives. New dependencies need a reason: every one is code a verifier has to trust.
- **Plugins stay plugins.** Nothing in `@docseal/core` may name a concrete algorithm, key store, or network; see [docs/PLUGINS.md](docs/PLUGINS.md).
- **Changelog**: user-visible changes get a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).

## Style

TypeScript in strict mode, formatted like the surrounding code; ESLint (`typescript-eslint` strict, type-checked) must pass. Comments explain why, not what. Documentation is written in English. Commit messages are in the imperative mood ("Reject repeated extra blocks") and say why when it is not obvious.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), as the rest of the project.
