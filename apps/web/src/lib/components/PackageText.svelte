<script lang="ts">
  // Text from a package: isolated from the page's own text direction, with every control or
  // reordering character shown as its code point (see lib/text.ts).
  import { t } from "../i18n/state.svelte";
  import { visibleParts } from "../text";

  let { text }: { text: string } = $props();
</script>

<bdi class="package-text">{#each visibleParts(text) as part, i (i)}{#if part.unsafe}<span class="unsafe" title={t().unsafeCharacter(part.code)}>{part.code}</span>{:else}{part.text}{/if}{/each}</bdi>
