// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {}

  /** The commit the site was built from (set by the release workflow), or "" for a local build. */
  const __DOCSEAL_COMMIT__: string;
  /** Whether this is a preview deployment, built from main for testing, not a release. */
  const __DOCSEAL_PREVIEW__: boolean;
  /** The version this site was released as (set by the release workflow), or "". */
  const __DOCSEAL_VERSION__: string;
  /** For a preview: the release served beside it, or null when there is none yet. */
  const __DOCSEAL_RELEASE__: { version: string; path: string } | null;
}

export {};
