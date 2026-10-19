# Testing

DocSeal is verification software: its job is to say "no" correctly. Besides unit tests, it is tested in four ways that look for inputs nobody thought of.

| Kind | Where | What it checks | Run |
|---|---|---|---|
| Unit and end-to-end tests | `packages/*/src/*.test.ts`, `tests/*.test.ts` | Each rule of the format, every threat-model row, the CLI | `pnpm test` |
| Shared test vectors | [`spec/vectors/`](../spec/vectors/) | Byte-exact results that every implementation must reproduce | `pnpm test`, `pnpm vectors:python` |
| Property tests | `tests/properties.test.ts` | Invariants over generated inputs | `pnpm test`, deeper: `pnpm fuzz` |
| Robustness fuzzing | `tests/fuzz.test.ts` | Hostile input only ever produces the parser's own error | `pnpm test`, deeper: `pnpm fuzz` |
| Differential fuzzing | `tests/differential.test.ts` | The TypeScript and Python verifiers agree on every mutated package | `pnpm fuzz:differential` |
| Mutation testing | `stryker.config.json` | The tests notice when the code is changed | `pnpm mutation` |
| Browser engines | `**/*.browser.test.ts` | The golden packages get their verdicts in Chromium, Firefox, and WebKit; verification in a Web Worker | `pnpm test:browser` |
| The built site | `tests/e2e/*.e2e.test.ts` | The verify page shows each golden package's verdicts and reasons; package text cannot disguise itself; trusted keys; the seal page collects a folder as the CLI does; no CSP violations | `pnpm test:e2e` |

`FUZZ_RUNS` sets the number of generated cases per property (defaults: 100 for properties, 200 for robustness, 300 for differential); `FUZZ_SEED` fixes the seed of the differential run so a failure can be reproduced.

## Browser engines

The web app runs the same packages in the browser, where the platform differs from Node.js in what decides a verdict: the `DecompressionStream` that inflates entries, and files read as `Blob` slices. `vitest.browser.config.ts` runs `tests/browser/` in Chromium, Firefox, and WebKit through Playwright. Every golden package must get the verdicts in `spec/vectors/packages/expected.json`, read from memory and from a `Blob`, and again with a `DecompressionStream` that ignores bytes after the end of a deflate stream, so the fallback check gives the same verdicts. `apps/web/src/**/*.browser.test.ts` run the web app's Web Workers in the same engines: a package verifies in a worker while a timer on the page shows the page's thread stays free, progress arrives, and cancelling stops the work. CI runs all three engines on every push.

```bash
pnpm exec playwright install chromium firefox webkit
pnpm test:browser                       # all three engines
DOCSEAL_BENCHMARK=1 pnpm test:browser   # also hash 1 GiB in each engine
DOCSEAL_LARGE_TESTS=1 pnpm test:browser --project chromium apps/web   # a 2 GiB package in a worker
```

`pnpm test:e2e` builds the site and serves `apps/web/build` as static files, as GitHub Pages does, so the page's `<meta>` policy is the only one; Playwright drives it from Node.js. In each engine every golden package must show the verdicts its vector requires, an invalid one must show its issues, a file name with a bidirectional override must show the override as a code (`U+202E`), trusted keys must be added, imported, exported, and kept across pages, and the page must refuse to work inside a frame. On the seal page a chosen folder must give the package paths `collectFiles` of the CLI gives, and a path the core would reject must be marked before sealing. A CSP violation fails the run, with one exception: WebKit does not apply `'unsafe-hashes'` to style attributes and refuses the inline style of SvelteKit's route announcer, which `app.css` hides anyway; the test then checks that no other element has an inline style. `DOCSEAL_E2E_BROWSERS=chromium,firefox` limits the engines.

Playwright's WebKit build needs the libraries of Ubuntu 24.04. On another Linux, run it in Playwright's image:

```bash
podman run --rm -v "$PWD":/work:Z -w /work mcr.microsoft.com/playwright:v1.64.1-noble \
  npx vitest run --config vitest.browser.config.ts --project webkit
podman run --rm -e DOCSEAL_E2E_BROWSERS=webkit -v "$PWD":/work:Z -w /work mcr.microsoft.com/playwright:v1.64.1-noble \
  npx vitest run --config vitest.e2e.config.ts   # after pnpm --filter @docseal/web build
```

Measured on 2026-10-19 (Playwright 1.64.1, headless, one x86-64 laptop; WebKit in the container):

| Engine | `DecompressionStream` and bytes after the end | Streaming SHA-256 of 1 GiB from a `Blob` |
|---|---|---|
| Chromium | rejects them | 24.5 s, 42 MiB/s |
| Firefox | rejects them | 37.1 s, 28 MiB/s |
| WebKit | rejects them | 16.3 s, 63 MiB/s |

All three engines follow the Compression Streams standard, so the fallback check runs only on Node.js 22 and in the test that forces it. Hashing uses the portable SHA-256 of `@noble/hashes`, since Web Crypto has no incremental digest; at these speeds a 2 GiB package takes half a minute to over a minute to verify.

## Property tests

Each property states something the specification promises for every input:

