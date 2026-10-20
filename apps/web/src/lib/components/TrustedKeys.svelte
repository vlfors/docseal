<script lang="ts">
  import { saveBytes } from "../download";
  import { t } from "../i18n/state.svelte";
  import { addKey, exportKeys, importKeys, removeKey } from "../trust/keys";
  import { keysAreStored, setTrustedKeys, trustedKeys } from "../trust/state.svelte";
  import { shortId } from "../text";
  import PackageText from "./PackageText.svelte";

  /** A trusted keys file is a short list; anything larger is not one. */
  const MAX_FILE_SIZE = 1024 * 1024;

  let did = $state("");
  let label = $state("");
  let message = $state<{ text: string; error: boolean } | undefined>();
  let importInput: HTMLInputElement | undefined = $state();

  function add(event: SubmitEvent) {
    event.preventDefault();
    const result = addKey(trustedKeys(), did, label);
    if ("error" in result) {
      message = { text: t().trusted[result.error], error: true };
      return;
    }
    setTrustedKeys(result.keys);
    did = "";
    label = "";
    message = undefined;
  }

  async function importFile() {
    const file = importInput?.files?.[0];
    if (importInput) {
      importInput.value = "";
    }
    if (!file) {
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      message = { text: t().trusted.invalidFile(`${String(file.size)} bytes`), error: true };
      return;
    }
    const result = importKeys(trustedKeys(), new Uint8Array(await file.arrayBuffer()));
    if ("error" in result) {
      message = { text: t().trusted.invalidFile(result.error), error: true };
      return;
    }
    setTrustedKeys(result.keys);
    message = { text: t().trusted.imported(result.added, result.skipped), error: false };
  }

  function exportFile() {
    saveBytes(exportKeys(trustedKeys()), "trusted-keys.json", "application/json");
  }
</script>

<section class="trusted-keys" aria-labelledby="trusted-keys-title">
  <h3 id="trusted-keys-title">{t().trusted.title}</h3>
  <p class="note">{keysAreStored() ? t().trusted.note : t().trusted.storageUnavailable}</p>

  {#if trustedKeys().length === 0}
    <p class="empty">{t().trusted.empty}</p>
  {:else}
    <ul class="keys">
      {#each trustedKeys() as key (key.id)}
        <li data-key={key.id}>
          <span class="label">{#if key.label !== undefined}<PackageText text={key.label} />{/if}</span>
          <code class="id" title={key.id}><PackageText text={shortId(key.id)} /></code>
          <button
            type="button"
            class="remove"
            aria-label={t().trusted.remove(key.label ?? shortId(key.id))}
            onclick={() => {
              setTrustedKeys(removeKey(trustedKeys(), key.id));
            }}>×</button
          >
        </li>
      {/each}
    </ul>
  {/if}

  <form class="add-key" onsubmit={add}>
    <label>
      {t().trusted.did}
      <input name="did" bind:value={did} required autocomplete="off" spellcheck="false" placeholder="did:key:z6Mk…" />
    </label>
    <label>
      {t().trusted.label}
      <input name="label" bind:value={label} autocomplete="off" />
    </label>
    <button type="submit">{t().trusted.add}</button>
  </form>

  {#if message}
    <p class={message.error ? "message error" : "message"} role={message.error ? "alert" : "status"}>{message.text}</p>
  {/if}

  <div class="file-actions">
    <label class="button">
      {t().trusted.import}
      <input type="file" class="visually-hidden" accept=".json,application/json" bind:this={importInput} onchange={importFile} />
    </label>
    <button type="button" onclick={exportFile} disabled={trustedKeys().length === 0}>{t().trusted.export}</button>
  </div>
</section>
