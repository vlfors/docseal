<script lang="ts">
  // One numbered step of the seal page. A waiting step shows only its title and what it waits
  // for, unless `always` keeps its content (the result of sealing must stay visible).
  import type { Snippet } from "svelte";

  let {
    number,
    title,
    state,
    waitingFor = "",
    always = false,
    children,
  }: {
    number: number;
    title: string;
    state: "done" | "current" | "waiting";
    waitingFor?: string;
    always?: boolean;
    children: Snippet;
  } = $props();
</script>

<section class="step {state}" data-step={number} data-state={state} aria-labelledby="step-{number}">
  <header class="step-head">
    <span class="step-number" aria-hidden="true">{state === "done" ? "✓" : number}</span>
    <h2 id="step-{number}">{title}</h2>
  </header>
  {#if state !== "waiting" || always}
    <div class="step-body">{@render children()}</div>
  {:else if waitingFor}
    <p class="step-waiting">{waitingFor}</p>
  {/if}
</section>
