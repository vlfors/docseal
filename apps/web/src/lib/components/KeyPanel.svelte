<script lang="ts">
  // The signing key: a key file opened with its passphrase, or a new key, made and downloaded at
  // once. Either way the secret key stays in its worker; the page holds only `key`.
  import { saveBytes } from "../download";
  import { t } from "../i18n/state.svelte";
  import { checkNewPassphrase, generateKey, KeyError, openKey, type KeyTask, type OpenKey } from "../signer/client";
  import { shortId } from "../text";
  import PackageText from "./PackageText.svelte";

  let { key = $bindable() }: { key?: OpenKey | undefined } = $props();

  /** A key file has a few hundred bytes; anything much larger is not one. */
  const MAX_KEY_FILE_SIZE = 64 * 1024;

  let mode = $state<"open" | "new">("open");
  let keyFileInput: HTMLInputElement | undefined = $state();
  let keyFileName = $state("");
  let passphrase = $state("");
  let repeated = $state("");
  let share = $state<number | undefined>();
  let error = $state("");
  let created = $state(false);
  let task: KeyTask | undefined;

  const shareEntry = $derived(
    key ? JSON.stringify({ type: "docseal-trusted-keys", version: 1, keys: [{ id: key.did, label: "Your name" }] }, null, 2) : "",
  );

  async function run(start: () => KeyTask) {
    error = "";
    share = 0;
    task = start();
    try {
      key = await task.result;
      passphrase = "";
      repeated = "";
    } catch (failure) {
      if (failure instanceof KeyError) {
        if (failure.reason !== "cancelled") {
          error = failure.reason === "passphrase" ? t().key.wrongPassphrase : failure.reason === "file" ? t().key.notKeyFile(failure.message) : failure.message;
        }
      } else {
        throw failure;
      }
    } finally {
      share = undefined;
      task = undefined;
    }
  }

  async function open(event: SubmitEvent) {
    event.preventDefault();
    const file = keyFileInput?.files?.[0];
    if (!file) {
      return;
    }
    if (file.size > MAX_KEY_FILE_SIZE) {
      error = t().key.notKeyFile(`${String(file.size)} bytes`);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    created = false;
    await run(() =>
      openKey(bytes, passphrase, (value) => {
        share = value;
      }),
    );
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    const problem = checkNewPassphrase(passphrase, repeated);
    if (problem) {
      error = t().key[problem];
      return;
    }
    await run(() =>
      generateKey(passphrase, (value) => {
        share = value;
      }),
    );
    if (key?.keyFile) {
      // Saved at once: the page keeps no copy of the encrypted key either.
      saveBytes(key.keyFile, "docseal.key", "application/json");
      created = true;
    }
  }

  function close() {
    key?.close();
    key = undefined;
    created = false;
  }
</script>

<section class="key-panel" aria-labelledby="key-title">
  <h2 id="key-title">{t().key.title}</h2>
  <p class="note">{t().key.note}</p>

  {#if key}
    <p class="signing-as" data-testid="signing-as" data-did={key.did}>
      {t().key.ready}
      <code class="id" title={key.did}><PackageText text={shortId(key.did)} /></code>
      <button type="button" onclick={close}>{t().key.close}</button>
    </p>
    {#if created}
      <p class="message" role="status">{t().key.created}</p>
      <h3>{t().key.shareTitle}</h3>
      <p class="note">{t().key.shareNote}</p>
      <pre class="share" data-testid="share-entry">{shareEntry}</pre>
    {/if}
    <p class="note">{t().key.keepPrivate} {t().key.devOnly}</p>
  {:else}
    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={mode === "open"} onclick={() => (mode = "open")}>{t().key.openTab}</button>
      <button type="button" role="tab" aria-selected={mode === "new"} onclick={() => (mode = "new")}>{t().key.newTab}</button>
    </div>

    {#if mode === "open"}
      <form class="key-form" onsubmit={open}>
        <label class="button">
          {t().key.chooseKeyFile}
          <input
            type="file"
            class="visually-hidden"
            data-testid="key-file-input"
            bind:this={keyFileInput}
            onchange={() => (keyFileName = keyFileInput?.files?.[0]?.name ?? "")}
          />
        </label>
        {#if keyFileName}<span class="file-name"><PackageText text={keyFileName} /></span>{/if}
        <label>
          {t().key.passphrase}
          <input type="password" name="passphrase" autocomplete="current-password" bind:value={passphrase} required />
        </label>
        <button type="submit" disabled={!keyFileName || share !== undefined}>{t().key.open}</button>
      </form>
    {:else}
      <form class="key-form" onsubmit={create}>
        <label>
          {t().key.passphrase}
          <input type="password" name="new-passphrase" autocomplete="new-password" bind:value={passphrase} required />
        </label>
        <label>
          {t().key.repeat}
          <input type="password" name="repeat-passphrase" autocomplete="new-password" bind:value={repeated} required />
        </label>
        <button type="submit" disabled={share !== undefined}>{t().key.create}</button>
      </form>
    {/if}

    {#if share !== undefined}
      <div class="progress">
        <progress max="1" value={share}></progress>
        <span>{t().key.deriving(Math.floor(share * 100))}</span>
        <button type="button" onclick={() => task?.cancel()}>{t().key.cancel}</button>
      </div>
    {/if}
    {#if error}
      <p class="message error" role="alert"><PackageText text={error} /></p>
    {/if}
    <p class="note">{t().key.devOnly}</p>
  {/if}
</section>
