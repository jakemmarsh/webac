/**
 * PERF (2026-09-30) — a DAT download streams into ONE buffer (it used to
 * hold every chunk plus the joined copy: ~1.4 GB extra on a first launch).
 */
import { describe, it, expect } from 'vitest';
import { readResponseBytes } from '../packages/renderer/src/dat/readResponseBytes.js';

function responseOf(chunks: number[][], contentLength?: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(new Uint8Array(ch)); c.close(); },
  });
  const headers = new Headers(contentLength !== undefined ? { 'content-length': String(contentLength) } : {});
  return new Response(stream, { headers });
}

describe('readResponseBytes', () => {
  it('fills a preallocated buffer when Content-Length is known, reporting progress', async () => {
    const progress: number[] = [];
    const buf = await readResponseBytes(responseOf([[1, 2], [3], [4, 5, 6]], 6), (pct) => progress.push(Math.round(pct)));
    expect([...new Uint8Array(buf)]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(buf.byteLength).toBe(6);
    expect(progress).toEqual([33, 50, 100]);
  });
  it('collects chunks when there is no Content-Length', async () => {
    const buf = await readResponseBytes(responseOf([[9], [8, 7]]));
    expect([...new Uint8Array(buf)]).toEqual([9, 8, 7]);
  });
  it('survives a server that under-reports Content-Length', async () => {
    const buf = await readResponseBytes(responseOf([[1, 2], [3, 4, 5]], 3));
    expect([...new Uint8Array(buf)]).toEqual([1, 2, 3, 4, 5]);
  });
  it('rejects a response shorter than Content-Length (truncated download, not a DAT)', async () => {
    // playwebac.com 2026-10-04: Chrome answered a full portal.dat GET with
    // only the 1 KB of a cached Range response; the old code trimmed and
    // handed 1 KB to the DAT parser.
    await expect(readResponseBytes(responseOf([[1, 2]], 5))).rejects.toThrow('Truncated download: received 2 of 5 bytes');
  });
});
