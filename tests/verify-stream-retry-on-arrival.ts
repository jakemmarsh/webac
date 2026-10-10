/**
 * RELEASE.dat-streaming — runRetryingOnArrival (dat/streaming/RetryOnArrival.ts):
 * the one-shot builds that a streamed miss used to leave incomplete for the
 * rest of a stay (the entered dungeon's collision, a new day group's sky
 * objects) run again once the missed files land — bounded, and only while
 * the result is still wanted.
 */
import { describe, it, expect } from 'vitest';
import { runRetryingOnArrival, MAX_ARRIVAL_RETRIES, type RetryStore } from '../packages/renderer/src/dat/streaming/RetryOnArrival.js';

/** A store whose `missing` keys miss while read inside a scope, until ensure() makes them resident. */
function fakeStore(missing: Set<string>, opts: { failFetch?: boolean } = {}) {
  let reads: string[] | null = null;
  const ensured: string[][] = [];
  const store: RetryStore & { read(k: string): boolean } = {
    read(k) { const hit = !missing.has(k); if (!hit) reads?.push(k); return hit; },
    scoped<T>(fn: () => T) {
      reads = [];
      const result = fn();
      const keys = reads; reads = null;
      return { result, scope: { missed: keys.length > 0, keys: keys as never } };
    },
    ensure(keys) {
      const ks = [...keys] as unknown as string[];
      ensured.push(ks);
      if (opts.failFetch) return Promise.reject(new Error('offline'));
      for (const k of ks) missing.delete(k);
      return Promise.resolve();
    },
  };
  return { store, ensured };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('runRetryingOnArrival', () => {
  it('runs once when nothing missed', async () => {
    const { store, ensured } = fakeStore(new Set());
    let runs = 0;
    runRetryingOnArrival(store, () => { runs++; store.read('a'); });
    await flush();
    expect(runs).toBe(1);
    expect(ensured).toHaveLength(0);
  });

  it('runs again once the missed files are resident, and the second run sees them', async () => {
    const { store } = fakeStore(new Set(['gfx']));
    const seen: boolean[] = [];
    runRetryingOnArrival(store, () => { seen.push(store.read('gfx')); });
    await flush();
    expect(seen).toEqual([false, true]);
  });

  it('is bounded when a file never arrives, and dropped when no longer wanted', async () => {
    const missing = new Set(['absent']);
    const { store } = fakeStore(missing);
    store.ensure = () => Promise.resolve(); // never becomes resident
    let runs = 0;
    runRetryingOnArrival(store, () => { runs++; store.read('absent'); });
    for (let i = 0; i < 10; i++) await flush();
    expect(runs).toBe(MAX_ARRIVAL_RETRIES);

    const { store: s2 } = fakeStore(new Set(['x']));
    let runs2 = 0;
    runRetryingOnArrival(s2, () => { runs2++; s2.read('x'); }, () => false);
    await flush();
    expect(runs2).toBe(1);
  });

  it('a failed fetch keeps what was built; whole DATs (no store) just run', async () => {
    const { store } = fakeStore(new Set(['y']), { failFetch: true });
    let runs = 0;
    runRetryingOnArrival(store, () => { runs++; store.read('y'); });
    await flush();
    expect(runs).toBe(1);
    let plain = 0;
    runRetryingOnArrival(null, () => { plain++; });
    expect(plain).toBe(1);
  });
});
