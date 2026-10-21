// A package handed from one page to another, so the viewer need not choose it again. It lives
// in memory for one navigation inside the app and is never stored.
let handed: File | undefined;

export function handOver(file: File): void {
  handed = file;
}

/** The package handed over, once; later calls return nothing. */
export function takeHanded(): File | undefined {
  const file = handed;
  handed = undefined;
  return file;
}
