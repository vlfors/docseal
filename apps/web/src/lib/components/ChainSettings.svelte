<script lang="ts">
  // Where time proofs are checked against Bitcoin: the public Esplora sources, the viewer's own
  // instance, or nowhere. One list; the address field appears only for an own instance.
  import { isEsploraUrl, type ChainMode } from "../chain/setting";
  import { chainChoice, setChainChoice } from "../chain/state.svelte";
  import { t } from "../i18n/state.svelte";

  let url = $state(chainChoice().url);
  const invalid = $derived(chainChoice().mode === "custom" && url !== "" && !isEsploraUrl(url));

  function applyUrl() {
    if (isEsploraUrl(url)) {
      setChainChoice({ mode: "custom", url });
    }
  }
</script>

<div class="chain-settings">
  <label class="field">
    {t().chain.source}
    <select
      name="chain"
      value={chainChoice().mode}
      onchange={(event) => {
        setChainChoice({ mode: event.currentTarget.value as ChainMode, url });
      }}
    >
      <option value="public">{t().chain.publicSources}</option>
      <option value="custom">{t().chain.custom}</option>
      <option value="offline">{t().chain.offline}</option>
    </select>
  </label>
  {#if chainChoice().mode === "custom"}
    <label class="field">
      {t().chain.customUrl}
      <input name="esplora" bind:value={url} placeholder="https://…/api" autocomplete="off" spellcheck="false" onchange={applyUrl} />
    </label>
    {#if invalid}<p class="message error" role="alert">{t().chain.invalidUrl}</p>{/if}
  {/if}
  <p class="note">{t().chain.trustNote} {t().chain.privacyNote}</p>
</div>
