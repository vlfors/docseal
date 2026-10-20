<script lang="ts">
  // The documents to seal: chosen files, a chosen folder, or dropped files and folders, with
  // every path problem the core would reject shown before sealing.
  import { formatSize } from "../i18n/language";
  import { language, t } from "../i18n/state.svelte";
  import { fromDroppedEntries, fromFileInput, fromFolderInput, totalSize, type ChosenFile, type PlannedFile } from "../seal/files";
  import PackageText from "./PackageText.svelte";

  let { chosen = $bindable([]), planned }: { chosen?: ChosenFile[]; planned: PlannedFile[] } = $props();

  let filesInput: HTMLInputElement | undefined = $state();
  let folderInput: HTMLInputElement | undefined = $state();
  let dragging = $state(false);
  let reading = $state(false);

  const problems = $derived(planned.filter((file) => file.problem).length);

  function add(files: ChosenFile[]) {
    chosen = [...chosen, ...files];
  }

  function remove(file: File) {
    chosen = chosen.filter((entry) => entry.file !== file);
  }

  async function drop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    const items = [...(event.dataTransfer?.items ?? [])].filter((item) => item.kind === "file");
    // Entries must be taken during the event; reading them may take longer.
    const entries = items.map((item) => item.webkitGetAsEntry()).filter((entry): entry is FileSystemEntry => entry !== null);
    reading = true;
    try {
      add(await fromDroppedEntries(entries));
    } finally {
      reading = false;
    }
  }
</script>

<div class="file-picker">
  <div
    class={dragging ? "dropzone dragging" : "dropzone"}
    role="region"
    aria-label={t().seal.filesTitle}
    ondragover={(event) => {
      event.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    ondrop={drop}
  >
    <label class="button primary">
      {t().seal.chooseFiles}
      <input
        type="file"
        multiple
        class="visually-hidden"
        data-testid="files-input"
        bind:this={filesInput}
        onchange={() => {
          add(fromFileInput(filesInput?.files ?? []));
          if (filesInput) filesInput.value = "";
        }}
      />
    </label>
    <label class="button">
      {t().seal.chooseFolder}
      <input
        type="file"
        webkitdirectory
        class="visually-hidden"
        data-testid="folder-input"
        bind:this={folderInput}
        onchange={() => {
          add(fromFolderInput(folderInput?.files ?? []));
          if (folderInput) folderInput.value = "";
        }}
      />
    </label>
    <span class="hint">{t().seal.dropHint}</span>
    <p class="note">{t().seal.folderNote}</p>
  </div>

  {#if reading}
    <p class="note" role="status">{t().seal.readingFolder}</p>
  {/if}

  {#if planned.length === 0}
    <p class="empty">{t().seal.empty}</p>
  {:else}
    <p class="summary" data-testid="files-summary">
      {t().seal.summary(planned.length, formatSize(totalSize(planned), language()))}
      <button type="button" onclick={() => (chosen = [])}>{t().seal.clear}</button>
    </p>
    {#if problems > 0}
      <p class="message error" role="alert">{t().seal.problems(problems)}</p>
    {/if}
    <ul class="planned">
      {#each planned as file, i (i)}
        <li class={file.problem ? "bad" : ""} data-path={file.path} data-problem={file.problem?.kind ?? ""}>
          <span class="path"><PackageText text={file.path} /></span>
          <span class="size">{formatSize(file.file.size, language())}</span>
          <button
            type="button"
            class="remove"
            aria-label={t().seal.remove(file.path)}
            onclick={() => {
              remove(file.file);
            }}>×</button
          >
          {#if file.problem}
            <span class="problem">{file.problem.kind === "collision" ? t().seal.collision : file.problem.message}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
