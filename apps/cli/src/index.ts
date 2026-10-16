#!/usr/bin/env node
import { stdin, stderr, stdout } from "node:process";
import { main } from "./main.js";

/** Reads a line from the terminal without echoing it. */
function readSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    return Promise.reject(new Error("stdin is not a terminal"));
  }
  return new Promise((resolve, reject) => {
    let value = "";
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u0003") {
          finish(new Error("Cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          const graphemes = Array.from(new Intl.Segmenter().segment(value), (part) => part.segment);
          value = graphemes.slice(0, -1).join("");
        } else {
          value += char;
        }
      }
    };
    stdin.on("data", onData);
  });
}

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => stdout.write(text),
  stderr: (text) => stderr.write(text),
  env: process.env,
  readSecret,
});