- JCS is idempotent and independent of key order; any repeated key is rejected wherever it is.
- Hex and base64url round-trip, and decoding is canonical: a string that decodes is the only encoding of its bytes.
- `normalizePath` either rejects a path or returns a valid, stable NFC path; `comparePaths` orders by UTF-8 bytes; paths equal under case mapping collide.
- The Merkle root matches an independent RFC 6962 implementation for any number of leaves and changes when any leaf changes, is added, or is removed.
- CRC-32 continues across any split of the data.
- A timestamp is accepted exactly when it names a real UTC date and time, checked against an independent reference.
- Any container round-trips through the writer and the reader, with or without ZIP64 fields.

## Robustness fuzzing

Mutated packages (see below), arbitrary bytes, and edited JSON, `.ots` proofs, key files, trusted-keys files, and `did:key` strings. The parsers may only throw their own error type (`FormatError`, `OtsError`, `KeyFileError`); `verify` never throws and always returns a report whose overall verdict follows from its axes, and a failed format check leaves every other axis unevaluated.

## Differential fuzzing

`tests/mutations.ts` mutates valid golden packages in three ways:

- **bytes:** flips, insertions, deletions, truncation;
- **ZIP structure:** a header field (size, offset, count, length, flags) set to a boundary value or moved by one;
- **meaning:** a member of a JSON document replaced, deleted, or added, with values close to what the format expects; documents edited, added, removed, or renamed; signatures and anchor files dropped, duplicated, or renamed. The container is repacked correctly, so these reach the verification logic instead of stopping at a CRC check.

Each mutated package is verified by the TypeScript verifier and by the independent Python verifier (`docseal_verify.py batch`), and both must give the same verdict on every axis. A disagreement is a bug in one of them or a gap in the specification. CI runs 2000 packages with a new seed on every push.

What it has found so far, each now fixed in both implementations, covered by a vector, and stated in the specification:

1. **Ed25519 verification equation.** `@noble/curves` checks the cofactored equation, OpenSSL the cofactorless one; a point of order 8 in `R` or in the public key made a signature valid for one verifier only. `A` and `R` must now be in the prime-order subgroup.
2. **Path collisions after case mapping.** `ß́a` and `SŚA` collide on case-insensitive file systems, but uppercasing gives `SS◌́A` before composition. Case-mapped paths are normalized to NFC again before comparing (found by a property test).
3. **Unfinished deflate streams and bytes after the end.** Python's `zlib` accepted a stream that never reaches its final block; `fflate` silently ignored bytes after the end of the stream. Deflate data must be exactly one complete stream; TypeScript now inflates with `DecompressionStream`, which rejects both.
4. **Order of checks.** With an unsupported manifest version and a damaged document, one verifier answered `unsupported` and the other `invalid`. `invalid` now outranks `unsupported`, whatever the order of checks.

## Mutation testing

[Stryker](https://stryker-mutator.io/) changes the code under test in small ways (a `<` becomes `<=`, a condition becomes `true`, a block is emptied) and runs the tests against each change, called a mutant. A mutant that no test notices shows code whose behavior is not pinned down.

It mutates the core, the Ed25519 suite, and the OpenTimestamps parser, and uses Stryker's command runner with `vitest.stryker.config.ts`, which leaves out the slow differential test and points the workspace packages at the mutated sources. (The Vitest runner plugin does not switch mutants on with Vitest 5.) A full run takes about three and a half hours on eight cores; the HTML report is written to `reports/mutation/index.html`.

<!-- results -->
### Results

The first full run (3437 mutants in the core, the Ed25519 suite, and the OpenTimestamps parser) scored 90.1 %: 339 mutants survived. They showed real gaps, now covered:

- the integrity checks that `manifest.packageId` and the Merkle root of the manifest match the statement could be removed unnoticed: no package had a validly signed but inconsistent statement (new vectors `package-id-mismatch`, `merkle-root-mismatch`);
- likewise the handling of an unparseable anchor file, of a non-canonical base64url signature value, and the sorting of envelope digests in the anchor, which only matters with two or more signers (new vectors `anchor-malformed`, `two-anchor-files`, `signature-noncanonical-base64url`, `valid-two-signers-pending-anchor`);
- the field checks of the signature envelope and the anchor file were barely tested: a table test now changes every field of every document and checks the verdict and the field named in the error, including array values that a regular expression would read as strings;
- issue codes and messages were never compared: `tests/reports.test.ts` pins the full report of every golden package;
- boundary values: OpenTimestamps limits (4096 bytes, nesting 256, 10 000 nodes, 4 MiB), a maximal ZIP archive comment and a fake end record inside it, the 64 MiB central directory limit, a size of exactly `0xFFFFFFFF`, JSON nesting 64;
- the writer's output was not pinned: every golden package must now rebuild byte for byte. This found eight packages from the first publication written by an earlier writer; all vectors were regenerated (same contents and verdicts).

Re-running the survivors against the new tests leaves six, all equivalent or cosmetic: three error message texts of the OpenTimestamps parser, a redundant `typeof` before `Number.isSafeInteger`, an anchored regular expression applied to a string of fixed length, and the byte order of a field that is checked only for zero. Combined score: 99.8 %. Stryker counts a mutant that makes the suite time out as detected; almost a third of the detected mutants are timeouts, mostly loops in the ZIP and OpenTimestamps parsers that no longer end.
