# DocSeal in the browser: scenarios

This guide covers the DocSeal web app at <https://vlfors.github.io/docseal/>. It is organised by scenario, from your first signature to dealing with errors. [The CLI guide](USAGE.md) covers the same steps on the command line.

## The app at a glance

The app has three tabs at the top:

| Tab | What it is for |
|---|---|
| **Verify** | Check a `.dseal` package you received |
| **Timestamp** | A few hours after sealing, save the completed time proof into the package |
| **Seal** | Sign documents and save them as a `.dseal` package |

Documents and keys never leave your device. Only the seal digest goes out, to the OpenTimestamps calendars; the app also asks for Bitcoin block headers to check the time. Neither the digest nor the block headers reveal anything about what the documents say.

> If the top of the page says "Preview: a version for testing, not a release", use only test documents and test keys. The banner links to the released version.

---

## Scenario 1. Your first signature, with no key yet

You want to sign documents for the first time.

1. Open the **Seal** tab.
2. **Step 1, "Documents".** Click "Choose files" or "Choose a folder", or drop files onto the page. A folder adds every file in it, subfolders included, and keeps their paths. Remove a file with its cross, or all of them with "Remove all".
3. **Step 2, "Signing key".** Switch to "Create a new key", enter a passphrase twice (at least 8 characters), and click "Create and download the key".
   - The browser downloads `docseal.key`. **Keep a copy somewhere safe.** Without the file and its passphrase nobody can sign as this key, you included.
   - Below, "For the people who check your packages" shows your identifier `did:key:z6Mk…`. Copy it: the people who check your packages need it (see scenario 5).
4. **Step 3, "Seal".**
   - Choose a role: "Author", "Approver", or "Other…" (type your own role in English). The role is written into the signature.
   - Leave "Add a proof of time" on if you want to prove when the documents existed.
   - Click "Seal and save".
5. A log shows the steps in order: reading and hashing the documents, signing, each calendar's answer ("accepted" or "did not accept"), and writing the package.
6. Done: the package is saved. Chrome and Edge ask where to write it; other browsers download it. The key is closed after sealing.

Right after sealing, the package holds only a **preliminary** timestamp. Complete it a few hours later (scenario 3).

## Scenario 2. Signing with a key you already have

You already have a `docseal.key`, created in the browser or with `docseal keygen`; the browser and the CLI use the same key files.

1. **Seal** → choose the documents.
2. Under "Signing key", on "I have a key file", click "Choose a file", pick the key, enter the passphrase, and click "Open the key". Opening takes a few seconds: the passphrase is checked slowly on purpose, to resist guessing.
3. Check the "Signing as" line: it must show your `did:key`.
4. Click "Seal and save".

To seal another package, open the key again: it is closed after every sealing.

## Scenario 3. Completing the time proof, a few hours later

The OpenTimestamps calendars gather seals and write them into one Bitcoin transaction. That takes a few hours.

1. Open the **Timestamp** tab and choose the package. Or, on the Verify page, such a package has a "Complete the time proof" button that brings it here.
2. The calendars are asked at once. The page shows how far the proof has come:
   - **Sent to the calendars**, and how long ago it was sealed;
   - **Written into a Bitcoin block**, with the block number and a link to it on mempool.space;
   - **Confirmed by Bitcoin**: "N of 6 confirmations". Bitcoin adds a block about every 10 minutes.
3. If there is no completed proof yet:
   - click "Check now" later;
   - or turn on "Check every 10 min while this page is open" and leave the tab open. Nothing is checked once the tab is closed.
4. Once "A completed proof is available" appears, click **"Save the upgraded package"**. You can save it before all six confirmations are in: the package becomes fully valid once they are.
5. The saved package is checked again at once. Send **this upgraded package** to the people who check it.

If the page says "The time proof is complete. Nothing more to complete.", the package is already upgraded.

## Scenario 4. Sending the package

1. Send the `.dseal` file any way you like: email, a messenger, a USB stick.
2. Give your `did:key` **through a different channel**: in person, by phone, on your company's website. If the key travels with the package, whoever swaps the package swaps the key too, and the check will not notice.

You can send the package before scenario 3, but then the recipient sees "Time: waiting for Bitcoin" and the verdict "Indeterminate".

## Scenario 5. Recipient: the first package from a new sender

1. Open the **Verify** tab and choose the `.dseal` file, or drop it onto the page. The file is read on your device and sent nowhere.
2. Most likely the verdict is "Indeterminate", and "Next steps" says trust was not evaluated. That is expected: you have not yet told the app whom you trust.
3. **Confirm the key with the sender through another channel**: call them or ask in person whether their `did:key` matches the one shown under "Signatures".
4. Click "Add a trusted key", or open "Verification settings" → "Trusted keys". Paste the `did:key`, optionally add a name ("Jane Smith"), and click "Add".
5. The package is checked again. If the files are intact, the signature verifies, the key is trusted, and the time is confirmed, the verdict is **"Valid"**.

The list of trusted keys is kept in this browser only.

## Scenario 6. Regular checks, and moving your trusted keys

