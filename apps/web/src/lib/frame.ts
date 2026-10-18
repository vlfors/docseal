/** Whether the page runs inside a frame of another page (or of itself). */
export function isFramed(window: { readonly self: object; readonly top: object | null }): boolean {
  try {
    return window.top !== window.self;
  } catch {
    // Reading `top` across origins can throw; that is a frame too.
    return true;
  }
}
