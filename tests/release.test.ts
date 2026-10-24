/** Versions that must move together; the release workflow checks the same for the tag. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../apps/cli/src/main.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const PACKAGES = ["packages/core", "packages/sig-ed25519", "packages/anchor-ots", "apps/cli", "apps/mcp"];

describe("release metadata", () => {
  const manifests = PACKAGES.map((dir) => JSON.parse(read(`${dir}/package.json`)) as { name: string; version: string; publishConfig?: { exports?: unknown } });

  it("gives every published package, and the CLI, the same version", () => {
    expect(new Set(manifests.map((m) => m.version))).toEqual(new Set([VERSION]));
  });

  it("ships the MCP server with the DocSeal packages inside and their dependencies listed", () => {
    // Installed from a release URL, the tarball must not need @docseal/* from npm.
    type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const manifest = (dir: string) => JSON.parse(read(`${dir}/package.json`)) as Manifest;
    const mcp = manifest("apps/mcp");
    expect(Object.keys(mcp.dependencies ?? {}).filter((name) => name.startsWith("@docseal/"))).toEqual([]);
    const bundled = Object.keys(mcp.devDependencies ?? {}).filter((name) => name.startsWith("@docseal/"));
    expect(bundled.sort()).toEqual(["@docseal/anchor-ots", "@docseal/core", "@docseal/node", "@docseal/sig-ed25519"]);
    for (const name of bundled) {
      const dir = `packages/${name.slice("@docseal/".length)}`;
      for (const [dependency, range] of Object.entries(manifest(dir).dependencies ?? {})) {
        if (!dependency.startsWith("@docseal/")) expect(mcp.dependencies?.[dependency], `${dependency} of ${name}`).toBe(range);
      }
    }
  });

  it("has a changelog section for that version", () => {
    expect(read("CHANGELOG.md")).toMatch(new RegExp(`^## \\[${VERSION.replace(/\./g, "\\.")}\\]`, "m"));
  });

  it("pins every GitHub Action to a full commit SHA", () => {
    // A tag can be moved to other code; the release job holds publishing credentials.
    for (const workflow of ["ci.yml", "release.yml", "preview.yml"]) {
      const uses = [...read(`.github/workflows/${workflow}`).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
      expect(uses.length, workflow).toBeGreaterThan(0);
      for (const ref of uses) {
        expect(ref, workflow).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
    }
  });

  it("keeps credentials and project code in separate release jobs", () => {
    const workflow = read(".github/workflows/release.yml");
    const job = (name: string, next?: string) =>
      workflow.slice(workflow.indexOf(`\n  ${name}:`), next ? workflow.indexOf(`\n  ${next}:`) : undefined);
    const build = job("build", "publish");
    const publish = job("publish", "rehearse");
    const rehearse = job("rehearse", "pages");
    const pages = job("pages");
    // Only a pushed tag publishes; a manual run rehearses without any credentials.
    expect(publish).toContain("if: github.event_name == 'push'");
    expect(rehearse).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(rehearse).not.toMatch(/secrets\.|permissions:|environment:|registry-url|--provenance/);
    expect(rehearse).toContain("--dry-run");
    // npm reads "release/x.tgz" as the GitHub repository release/x.tgz; a tarball path needs "./".
    const tarballs = [...workflow.matchAll(/npm publish "([^"]+)"/g)].map((m) => m[1]);
    expect(tarballs).toHaveLength(2);
    for (const tarball of tarballs) {
      expect(tarball).toMatch(/^\.\//);
    }
    // The job that can publish never checks out or installs anything, and runs no package scripts.
    expect(publish).not.toMatch(/actions\/checkout|pnpm|pip install|scripts\//);
    expect(publish).toContain("--ignore-scripts");
    // npm is opt-in: a release without it still makes the GitHub release and deploys the site.
    expect(publish).toMatch(/- name: Publish to npm\n {8}if: vars\.NPM_PUBLISH == 'true'\n/);
    // The released site names its version.
    expect(build).toContain('DOCSEAL_VERSION="${TAG#v}" pnpm --filter @docseal/web build');
    // The job that runs project and dependency code gets no secrets and no write access.
    expect(build).not.toMatch(/secrets\.|permissions:|environment:/);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    // The site goes live only from a pushed tag, after the release, by a job that runs no code.
    expect(pages).toContain("if: github.event_name == 'push'");
    expect(pages).toContain("needs: publish");
    expect(pages).not.toMatch(/actions\/checkout|pnpm|run:|secrets\./);
    expect(pages).toMatch(/permissions:\n {6}pages: write\n {6}id-token: write\n {4}steps:/);
  });

  it("deploys a preview by hand only, with no credentials where code runs", () => {
    const workflow = read(".github/workflows/preview.yml");
    const build = workflow.slice(workflow.indexOf("\n  build:"), workflow.indexOf("\n  deploy:"));
    const deploy = workflow.slice(workflow.indexOf("\n  deploy:"));
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n\n/m);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow).not.toMatch(/npm publish|gh release (create|upload|edit|delete)|secrets\./);
    expect(build).not.toMatch(/permissions:|environment:/);
    expect(build).toContain('DOCSEAL_PREVIEW: "1"');
    // The preview sits beside the release, never in its place.
    expect(build).toContain("BASE_PATH: /docseal/preview\n");
    // The release's site is served only once its sums and attestation check out.
    expect(build).toMatch(/sha256sum --check --strict/);
    expect(build).toMatch(/gh attestation verify [^\n]*\\\n\s*--signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/release\.yml" --source-ref "refs\/tags\/\$tag"/);
    // Its token is used once, before any project or dependency code runs.
    expect(build.match(/GH_TOKEN/g)).toHaveLength(1);
    expect(build.indexOf("GH_TOKEN")).toBeLessThan(build.indexOf("actions/checkout"));
    expect(deploy).not.toMatch(/actions\/checkout|pnpm|run:/);
    expect(deploy).toMatch(/permissions:\n {6}pages: write\n {6}id-token: write\n {4}steps:/);
  });

  it("publishes no export that points at the sources", () => {
    for (const manifest of manifests) {
      expect(JSON.stringify(manifest.publishConfig?.exports ?? {}), manifest.name).not.toContain("src/");
    }
  });
});
