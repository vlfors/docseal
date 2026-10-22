<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { FORMAT_VERSION } from "@docseal/core";
  import { onMount, type Snippet } from "svelte";
  import { isFramed } from "../lib/frame";
  import { LANGUAGES, MESSAGES } from "../lib/i18n/language";
  import type { Language } from "../lib/i18n/messages";
  import { initLanguage, language, setLanguage, t } from "../lib/i18n/state.svelte";
  import { initChain } from "../lib/chain/state.svelte";
  import { initTrustedKeys } from "../lib/trust/state.svelte";
  import "../app.css";

  let { children }: { children: Snippet } = $props();

  const COMMIT = /^[0-9a-f]{40}$/.test(__DOCSEAL_COMMIT__) ? __DOCSEAL_COMMIT__ : "";
  const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
  const VERSION = SEMVER.test(__DOCSEAL_VERSION__) ? __DOCSEAL_VERSION__ : "";
  const RELEASE = __DOCSEAL_RELEASE__ !== null && SEMVER.test(__DOCSEAL_RELEASE__.version) && __DOCSEAL_RELEASE__.path.startsWith("/") ? __DOCSEAL_RELEASE__ : null;

  /** Marks the link of the page being shown (paths end in a slash: trailingSlash is "always"). */
  const current = (route: "/" | "/seal" | "/upgrade") => (page.url.pathname.replace(/\/$/, "") === resolve(route).replace(/\/$/, "") ? "page" : undefined);

  // A <meta> CSP cannot forbid framing, so the page refuses to work inside a frame: another site
  // could otherwise lay its own buttons or verdict over ours.
  let framed = $state(false);
  onMount(() => {
    framed = isFramed(window);
    initLanguage();
    initTrustedKeys();
    initChain();
    // The page now responds to the viewer; until here the prerendered controls do nothing.
    document.body.dataset["ready"] = "";
  });
</script>

{#if framed}
  <main>
    <h1>DocSeal</h1>
    <p>{t().framed}</p>
  </main>
{:else}
  {#if __DOCSEAL_PREVIEW__}
    <p class="preview-banner" role="note" data-testid="preview">
      {t().preview}
      {#if RELEASE}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the release is another site, outside this one's base path -->
        <a href={RELEASE.path} data-testid="preview-release">{t().previewRelease(RELEASE.version)}</a>
      {/if}
    </p>
  {/if}
  <header class="site">
    <a class="brand" href={resolve("/")}>DocSeal</a>
    <nav class="tabs-nav" aria-label="DocSeal">
      <a href={resolve("/")} aria-current={current("/")}>{t().nav.verify}</a>
      <a href={resolve("/upgrade")} aria-current={current("/upgrade")}>{t().nav.upgrade}</a>
      <a href={resolve("/seal")} aria-current={current("/seal")}>{t().nav.seal}</a>
    </nav>
    <select
      class="language"
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
    <p class="meta" data-testid="build">
      {t().formatVersion(String(FORMAT_VERSION))} ·
      {#if VERSION}
        <a href="https://github.com/vlfors/docseal/releases/tag/v{VERSION}" rel="noopener noreferrer" data-testid="version">DocSeal {VERSION}</a> ·
      {/if}
      {#if COMMIT}
        {t().builtFrom}
        <a href="https://github.com/vlfors/docseal/commit/{COMMIT}" rel="noopener noreferrer"><code>{COMMIT.slice(0, 12)}</code></a>
      {:else}
        {t().localBuild}
      {/if}
    </p>
  </footer>
{/if}
