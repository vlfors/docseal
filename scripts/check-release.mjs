// Checks that a release tag can be published, and prints its release notes.
//   node scripts/check-release.mjs v0.1.0            checks only
//   node scripts/check-release.mjs v0.1.0 --notes    also prints the CHANGELOG section
//   node scripts/check-release.mjs v0.1.0 --dry-run  a rehearsal: an unreleased CHANGELOG section is a warning
// Every published package must have the tag's version and a repository URL (npm provenance
// links the package to it), the CLI must report that version, and CHANGELOG.md must have a
// section for it.
import { readFileSync } from "node:fs";

const PACKAGES = ["packages/core", "packages/sig-ed25519", "packages/anchor-ots", "apps/cli"];
const [tag, ...flags] = process.argv.slice(2);
const notes = flags.includes("--notes");
const dryRun = flags.includes("--dry-run");
const problems = [];
const warnings = [];
const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag ?? "")?.[1];
if (!version) {
  console.error(`usage: check-release.mjs v<major>.<minor>.<patch> [--notes] [--dry-run] (got ${String(tag)})`);
  process.exit(2);
}

for (const dir of PACKAGES) {
  const pkg = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), "utf8"));
  if (pkg.version !== version) problems.push(`${pkg.name} has version ${pkg.version}, not ${version}`);
  if (typeof pkg.repository?.url !== "string") problems.push(`${pkg.name} has no repository.url (npm provenance needs it)`);
}
const cli = readFileSync(new URL("../apps/cli/src/main.ts", import.meta.url), "utf8");
if (!cli.includes(`export const VERSION = "${version}";`)) problems.push(`apps/cli/src/main.ts does not export VERSION = "${version}"`);

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const heading = changelog.split("\n").findIndex((line) => line.startsWith(`## [${version}]`));
if (heading < 0) problems.push(`CHANGELOG.md has no "## [${version}]" section`);
else if (/unreleased/i.test(changelog.split("\n")[heading] ?? "")) (dryRun ? warnings : problems).push(`CHANGELOG.md still marks ${version} as unreleased`);

for (const warning of warnings) console.error(`! ${warning} (allowed in a dry run)`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}
if (notes) {
  const lines = changelog.split("\n");
  const end = lines.findIndex((line, i) => i > heading && line.startsWith("## "));
  console.log(lines.slice(heading + 1, end < 0 ? undefined : end).join("\n").trim());
} else {
  console.error(dryRun ? `✓ ${tag} can be rehearsed` : `✓ ${tag} is ready to publish`);
}
