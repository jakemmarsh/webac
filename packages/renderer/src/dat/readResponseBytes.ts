/**
 * Read a DAT download into one ArrayBuffer, reporting progress per chunk.
 *
 * PERF (2026-09-30): the old path kept every chunk in an array and then
 * copied them all into a new buffer, so a first launch briefly held each DAT
 * twice (~1.4 GB extra for portal+cell+highres; renderer RSS 3.26 GB cold vs
 * 2.21 GB warm). With a Content-Length the bytes now stream straight into
 * the one destination buffer; without one (or if the server under-reported)
 * it falls back to collecting chunks.
 */
export async function readResponseBytes(
  resp: Response,
  onProgress?: (pct: number, loadedBytes: number, totalBytes: number) => void,
): Promise<ArrayBuffer> {
  const totalBytes = parseInt(resp.headers.get('content-length') || '0', 10);
  const reader = resp.body?.getReader();
  if (!reader) return resp.arrayBuffer();

  let dest = totalBytes > 0 ? new Uint8Array(totalBytes) : null;
  let chunks: Uint8Array[] | null = dest ? null : [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (dest && loaded + value.byteLength > dest.byteLength) {
      // More bytes than Content-Length promised: fall back to collecting.
      chunks = [dest.subarray(0, loaded).slice()];
      dest = null;
    }
    if (dest) dest.set(value, loaded);
    else chunks!.push(value);
    loaded += value.byteLength;
    onProgress?.(totalBytes > 0 ? (loaded / totalBytes) * 100 : 0, loaded, totalBytes);
  }
  // Fewer bytes than Content-Length promised is a truncated download, never a
  // DAT: parsing it fails far away ("Offset is outside the bounds of the
  // DataView"). Fail here, where the cause is known.
  if (dest && loaded < dest.byteLength) {
    throw new Error(`Truncated download: received ${loaded} of ${dest.byteLength} bytes`);
  }
  if (dest) return dest.buffer;
  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks!) { result.set(c, offset); offset += c.byteLength; }
  return result.buffer;
}
