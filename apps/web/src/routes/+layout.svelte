<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { isFramed } from "../lib/frame";
  import "../app.css";

  let { children }: { children: Snippet } = $props();

  // A <meta> CSP cannot forbid framing, so the page refuses to work inside a frame: another site
  // could otherwise lay its own buttons or verdict over ours.
  let framed = $state(false);
  onMount(() => {
    framed = isFramed(window);
  });
</script>

{#if framed}
  <main>
    <h1>DocSeal</h1>
    <p>This page does not work inside another site. Open it directly in its own tab.</p>
  </main>
{:else}
  {@render children()}
{/if}
