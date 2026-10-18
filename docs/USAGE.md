# Signing and verifying documents

This guide is for people who use DocSeal: how to sign documents into a `.dseal` package, and how a recipient checks one. For the format itself, see the [specification](FORMAT-v0.1.md).

## 0. Install

```bash
npm install -g @docseal/cli      # Node.js ≥ 22
```

Until 0.1.0 is published on npm, build it from a checkout:

```bash
pnpm install && pnpm build
alias docseal="node $PWD/apps/cli/dist/index.js"
```

## 1. Create a key (once)

```bash
docseal keygen -o my.key
```

DocSeal asks for a passphrase that encrypts the key (or reads it from `DOCSEAL_PASSPHRASE`). Keep `my.key` and the passphrase secret: whoever has both can sign in your name. The output shows your public key, `did:key:z6Mk…`, which you can share freely; `docseal pubkey my.key` prints it again.

> The key file is meant for development and personal use. Hardware keys (HSM, KMS, tokens) are not supported yet.

## 2. Sign documents

Sign a file, several files, or a whole folder:

```bash
docseal seal Contract/ -k my.key -o contract.dseal --title "Supply agreement"
```

```text
Sealed 2 files into contract.dseal
Signer: did:key:z6MkrTgh…
Seal:   7fac3be8…
```

`contract.dseal` contains the documents, your signature, and a request for a timestamp. Only a hash is sent to the OpenTimestamps calendars; the documents never leave your computer.

| Option | Effect |
|---|---|
| `--role <role>` | Your role, recorded in the signature (default `author`) |
| `--title <title>` | A title stored in the package |
| `--no-anchor` | No timestamp and no network access |
| `--force` | Overwrite an existing package |

## 3. A few hours later: complete the timestamp

At first the timestamp is pending: the Bitcoin block that will confirm it has not been mined yet. After a few hours, run:

```bash
docseal upgrade contract.dseal
```

From then on the package proves that the documents existed no later than that block's time. You can send the package before upgrading, but the recipient will see that its time is not confirmed yet.

## 4. Send it

1. Send `contract.dseal` any way you like: email, messenger, USB stick.
2. Give the recipient your public key `did:key:…` **over a different channel**: in person, by phone, on your company website.

The second step matters. If the key travels with the package, whoever replaces the package can replace the key as well, and everything would still look correct. DocSeal proves that the holder of a key signed; it does not prove who that person is. The recipient makes that link by recording your key.

## 5. Recipient: verify

Once, the recipient creates `trusted-keys.json` with the keys they accept:

```json
{
  "type": "docseal-trusted-keys",
  "version": 1,
  "keys": [
    { "id": "did:key:z6MkrTgh…", "label": "Jane Smith" }
  ]
}
```

Then, for each package:

```bash
docseal verify contract.dseal --trust trusted-keys.json
```

```text
  format        valid
  integrity     valid         2 of 2 files match
  signature     valid         did:key:z6MkrTgh… (author)
  trust         trusted       Pinned key: Jane Smith
  time          …
  completeness  full
```

`--offline` checks without network access: integrity, signature, and trust are checked; time stays unconfirmed. `--json` prints the machine-readable report.

## Reading the verdict

| Verdict | Meaning | Exit code |
|---|---|---|
| **VALID** | The files are intact, signed by a trusted key, and the time is confirmed | 0 |
| **INVALID** | Something was changed or forged; a line names it, e.g. `modified agreement.txt`. Do not rely on the package | 1 |
| **INDETERMINATE** | Nothing is wrong, but not everything could be confirmed; see "Next steps" in the output | 2 |

Common reasons for INDETERMINATE:

- `Trust was not evaluated`: pass `--trust` with your `trusted-keys.json`;
- `no time proof`: the package was sealed with `--no-anchor`;
- the timestamp is still pending: the sender should run `docseal upgrade`;
- the signer's key is not in your `trusted-keys.json`: confirm it with the signer over another channel before adding it.

## What a valid package proves, and what it does not

It proves that the documents are unchanged, that they were signed by the key shown, and that the signed state existed no later than the confirmed time. It does not prove who owns the key, that the contents are true, or that the signature is legally binding.
