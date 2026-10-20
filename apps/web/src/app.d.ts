// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {}

  /** The commit the site was built from (set by the release workflow), or "" for a local build. */
  const __DOCSEAL_COMMIT__: string;
  /** Whether this is a preview deployment, built from main for testing, not a release. */
  const __DOCSEAL_PREVIEW__: boolean;
}

export {};
