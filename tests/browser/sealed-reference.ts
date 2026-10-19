/** Global setup: seals the fixed inputs in Node.js and provides the SHA-256 of the package. */
import { hash, memorySink, toHex } from "@docseal/core";
import type { TestProject } from "vitest/node";
import { sealFiles } from "../../apps/web/src/lib/seal/seal";
import { inputs, NOW, randomBytes, SECRET_KEY } from "./seal-inputs";

declare module "vitest" {
  interface ProvidedContext {
    referencePackage: string;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const sink = memorySink();
  await sealFiles(sink, { files: inputs(), secretKey: SECRET_KEY, role: "author", now: () => NOW, randomBytes: randomBytes() });
  project.provide("referencePackage", toHex(hash(sink.bytes())));
}
