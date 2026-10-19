<script lang="ts">
  // Seals the chosen documents with the open key and saves the package: straight to a picked
  // file where the browser allows it, else built in memory and downloaded, up to a limit.
  import { resolve } from "$app/paths";
  import { MEDIA_TYPE } from "@docseal/core";
  import { saveBlob } from "../download";
  import { formatSize } from "../i18n/language";
  import { language, t } from "../i18n/state.svelte";
  import { totalSize, type PlannedFile } from "../seal/files";
  import { canStreamToDisk, MEMORY_LIMIT, suggestedName } from "../seal/limits";
  import { SealError, sealWithKey, type OpenKey, type Sealed, type SealTask } from "../signer/client";
  import type { SealOutput } from "../signer/protocol";
  import PackageText from "./PackageText.svelte";

  let { planned, key = $bindable() }: { planned: PlannedFile[]; key?: OpenKey | undefined } = $props();

  let role = $state("author");
  let percent = $state<number | undefined>();
  let result = $state<{ sealed: Sealed; name: string; streamed: boolean } | undefined>();
  let message = $state("");
  let task: SealTask | undefined;
  let picked: FileSystemFileHandle | undefined;

  const streaming = typeof window !== "undefined" && canStreamToDisk(window);
  const size = $derived(totalSize(planned));
  const blocked = $derived(
    planned.length === 0
      ? t().sealing.needFiles
      : planned.some((file) => file.problem)
        ? t().sealing.fixPaths
        : !key
          ? t().sealing.needKey
          : !streaming && size > MEMORY_LIMIT
            ? `${t().sealing.tooLarge(formatSize(MEMORY_LIMIT, language()))} ${t().sealing.tooLargeHint}`
            : "",
  );

  async function seal() {
    if (!key || blocked) {
      return;
    }
    message = "";
    result = undefined;
    const name = suggestedName(planned.map((file) => file.path));
    let output: SealOutput;
    let savedName = name;
    if (canStreamToDisk(window)) {
      try {
        picked = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: "DocSeal package", accept: { [MEDIA_TYPE]: [".dseal"] } }],
        });
      } catch {
        // The picker was dismissed: nothing to do.
        return;
      }
      output = { kind: "file", handle: picked };
      savedName = picked.name;
    } else {
      output = { kind: "memory", limit: MEMORY_LIMIT };
    }
    const files = planned.map(({ path, file }) => ({ path, file }));
    percent = 0;
    const current = sealWithKey(key, files, role.trim(), output, (read, total) => {
      percent = total > 0 ? Math.floor((read / total) * 100) : 100;
    });
    task = current;
    // The key belongs to this sealing now; whatever happens, it is closed at the end.
    key = undefined;
    try {
      const sealed = await current.result;
      if (sealed.blob) {
        saveBlob(sealed.blob, savedName);
      }
      result = { sealed, name: savedName, streamed: !sealed.blob };
    } catch (error) {
      // The worker must have released the picked file before it can be removed.
      await current.stopped;
      await discardPicked();
      if (error instanceof SealError) {
        message =
          error.reason === "cancelled"
            ? t().sealing.cancelled
            : error.reason === "changed"
              ? t().sealing.changed
              : error.reason === "too-large"
                ? `${t().sealing.tooLarge(formatSize(MEMORY_LIMIT, language()))} ${t().sealing.tooLargeHint}`
                : `${t().sealing.failed}: ${error.message}`;
      } else {
        throw error;
      }
    } finally {
      percent = undefined;
      task = undefined;
      picked = undefined;
    }
  }

  /** A picked file that did not receive a finished package is removed (Chromium can). */
  async function discardPicked() {
    const handle = picked as (FileSystemFileHandle & { remove?: () => Promise<void> }) | undefined;
    await handle?.remove?.().catch(() => undefined);
  }
</script>

<section class="seal-panel" aria-labelledby="seal-title">
  <h2 id="seal-title">{t().sealing.title}</h2>
  <label class="role">
    {t().sealing.role}
    <input name="role" bind:value={role} autocomplete="off" />
    <span class="note">{t().sealing.roleNote}</span>
  </label>
  {#if !streaming}
    <p class="note">{t().sealing.memoryNote(formatSize(MEMORY_LIMIT, language()))}</p>
  {/if}

  {#if percent !== undefined}
    <div class="progress" data-state="sealing">
      <progress max="100" value={percent}></progress>
      <span>{t().sealing.progress(percent)}</span>
      <button type="button" onclick={() => task?.cancel()}>{t().sealing.cancel}</button>
    </div>
  {:else}
    <button type="button" class="primary" data-testid="seal-button" disabled={blocked !== ""} onclick={seal}>{t().sealing.seal}</button>
    {#if blocked}<p class="note" data-testid="seal-blocked">{blocked}</p>{/if}
  {/if}

  {#if message}
    <p class="message error" role="alert" data-testid="seal-message"><PackageText text={message} /></p>
  {/if}

  {#if result}
    <div class="sealed" role="status" data-testid="sealed" data-seal={result.sealed.seal}>
      <h3>{t().sealing.done}</h3>
      <p>{result.streamed ? t().sealing.savedTo(result.name) : t().sealing.downloaded(result.name)}</p>
      <dl class="record">
        <dt>{t().sealing.size}</dt>
        <dd>{formatSize(result.sealed.size, language())}</dd>
        <dt>{t().sealing.seal_}</dt>
        <dd class="id">{result.sealed.seal}</dd>
        <dt>{t().technical.packageId}</dt>
        <dd class="id">{result.sealed.packageId}</dd>
      </dl>
      <p class="note">{t().sealing.keyClosed}</p>
      <p><a href={resolve("/")}>{t().sealing.verifyIt}</a></p>
    </div>
  {/if}
</section>
