# @docseal/mcp

`docseal-mcp`, a local [Model Context Protocol](https://modelcontextprotocol.io) server that will let AI agents verify DocSeal packages, show what they hold, and complete their time proofs; sealing only when the person running the server turns it on.

**Work in progress for v0.3.** Tools so far: `verify` (the verdict, what it does not confirm, next steps, and the full report of `docseal verify --json`) `inspect` (what a package holds, checked against nothing, offline), and `upgrade` (completes the time proof, writing `<name>.upgraded.dseal` next to the package, or over it with `overwrite`), `list_trusted_keys` (the keys from `--trust`; no tool changes them), and `seal`, only with `--allow-seal --key <file>` and `DOCSEAL_PASSPHRASE` in the server's environment: each call is confirmed by the person in a form their client shows, so it needs a client with MCP form elicitation. See [the roadmap](https://github.com/vlfors/docseal/blob/main/ROADMAP.md) and [the decisions](https://github.com/vlfors/docseal/blob/main/docs/DECISIONS.md#decided-on-2026-10-23-for-v03-mcp-server).

```bash
docseal-mcp --help
```

An MCP client starts it as a local process and talks to it over stdin and stdout; logs go to stderr. Files are reachable only under the `--root` directories, and trusted keys come only from `--trust`: nothing an agent sends can widen either.

Requires Node.js ≥ 22. Apache-2.0.
