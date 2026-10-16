#!/usr/bin/env node
import { Command } from "commander";
import { FORMAT_VERSION } from "@docseal/core";

const program = new Command()
  .name("docseal")
  .description("Create and verify portable proofs of document integrity, signature, and time.")
  .version(`0.0.0 (format v${String(FORMAT_VERSION)})`);

await program.parseAsync();
