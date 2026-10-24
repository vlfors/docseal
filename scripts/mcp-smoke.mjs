// Starts an installed docseal-mcp over stdio, speaks the protocol by hand (no SDK, as a minimal
// client would), and checks that it verifies a golden package with the verdict its vector needs.
//   node scripts/mcp-smoke.mjs <docseal-mcp binary> <directory of golden packages>
import { spawn } from "node:child_process";

const [bin, root] = process.argv.slice(2);
const child = spawn(bin, ["--root", root, "--offline"], { stdio: ["pipe", "pipe", "inherit"] });
const answers = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    answers.set(message.id, message);
    if (answers.size === 2) child.stdin.end();
  }
});
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "verify", arguments: { path: "tampered-content.dseal" } } });
const code = await new Promise((resolve) => child.on("close", resolve));
const verdict = answers.get(2)?.result?.structuredContent?.verdict;
console.log(`${answers.get(1)?.result?.serverInfo?.name} ${answers.get(1)?.result?.serverInfo?.version}: tampered-content.dseal is ${verdict}`);
if (code !== 0 || verdict !== "invalid") {
  console.error("docseal-mcp did not verify the package as expected");
  process.exit(1);
}
