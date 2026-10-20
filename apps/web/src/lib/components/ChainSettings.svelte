<script lang="ts">
  // Where time proofs are checked against Bitcoin: the public Esplora sources, the viewer's own
  // instance, or nowhere.
  import { isEsploraUrl, type ChainMode } from "../chain/setting";
  import { chainChoice, setChainChoice } from "../chain/state.svelte";
  import { t } from "../i18n/state.svelte";

  let url = $state(chainChoice().url);
  const invalid = $derived(chainChoice().mode === "custom" && url !== "" && !isEsploraUrl(url));

  function choose(mode: ChainMode) {
    setChainChoice({ mode, url });
  }

  function applyUrl() {
    if (isEsploraUrl(url)) {
      setChainChoice({ mode: "custom", url });
    }
  }
</script>

<section class="chain-settings" aria-labelledby="chain-title">
  <h2 id="chain-title">{t().chain.title}</h2>
  <fieldset>
    <legend class="visually-hidden">{t().chain.title}</legend>
    <label class="check">
      <input type="radio" name="chain" value="public" checked={chainChoice().mode === "public"} onchange={() => {
        choose("public");
      }} />
      {t().chain.publicSources}
    </label>
    <label class="check">
      <input type="radio" name="chain" value="custom" checked={chainChoice().mode === "custom"} onchange={() => {
        choose("custom");
      }} />
      {t().chain.custom}
    </label>
    {#if chainChoice().mode === "custom"}
      <label class="custom-url">
        {t().chain.customUrl}
        <input name="esplora" bind:value={url} placeholder="https://…/api" autocomplete="off" spellcheck="false" onchange={applyUrl} />
      </label>
      {#if invalid}<p class="message error" role="alert">{t().chain.invalidUrl}</p>{/if}
    {/if}
    <label class="check">
      <input type="radio" name="chain" value="offline" checked={chainChoice().mode === "offline"} onchange={() => {
        choose("offline");
      }} />
      {t().chain.offline}
    </label>
  </fieldset>
  <p class="note">{t().chain.trustNote}</p>
  <p class="note">{t().chain.privacyNote}</p>
</section>
