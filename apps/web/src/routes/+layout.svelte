<script lang="ts">
  import { FORMAT_VERSION } from "@docseal/core";
  import { onMount, type Snippet } from "svelte";
  import { isFramed } from "../lib/frame";
  import { LANGUAGES, MESSAGES } from "../lib/i18n/language";
  import type { Language } from "../lib/i18n/messages";
  import { initLanguage, language, setLanguage, t } from "../lib/i18n/state.svelte";
  import { initTrustedKeys } from "../lib/trust/state.svelte";
  import "../app.css";

  let { children }: { children: Snippet } = $props();

  // A <meta> CSP cannot forbid framing, so the page refuses to work inside a frame: another site
  // could otherwise lay its own buttons or verdict over ours.
  let framed = $state(false);
  onMount(() => {
    framed = isFramed(window);
    initLanguage();
    initTrustedKeys();
  });
</script>

{#if framed}
  <main>
    <h1>DocSeal</h1>
    <p>{t().framed}</p>
  </main>
{:else}
  <header class="site">
    <span class="brand">DocSeal</span>
    <span class="tagline">{t().tagline}</span>
    <select
      aria-label="Language / Язык"
      value={language()}
      onchange={(event) => {
        setLanguage(event.currentTarget.value as Language);
      }}
    >
      {#each LANGUAGES as code (code)}
        <option value={code}>{MESSAGES[code].languageName}</option>
      {/each}
    </select>
  </header>
  {@render children()}
  <footer class="site">
    <p>{t().footer}</p>
    <p class="meta">Format v{FORMAT_VERSION}</p>
  </footer>
{/if}
