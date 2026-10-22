# Signing and verifying documents

This guide is for people who use DocSeal: how to sign documents into a `.dseal` package, and how a recipient checks one. For the format itself, see the [specification](FORMAT-v0.1.md).

## 0. Install

```bash
npm install -g @docseal/cli      # Node.js ≥ 22
```

Until 0.2.0 is published on npm, build it from a checkout:

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

To check the time, DocSeal reads Bitcoin block headers from mempool.space, or from blockstream.info if mempool.space does not answer. If neither is reachable from your network, name another Esplora source, for example your own: `--chain https://your-node.example/api` (repeat `--chain` for fallbacks).

## In the browser

The DocSeal web app does the same in a browser: the Verify page checks a package, the Timestamp page completes a package's time proof, the Seal page signs documents and saves the package. Files and keys never leave the device; the page sends only the seal digest to the timestamp calendars and asks a Bitcoin source for block headers. [The web app guide](WEB.md) walks through it scenario by scenario.

- **Verify:** drop a `.dseal` on the page. Under *Verification settings*, add the keys you trust in *Trusted keys* (or import your `trusted-keys.json`); the list is kept in this browser only. Under *Bitcoin*, choose where block headers come from (mempool.space then blockstream.info, your own Esplora server, or offline). A package whose time proof is still pending, as every package is right after sealing, is marked *The time proof is not complete yet*; its *Complete the time proof* button takes the package to the Timestamp page.
- **Timestamp:** choose a package, or arrive from the Verify page with it; the calendars are asked at once. The time proof shows how far it has come: sent to the calendars, written into a Bitcoin block (with a link to it on mempool.space), and its confirmations out of the 6 required. *Check now* asks the calendars and the Bitcoin source again; *Check every 10 min while this page is open* repeats that (nothing runs once the page is closed). When a calendar has the completed proof, *Save the upgraded package*; the saved package is verified again at once.
- **Seal:** choose files or a folder (a folder adds its contents, as `docseal seal <folder>` does), open your key file with its passphrase or create a new key, and *Seal and save*. A log shows each step as it happens: hashing the documents, signing, each calendar's answer to the seal, and writing the package. A new key is downloaded at once as `docseal.key`; keep it, it opens in the CLI too. The key is closed after each sealing.

### Checking that you are on the real site

The page you use decides what you see, so check it before you rely on a verdict:

- The address is `https://vlfors.github.io/docseal/`, nothing else.
- The footer names the commit the site was built from. It must be the commit of a release tag on [the releases page](https://github.com/vlfors/docseal/releases); a page that says "A local build" is not a release.
- To depend on GitHub Pages not at all, download `docseal-web-<version>.tar.gz` from the release, check its attestation, and serve it yourself (see [verifying a release](RELEASING.md#verifying-a-release)).
- Browser extensions with access to the page can read what the page reads. Use a profile without them for sensitive documents.
- The trusted keys you add are stored for the address `vlfors.github.io`, which every GitHub Pages site of the account shares: look over the list before you rely on a `trusted` verdict.

### Size limits

Measured on 2026-10-20 with Playwright 1.64.1 (Chromium, Firefox, and WebKit on Linux; real Safari may differ):

| Browser | Verify | Seal |
|---|---|---|
| Chrome, Edge | any size; a 4.06 GiB package (ZIP64) in 151 s, 0.69 GiB of browser memory | any size: written straight to the file you pick; 4.06 GiB in 157 s, 1.18 GiB of memory |
| Firefox | any size; 4.06 GiB in 170 s, 0.97 GiB of memory | up to 2 GiB: the package is built in memory, then downloaded (3 GiB was measured to work) |
| Safari | any size; 4.06 GiB in 108 s, 0.63 GiB of memory (WebKit) | up to 1 GiB, built in memory (WebKit built 1.5 GiB, and its tab crashed at 2 GiB) |

Above its limit the page refuses to seal and says why; for larger packages use Chrome or Edge, or the CLI. Verifying and sealing read documents at roughly 30 to 60 MiB/s, so a package of several gigabytes takes minutes.

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
