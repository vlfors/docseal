<script lang="ts">
  // Completes a pending time proof: first asks the calendars whether a proof is complete,
  // then, on the viewer's action, saves the upgraded package and hands it back to be checked.
  import { saveBlob } from "../download";
  import { t } from "../i18n/state.svelte";
  import { chooseTarget, discardTarget } from "../save";
  import { upgradeInWorker, VerificationCancelled } from "../verify/client";
  import PackageText from "./PackageText.svelte";

  let { file, onupgraded }: { file: File; onupgraded: (upgraded: File) => void } = $props();

  let phase = $state<"idle" | "checking" | "not-yet" | "available" | "saving">("idle");
  let percent = $state(0);
  let message = $state("");

  async function check() {
    phase = "checking";
    message = "";
    try {
      const { changed } = await upgradeInWorker(file).result;
      phase = changed ? "available" : "not-yet";
    } catch (error) {
      phase = "idle";
      message = `${t().upgrade.failed}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function save() {
    const name = file.name.toLowerCase().endsWith(".dseal") ? file.name : `${file.name}.dseal`;
    const target = await chooseTarget(name);
    if (!target) {
      return;
    }
    phase = "saving";
    percent = 0;
    try {
      const upgraded = await upgradeInWorker(file, target.output, (read, total) => {
        percent = total > 0 ? Math.floor((read / total) * 100) : 100;
      }).result;
      if (!upgraded.changed) {
        // The calendar's answer changed in between; nothing was written.
        await discardTarget(target);
        phase = "not-yet";
        return;
      }
      let saved: File;
      if (upgraded.blob) {
        saveBlob(upgraded.blob, target.name);
        saved = new File([upgraded.blob], target.name);
        message = t().upgrade.downloaded(target.name);
      } else {
        saved = await (target.handle as FileSystemFileHandle).getFile();
        message = t().upgrade.saved(target.name);
      }
      phase = "idle";
      onupgraded(saved);
    } catch (error) {
      await discardTarget(target);
      phase = "available";
      if (!(error instanceof VerificationCancelled)) {
        message = `${t().upgrade.failed}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
</script>

<section class="upgrade-panel" aria-labelledby="upgrade-title" data-state={phase}>
  <h3 id="upgrade-title">{t().upgrade.title}</h3>
  <p class="note">{t().upgrade.intro}</p>
  {#if phase === "idle" || phase === "not-yet"}
    <button type="button" data-testid="upgrade-check" onclick={check}>{t().upgrade.check}</button>
  {/if}
  {#if phase === "checking"}
    <p role="status">{t().upgrade.checking}</p>
  {:else if phase === "not-yet"}
    <p role="status" data-testid="upgrade-not-yet">{t().upgrade.notYet}</p>
  {:else if phase === "available"}
    <p role="status">{t().upgrade.available}</p>
    <button type="button" class="primary" data-testid="upgrade-save" onclick={save}>{t().upgrade.save}</button>
  {:else if phase === "saving"}
    <div class="progress"><progress max="100" value={percent}></progress> <span>{t().upgrade.saving(percent)}</span></div>
  {/if}
  {#if message}<p class="message" data-testid="upgrade-message"><PackageText text={message} /></p>{/if}
</section>
