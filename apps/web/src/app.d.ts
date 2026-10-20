// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {}

  /** The commit the site was built from (set by the release workflow), or "" for a local build. */
  const __DOCSEAL_COMMIT__: string;
}

export {};
