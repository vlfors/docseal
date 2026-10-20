# Releasing

All packages are released together, with one version, by pushing a tag. The workflow [`release.yml`](../.github/workflows/release.yml) does the rest: it runs every check, packs the tarballs once, attests them (GitHub build provenance), publishes them to npm with npm provenance, and creates a GitHub release with the tarballs, their `SHA256SUMS`, and the notes from `CHANGELOG.md`.

## How the workflow is protected

- **Credentials never meet project or dependency code.** The `build` job installs, checks, builds, and packs, with read-only permissions and no secrets. The `publish` job holds the npm credentials, the OIDC token, and write access; it checks out nothing and installs nothing. It downloads the tarballs, checks them against `SHA256SUMS`, attests them, and publishes them with `--ignore-scripts`. A compromised dependency can still change what `build` packs, which is what reviewing dependency updates and `pnpm-lock.yaml` is for, but it cannot reach the token or publish anything else.
- **Pinned actions.** Every action is pinned to a full commit SHA, with its version in a comment: a tag can be moved to other code. `tests/release.test.ts` fails on an unpinned `uses:`.
- **Pinned dependencies.** `pnpm install --frozen-lockfile` for JavaScript; `pip install --require-hashes -r verifiers/python/requirements.txt` for the Python verifier.
- **Updates.** Dependabot proposes updates to actions and Python dependencies. Read the diff of an action or the changelog of a package before merging one.
- **Who can release.** Only maintainers can create `v*` tags, and every publish waits for approval (step 3 below).

## Once, before the first release

1. **Repository.** The project lives at [github.com/vlfors/docseal](https://github.com/vlfors/docseal). Each published `package.json` names it in `repository`, with `directory` set to the package's folder; npm provenance links each package to it, and `scripts/check-release.mjs` refuses a release without it.
2. **npm.** Create the `docseal` organization on npmjs.com. For each package, configure *trusted publishing* for the GitHub repository, workflow `release.yml`, and environment `npm` — then no token is stored anywhere. Until that is configured (it needs the package to exist), add an automation token as the `NPM_TOKEN` secret of the `npm` environment and remove it afterwards.
3. **GitHub.** *Configured on 2026-10-18; kept here in case it must be redone.*
   - Create the environment `npm` (Settings → Environments) with a **required reviewer**, so a pushed tag waits for approval before anything is published, and **deployment branches and tags** restricted to the tag pattern `v*`.
   - Add a tag ruleset (Settings → Rules → Rulesets) for `refs/tags/v*` that restricts creation, update, and deletion to maintainers: otherwise anyone who can push can start a release, and a published tag could be moved.
   - Protect `main` with required CI checks.
   - Enable private vulnerability reporting (see [SECURITY.md](../SECURITY.md)).
4. **GitHub Pages**, for the web app. Settings → Pages → Build and deployment → Source: **GitHub Actions**. Then, in Settings → Environments → `github-pages`, restrict **deployment branches and tags** to the tag pattern `v*`, so only a release can change the site. The `pages` job of `release.yml` deploys after the `npm` approval; the site is served at `https://vlfors.github.io/docseal/`. On `vlfors.github.io` it shares an origin with every other Pages site of the account (see THREAT_MODEL.md, "The browser app"); a custom domain gives it its own: set it in Settings → Pages and build with `BASE_PATH` empty.

## Each release

1. Update `version` in the four published `package.json` files and `VERSION` in `apps/cli/src/main.ts`.
2. In `CHANGELOG.md`, turn "Unreleased" into the version and date: `## [0.1.0] — 2026-10-20`.
3. Check locally, then commit:

   ```bash
   node scripts/check-release.mjs v0.1.0
   pnpm check && pnpm vectors:python && pnpm smoke
   ```
4. Rehearse: Actions → Release → Run workflow (on `main`). It runs the whole build for the version in `package.json`, hands the tarballs over, checks `SHA256SUMS`, and runs `npm publish --dry-run` without any credentials; nothing is published, attested, or released. An unreleased CHANGELOG section is only a warning there.
5. Tag and push: `git tag -s v0.1.0 -m "DocSeal 0.1.0" && git push origin main v0.1.0`.
6. Approve the `npm` environment when the checks have passed.

## Verifying a release

```bash
npm audit signatures                     # in a project that installed @docseal/*: npm provenance
gh attestation verify docseal-core-0.1.0.tgz --repo vlfors/docseal
gh attestation verify docseal-web-0.1.0.tar.gz --repo vlfors/docseal
sha256sum -c SHA256SUMS                  # next to the tarballs from the GitHub release
```

The web app's footer names the commit it was built from; it must be the commit of the release tag. To use exactly the attested site instead of the hosted one, serve the release's archive yourself. It is built for the path `/docseal/`:

```bash
mkdir -p site/docseal && tar -xzf docseal-web-0.1.0.tar.gz -C site/docseal
python3 -m http.server --bind 127.0.0.1 --directory site 8000   # then open http://127.0.0.1:8000/docseal/
```
