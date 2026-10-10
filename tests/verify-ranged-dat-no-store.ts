import { describe, it, expect, vi, afterEach } from 'vitest';
import { httpRangeFetcher, RANGE_FETCH_ATTEMPTS } from '../packages/dat-parser/src/RangedDat.js';

// playwebac.com 2026-10-04: Chrome kept the splash's 206 Range response as a
// sparse cache entry and answered the following full portal.dat GET with only
// those 1,024 bytes under a 200. Range reads must stay out of the HTTP cache.
describe('httpRangeFetcher bypasses the browser HTTP cache', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the Range header with cache: no-store and returns the 206 body', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(new Uint8Array([7, 8, 9]), { status: 206 });
    });
    const bytes = await httpRangeFetcher('https://dats.example/client_portal.dat')(100, 3);
    expect([...bytes]).toEqual([7, 8, 9]);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]?.cache).toBe('no-store');
    expect((calls[0][1]?.headers as Record<string, string>).Range).toBe('bytes=100-102');
  });

  it('still refuses a server that ignores the range', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(10), { status: 200 }));
    await expect(httpRangeFetcher('https://dats.example/x.dat')(0, 4)).rejects.toThrow('not 206');
  });

  // dats.playwebac.com 2026-10-06: R2 behind Cloudflare answered about 1 in 7
  // portal.dat ranges with the whole file (200, Accept-Ranges: bytes), which
  // failed the splash read and left the plain-text placeholder up.
  it('asks again when a range-serving host ignores one range', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n++;
      return n < 3
        ? new Response(new Uint8Array(10), { status: 200, headers: { 'Accept-Ranges': 'bytes' } })
        : new Response(new Uint8Array([1, 2, 3, 4]), { status: 206 });
    });
    const bytes = await httpRangeFetcher('https://dats.example/client_portal.dat')(0, 4);
    expect([...bytes]).toEqual([1, 2, 3, 4]);
    expect(n).toBe(3);
  });

  it('gives up after RANGE_FETCH_ATTEMPTS full answers', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n++;
      return new Response(new Uint8Array(10), { status: 200, headers: { 'Accept-Ranges': 'bytes' } });
    });
    await expect(httpRangeFetcher('https://dats.example/x.dat')(0, 4)).rejects.toThrow('not 206');
    expect(n).toBe(RANGE_FETCH_ATTEMPTS);
  });

  it('does not retry a host without range support or an error status', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => { n++; return new Response(new Uint8Array(10), { status: 200 }); });
    await expect(httpRangeFetcher('https://dats.example/x.dat')(0, 4)).rejects.toThrow('not 206');
    expect(n).toBe(1);
    n = 0;
    vi.stubGlobal('fetch', async () => { n++; return new Response('no', { status: 404, headers: { 'Accept-Ranges': 'bytes' } }); });
    await expect(httpRangeFetcher('https://dats.example/x.dat')(0, 4)).rejects.toThrow('answered 404');
    expect(n).toBe(1);
  });

  it('asks again after a dropped connection but never after an abort', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n++;
      if (n === 1) throw new TypeError('Failed to fetch');
      return new Response(new Uint8Array([5]), { status: 206 });
    });
    expect([...(await httpRangeFetcher('https://dats.example/x.dat')(0, 1))]).toEqual([5]);
    expect(n).toBe(2);

    n = 0;
    const ac = new AbortController();
    vi.stubGlobal('fetch', async () => {
      n++;
      ac.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(httpRangeFetcher('https://dats.example/x.dat', ac.signal)(0, 1)).rejects.toThrow('aborted');
    expect(n).toBe(1);
  });
});