- Keys you have added are remembered: later packages from the same people are checked straight away.
- **Backup:** "Verification settings" → "Export trusted-keys.json". Clearing the site's data in the browser removes the list; the copy brings it back.
- **Another browser or computer:** click "Import trusted-keys.json" there. Keys already in the list are skipped.
- **A shared list for a team:** one person maintains `trusted-keys.json`, the others import it. The same file works with `docseal verify --trust`.

## Scenario 7. Checking offline or on a closed network

Under "Verification settings" → "Bitcoin", choose where block headers come from:

| Option | When to choose it |
|---|---|
| mempool.space, then blockstream.info | The default |
| my own Esplora server | A corporate network that blocks the public services, or you would rather not contact them. The address must be `https://…` or `http://localhost…` |
| nothing (offline) | No network at all |

Offline, integrity, signature, and trust are checked in full, but the time stays unconfirmed ("Time: not checked here"), so the verdict is "Indeterminate". The Bitcoin source is trusted for one thing only: which block is at which height. The proof itself is checked on your device.

## Scenario 8. Sealing without a proof of time

Useful when all that matters is who signed and that nothing changed, or when there is no network.

In step 3, turn off "Add a proof of time" and seal. Nothing is sent over the network. Keep in mind that **a proof of time cannot be added after sealing**: you would have to seal the documents again. The recipient sees "Time: none" and the verdict "Indeterminate".

## Scenario 9. Large files

| Browser | Verify | Seal |
|---|---|---|
| Chrome, Edge | any size | any size: the package is written straight to disk |
| Firefox | any size | up to 2 GiB: the package is built in memory |
| Safari | any size | up to 1 GiB: the package is built in memory |

If the documents are over the limit, the page refuses to seal and says why; use Chrome, Edge, or the CLI instead. Processing runs at roughly 30 to 60 MiB/s, so a package of several gigabytes takes minutes. Leave the documents alone while they are being sealed: if a file changes, no package is saved. The timings and memory measurements are in [the CLI guide](USAGE.md#size-limits).

## Scenario 10. Making sure you are on the real site

The page decides which verdict you see, so before an important check:

- the address must be exactly `https://vlfors.github.io/docseal/`;
- the footer names the release, such as "DocSeal 0.2.0", linked to [the releases page](https://github.com/vlfors/docseal/releases), and the commit; no version means it is not a release: a preview says so in a banner at the top (and lives at `/docseal/preview/`), a local build in the footer;
- for sensitive documents, open the site in a browser profile without extensions: extensions see what the page sees;
- look over your trusted keys: they are stored for all of `vlfors.github.io`;
- to depend on GitHub Pages not at all, download `docseal-web-<version>.tar.gz` from the release and serve it yourself (see [verifying a release](RELEASING.md#verifying-a-release)).

---

## Reading the result

| Verdict | Meaning | What to do |
|---|---|---|
| **Valid** | The files are intact, signed by a trusted key, and the time is confirmed | Nothing |
| **Invalid** | The package was modified, or a proof in it is false | **Do not trust it.** "Files with problems" shows which file is modified, missing, or extra |
| **Indeterminate** | Nothing is wrong, but not everything could be confirmed | See "Next steps"; common causes are below |

The line "Unchanged, and the signature verifies" means the documents themselves are fine. Below it is a list of what is not yet confirmed: who owns the key, when the documents existed, and so on.

## When something goes wrong

| Message | Cause and what to do |
|---|---|
| "Trust: not evaluated" or "Trust: unknown" | The sender's key is not among your trusted keys. Confirm it with the sender and add it (scenario 5) |
| "Time: waiting for Bitcoin", "The time proof is not complete yet" | The sender has not completed the time proof. The recipient can complete it too, on the Timestamp tab (scenario 3) |
| "Time: none" | The package was sealed without a proof of time (scenario 8) |
| "Time: not checked here" | Bitcoin checking is off, or the source did not answer. Choose another source (scenario 7) |
| "Wrong passphrase, or the key file is damaged." | Check the keyboard layout and Caps Lock. A forgotten passphrase cannot be recovered: create a new key and send out the new `did:key` |
| "Fewer than two calendars accepted the seal…" | The calendars cannot be reached. Try later, or seal without a proof of time |
| "A document changed or became unreadable while it was being sealed" | A file was edited or moved during sealing. Choose the documents again |
| "N path(s) cannot be sealed" | Two files with the same name ignoring case, a duplicate, or a file where a folder should be. Rename or remove them |
| "No completed proof yet." | Bitcoin has not confirmed the seal yet, or a calendar cannot be reached from the browser. Wait and check again |
| Lost key file | It can no longer sign. Create a new key and give the people who check your packages the new `did:key`; old packages still verify |
| The key may be in someone else's hands | Stop using it. Ask the people who check your packages to remove the old `did:key` from their trusted keys and add the new one |

## What DocSeal proves, and what it does not

A valid package proves three things: the documents are unchanged, the key shown signed them, and the signed state existed no later than the confirmed time. It does **not** prove who owns the key (you establish that when you confirm the `did:key`), that what the documents say is true, or that the signature has legal force.
