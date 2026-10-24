# DocSeal for AI agents: the MCP server

`docseal-mcp` lets an AI agent check DocSeal packages for you: whether the documents are unchanged, who signed them, and when they existed. It is a [Model Context Protocol](https://modelcontextprotocol.io) server, so any MCP client can use it: Claude Code, Claude Desktop, Cursor, Hermes Agent, and others. It runs on your computer, started by the client; documents never leave it.

The server checks; the agent reports. What the agent may do is set by you, in the server's configuration, not by the agent: which directories it can read, which signers you trust, and whether it may sign at all.

## Install

Node.js 22 or later. The server is a single package on the GitHub release:

```bash
npm install -g https://github.com/vlfors/docseal/releases/download/v0.3.0/docseal-mcp-0.3.0.tgz
docseal-mcp --version
```

To check what you installed: the release lists the tarball in `SHA256SUMS`, and `gh attestation verify docseal-mcp-0.3.0.tgz --repo vlfors/docseal` checks that GitHub Actions built it from this repository (see [verifying a release](RELEASING.md#verifying-a-release)).

## Tools

| Tool | What it does | Network |
|---|---|---|
| `verify` | The verdict (valid, invalid, indeterminate), what it does not confirm, next steps, and the full report of `docseal verify --json` | Bitcoin block headers, unless `--offline` |
| `inspect` | What a package holds: files and sizes, signers and roles, how far its time proof has come. Checks nothing | None |
| `upgrade` | Completes a pending time proof a few hours after sealing; writes `<name>.upgraded.dseal` next to the package, or over it with `overwrite` | The seal's digest to the calendars; block headers |
| `list_trusted_keys` | The signers in your trusted-keys file | None |
| `seal` | Signs files into a new package, after you confirm in a form. Only with `--allow-seal` | The seal's digest to the calendars, unless `anchor: false` |

There is also a prompt, `check-package`, and a skill (below) that teaches an agent to read the results.

What goes over the network is the same as for the CLI: the seal's digest (a hash, which reveals nothing about the documents) to the OpenTimestamps calendars, and requests for Bitcoin block headers to mempool.space, then blockstream.info, or the source you name with `--chain`.

## Options

The client starts the server with the options you put in its configuration:

| Option | Meaning |
|---|---|
| `--root <dir>` | A directory the tools may read and write in. Repeat for more. Without one, the tools can open no file. Give the narrowest directories that hold your packages, not your home directory |
| `--trust <file>` | Your `trusted-keys.json`. Without it, trust is not evaluated and no package is valid. Must not be inside a `--root` |
| `--chain <url>` | An Esplora API for Bitcoin block headers, instead of mempool.space and blockstream.info. Repeat for fallbacks |
| `--offline` | No Bitcoin source: time proofs stay unconfirmed |
| `--allow-seal --key <file>` | Offer `seal`, signing with this key file. Must not be inside a `--root`. The passphrase comes from `DOCSEAL_PASSPHRASE` in the server's environment |

The server refuses to start with a missing root, a key or trust file inside a root, or a wrong passphrase, and says why on stderr.

## Clients

Paths below are examples: use your own, absolute. Each block was checked against the client's documentation on 2026-10-24.

### Claude Code

```bash
claude mcp add --transport stdio --scope user docseal -- \
  docseal-mcp --root ~/Documents/contracts --trust ~/.config/docseal/trusted-keys.json
```

Then ask: "Check contract.dseal". The prompt runs as `/mcp__docseal__check-package contract.dseal`. Claude Code shows confirmation forms in interactive sessions only, so `seal` does not work in `claude -p`.

### Claude Desktop

Settings → Developer → Edit Config opens `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`). Claude Desktop starts servers without your shell's `PATH`, so give the full path that `which docseal-mcp` prints:

```json
{
  "mcpServers": {
    "docseal": {
      "command": "/usr/local/bin/docseal-mcp",
      "args": ["--root", "/Users/you/Documents/contracts", "--trust", "/Users/you/.config/docseal/trusted-keys.json"]
    }
  }
}
```

Restart Claude Desktop afterwards. No support for confirmation forms was found in Claude Desktop, so `seal` cannot work there; the other tools do.

### Cursor

`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "docseal": {
      "command": "docseal-mcp",
      "args": ["--root", "${userHome}/Documents/contracts", "--trust", "${userHome}/.config/docseal/trusted-keys.json"]
    }
  }
}
```

### Hermes Agent

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  docseal:
    command: "docseal-mcp"
    args: ["--root", "/home/you/Documents/contracts", "--trust", "/home/you/.config/docseal/trusted-keys.json"]
```

`hermes mcp test docseal` checks the connection. Hermes shows confirmation forms (`elicitation`, on by default) as an approval prompt, so `seal` works there once enabled.

## The skill

`skills/docseal/SKILL.md` in the installed package teaches an agent to report a verdict without making it sound stronger. Copy the folder where your client looks for skills:

```bash
SKILL="$(npm root -g)/@docseal/mcp/skills/docseal"
cp -r "$SKILL" ~/.claude/skills/      # Claude Code
cp -r "$SKILL" ~/.hermes/skills/      # Hermes Agent
```

Without it, the server's instructions, sent when a client connects, say the essentials in one paragraph.

## Reading what the agent tells you

- **Valid**: the files are unchanged, signed by a key you trust, and existed no later than the time Bitcoin confirms.
- **Invalid**: do not rely on the package; the agent should name the files that changed.
- **Indeterminate**: nothing is wrong, but something is not confirmed, and the agent must say what: usually who owns the key (add it to your trusted keys once you have confirmed it with the signer through another channel) or when the files existed (call `upgrade` in a few hours).

A trusted key is a key you put in your trusted-keys file, and only you can: no tool adds, removes, or changes one, so nothing the agent reads can talk it into trusting an attacker. Package text (file names, titles, roles) was written by whoever made the package; the server passes it on only as data, with hidden characters made visible, and the agent should flag text that reads like an instruction.

DocSeal does not prove who owns a key, that the documents are true, or that a signature has legal force.

## Sealing

`seal` is off unless you start the server with `--allow-seal --key <file>` and put `DOCSEAL_PASSPHRASE` in the server's environment. Each call shows you a form, in the client, with the files, their sizes, the role, the title, the signer, and where the package goes. Nothing is signed unless you confirm; your client must support MCP form elicitation.

Before you turn it on:

- **Agents with their own file or shell tools** (Claude Code, Cursor, and most coding agents) can read the key file and the client's configuration that holds the passphrase, or run `docseal seal` themselves. The server cannot stop that. Turn sealing on only for an agent without such tools, or keep the key and the configuration where the client's own permissions deny the agent.
- The passphrase sits in plain text in the client's configuration. The key file is for development, as in the CLI.
- A client set up to answer forms by itself (an auto-approve hook) signs without asking you.

Hermes Agent passes the server only the environment you list:

```yaml
mcp_servers:
  docseal:
    command: "docseal-mcp"
    args: ["--root", "/home/you/Documents/to-sign", "--trust", "/home/you/.config/docseal/trusted-keys.json",
           "--allow-seal", "--key", "/home/you/.config/docseal/me.key"]
    env:
      DOCSEAL_PASSPHRASE: "your passphrase"
```

The full list of threats and what answers each is in [THREAT_MODEL.md](../THREAT_MODEL.md#the-mcp-server).

## When something goes wrong

| What you see | Cause |
|---|---|
| "No file access: the server was started without --root" | Add `--root` with the directory that holds the packages |
| "… is outside the directories this server may read (--root)" | The package is elsewhere, or reached through a link that leads out |
| "--key … is inside --root …" | Move the key, or the trusted-keys file, out of the directories the agent reaches |
| "set DOCSEAL_PASSPHRASE in the server's environment" | Sealing is on but the passphrase is missing from the client's server entry |
| "this client cannot show the person a confirmation form" | The client does not support form elicitation: seal in a terminal with `docseal seal` |
| The client lists no tools | Run `docseal-mcp` with the same options in a terminal: a configuration error is printed on stderr and the server exits. Clients keep that output in their MCP log |
