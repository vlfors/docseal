# Agent instructions

DocSeal seals documents into signed `.dseal` packages with OpenTimestamps time proofs. TypeScript monorepo: pnpm, Node.js ≥ 22, Vitest, ESLint.

## Map

- `packages/core`: format, Merkle tree, ZIP, seal, verify, upgrade. Runs in browsers: no `node:fs`, no `Buffer`.
- `packages/sig-ed25519`, `packages/anchor-ots`: the signature and anchor plugins.
- `packages/node`: Node.js glue shared by the CLI and the MCP server (files, keys, settings, `sanitize`). Private: bundled into them, never published.
- `apps/cli`: the `docseal` CLI. `apps/mcp`: the `docseal-mcp` MCP server (stdio only; nothing but protocol messages on stdout). `apps/web`: the SvelteKit static app (Svelte 5, Web Workers, en/ru strings in `src/lib/i18n`).
- `spec/`: JSON Schemas and test vectors. `docs/FORMAT-v0.1.md` is the normative format.
- `tests/`: cross-package, browser, and e2e tests. Unit tests sit next to their sources as `*.test.ts`.
- `verifiers/python`: the independent verifier.
- Settled design questions: `docs/DECISIONS.md`. Search it before proposing a design; don't reopen a decision without a new reason.

## Reading

Read only what the task needs. Search with `grep`/`rg` first, then read the matching range rather than the whole file.

Do not open unless the task is about them:

- generated output: `node_modules`, `dist`, `coverage`, `reports`, `.stryker-tmp`, `apps/web/.svelte-kit`, `apps/web/build`, `verifiers/python/.venv`;
- `pnpm-lock.yaml`: grep for the one package you need;
- `spec/vectors/packages/*.dseal`: binary golden packages; `spec/vectors/*.json` and `tests/__snapshots__`: generated;
- `docs/archive/`: superseded;
- `CHANGELOG.md` below the newest section;
- `docs/FORMAT-v0.1.md` (large): grep for the heading of the section you need.

## Running checks

Run the smallest check that covers the change, and keep the output short (`--reporter=dot`, `| tail -n 30`):

- one test file: `pnpm vitest run path/to/file.test.ts`;
- one package: `pnpm --filter @docseal/<name> typecheck`;
- before a commit: `pnpm check` (lint, typecheck, all unit tests).

Only when asked, or when the change touches what they cover: `test:e2e`, `test:browser`, `test:mcp` (the built MCP server), `coverage`, `mutation`, `fuzz`, `fuzz:differential`, `tests/large.test.ts`. WebKit e2e does not run on the maintainer's Fedora machine; CI runs it.

Never hand-edit generated files. Regenerate vectors with `pnpm vectors:update` and check them with `pnpm vectors:python`; update snapshots with `vitest -u` and review the diff.

## Changing code

- Make the smallest change that does the job; match the surrounding code; don't refactor unrelated code.
- Don't add a dependency without asking. Never implement cryptographic primitives; use `@noble/*`.
- Format v0.1 is frozen: no change may alter what a valid v0.1 package is.
- Every security fix or new rejection gets a negative test.
- Web app: a new string goes into `messages.ts`, `en.ts`, and `ru.ts`; no third-party resources (the CSP forbids them).
- Workflows: pin every action to a full commit SHA (`tests/release.test.ts` checks).
- Documentation is in English. Update the docs that describe changed behaviour, and `CHANGELOG.md` under "Unreleased" (add that section if it is missing).

## Reporting

Report the changed files, the check results, and any blockers. Don't paste whole files or diffs unless asked.
