/** Save bytes or a stream as a file through a temporary object URL. */

export function toBlob(bytes: Uint8Array, mimeType: string): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType });
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before the URL is revoked.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function streamToBlob(stream: ReadableStream<Uint8Array>, mimeType: string): Promise<Blob> {
  return new Response(stream, { headers: { 'content-type': mimeType } }).blob();
}
