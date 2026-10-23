#!/usr/bin/env node
import { stderr, stdout } from "node:process";
import { main } from "./main.js";

const result = main(process.argv.slice(2), {
  stdout: (text) => stdout.write(text),
  stderr: (text) => stderr.write(text),
});
if (typeof result === "number") {
  process.exitCode = result;
}
