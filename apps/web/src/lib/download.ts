/** Hands `bytes` to the browser as a download named `name`; nothing leaves the device. */
export function saveBytes(bytes: Uint8Array, name: string, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // The download has started from the URL; it can go once this task ends.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
