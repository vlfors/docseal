// Replaces one document inside a .dseal package and writes it back as a well-formed
// container, the way an attacker would: the result must fail verification on integrity.
//   node examples/tamper.mjs <in.dseal> <out.dseal> <path inside files/> <new text>
import { readFileSync, writeFileSync } from "node:fs";
import { readContainer, utf8, writeContainer } from "@docseal/core";

const [input, output, path, text] = process.argv.slice(2);
if (!input || !output || !path || text === undefined) {
  console.error("usage: tamper.mjs <in.dseal> <out.dseal> <path> <new text>");
  process.exit(3);
}
const contents = await readContainer(new Uint8Array(readFileSync(input)));
if (!contents.files.has(path)) {
  console.error(`no document ${path} in ${input}`);
  process.exit(3);
}
contents.files.set(path, utf8(text));
writeFileSync(output, await writeContainer(contents));
