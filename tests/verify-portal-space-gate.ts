/**
 * RELEASE.portal-space-cell-gate — the retail CellManager gate:
 * CellGate (CellManager::PreFetchCells / CheckPrefetchStatus) holds an
 * arrival until the destination is resident, GatedEventQueue is the
 * blocking_for_cells stop over the session's events, and ArrivalEvents picks
 * the events that place our player.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameMessageOpcode } from '../packages/network/src/GameMessageOpcode.js';
import { CellGate, DEFAULT_GATE_MAX_HOLD_MS, DEFAULT_GATE_TIMEOUT_MS, GatedEventQueue, PREFETCH_STATUS_POLL_MS, PrefetchStatus, settleBurst, type GateProgress } from '../packages/renderer/src/dat/streaming/PortalSpaceGate.js';
import { DatClosure } from '../packages/renderer/src/dat/streaming/DatClosure.js';
import { DatStore, fileKey } from '../packages/renderer/src/dat/streaming/DatStore.js';
import { appearanceRoots, arrivalCellOf, queuedObjectRoots, worldSessionLive } from '../packages/renderer/src/dat/streaming/ArrivalEvents.js';
import { SessionLifecycle } from '../packages/renderer/src/session/SessionLifecycle.js';
import { MemoryObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { FakeBucket, buildManifest, buildPack } from './_harness/datSet.js';
import { TeleportAnimation, TeleportAnimState } from '../packages/renderer/src/effects/PortalSpaceModel.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** A streamed set with one bundle (0xA9B4) and a terrain pack. */
async function streamedSet() {
  const bucket = new FakeBucket();
  const terrain = { ...bucket.put(buildPack([{ id: 0xA9B4FFFF, data: enc('land') }])), files: 1 };
  const bundle = { lb: 0xA9B4, ...bucket.put(buildPack([{ id: 0xA9B4FFFE, data: enc('info') }, { id: 0xA9B40100, data: enc('cell') }])) };
  const leaf = { id: 0x01000001, ...bucket.put(enc('gfx')) };
  const manifestBytes = buildManifest({ leaves: { portal: [leaf] }, packs: [{ role: 4, ...terrain }], bundles: [bundle] });
  const manifest = bucket.put(manifestBytes);
  const pointer = {
    format: 1, set: 's', iterations: { portal: 1, cell: 1, local: 1, highres: 0 },
    manifest: { key: `v1/o/${manifest.hash}`, size: manifest.size, gzSize: manifest.gzSize },
    packs: { terrain: { key: `v1/o/${terrain.hash}`, size: terrain.size, gzSize: terrain.gzSize, files: 1 } },
  };
  const store = await DatStore.open({
    pointerUrl: 'https://d.test/v1/sets/s.json', fetchPointer: async () => pointer, fetchObject: bucket.fetch,
    cache: new MemoryObjectCache(), packs: ['terrain'], retries: 0, onError: () => {},
  });
  return { bucket, store, closure: new DatClosure(store), leaf };
}

describe('CellGate', () => {
  it('whole DATs (no streaming closure): every destination is satisfied at once', async () => {
    const gate = new CellGate(null, { objectRadius: () => 1 });
    expect(gate.isSatisfied(0xA9B40100)).toBe(true);
    await expect(gate.prefetch(0xA9B40100)).resolves.toEqual({ ok: true, ms: 0 });
  });

  it('covers the object ring around the destination landblock, clamped to the map', () => {
    const gate = new CellGate(null, { objectRadius: () => 1 });
    expect(gate.landblocksFor(0xA9B4001C).length).toBe(9);
    expect(gate.landblocksFor(0x0000FFFF).sort((a, b) => a - b)).toEqual([0x0000, 0x0001, 0x0100, 0x0101]);
  });

  it('blocks until the destination ring + extra roots are resident', async () => {
    const { store, closure, leaf } = await streamedSet();
    const gate = new CellGate(closure, { objectRadius: () => 1 });
    const roots = [fileKey('portal', leaf.id)];
    expect(gate.isSatisfied(0xA9B40100, roots)).toBe(false);
    const out = await gate.prefetch(0xA9B40100, roots);
    expect(out.ok).toBe(true);
    expect(gate.isSatisfied(0xA9B40100, roots)).toBe(true);
    expect(store.isBundleResident(0xA9B4)).toBe(true);
    expect(store.isResident('portal', leaf.id)).toBe(true);
  });

  it('safety valve: a destination that never arrives releases with an error after the timeout', async () => {
    const { bucket, closure } = await streamedSet();
    bucket.hold();
    const gate = new CellGate(closure, { objectRadius: () => 1, timeoutMs: 30 });
    const out = await gate.prefetch(0xA9B40100);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.message).toMatch(/timed out/);
    bucket.release();
  });

  it('a failed download releases with an error instead of trapping the player', async () => {
    const { bucket, closure } = await streamedSet();
    for (const h of bucket.objects.keys()) bucket.failing.set(h, 99);
    const gate = new CellGate(closure, { objectRadius: () => 0 });
    const out = await gate.prefetch(0xA9B40100);
    expect(out.ok).toBe(false);
  });
});

describe('CellGate — the safety valve on a slow link (progress, not total time)', () => {
  afterEach(() => { vi.useRealTimers(); });

  /**
   * A closure whose landblocks land one after another, `perBlockMs` apart, on a
   * clock the test drives; `bytes` grows as each block's download trickles in.
   */
  function slowClosure(perBlockMs: number, opts: { stallAfter?: number } = {}) {
    const ready = new Set<number>();
    let bytes = 0;
    let queue = Promise.resolve();
    let landed = 0;
    const closure = {
      isLandblockReady: (lb: number) => ready.has(lb),
      isClosed: () => false,
      ensure: () => Promise.resolve({ files: 0, waves: 0, keys: new Set() }),
      ensureLandblock(lb: number): Promise<void> {
        if (ready.has(lb)) return Promise.resolve();
        // One at a time over the link: each block takes perBlockMs, bytes landing every second of it.
        queue = queue.then(() => new Promise<void>((resolve) => {
          if (opts.stallAfter !== undefined && landed >= opts.stallAfter) return; // the host stops answering
          let left = perBlockMs;
          const tick = () => {
            left -= 1000;
            bytes += 10_000;
            if (left > 0) { setTimeout(tick, 1000); return; }
            landed++;
            ready.add(lb);
            resolve();
          };
          setTimeout(tick, 1000);
        }));
        return queue;
      },
    };
    return { closure: closure as unknown as DatClosure, progress: () => bytes };
  }

  it('a destination still arriving after 90 s keeps holding (9 blocks × 15 s at ~10 KB/s) and completes', async () => {
    vi.useFakeTimers();
    const { closure, progress } = slowClosure(15_000);
    const gate = new CellGate(closure, { objectRadius: () => 1, progress, now: () => Date.now() });
    const p = gate.prefetch(0xA9B4001C);
    await vi.advanceTimersByTimeAsync(140_000);
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it('the same download without a byte counter still counts each finished landblock as progress', async () => {
    vi.useFakeTimers();
    const { closure } = slowClosure(15_000);
    const gate = new CellGate(closure, { objectRadius: () => 1, now: () => Date.now() });
    const p = gate.prefetch(0xA9B4001C);
    await vi.advanceTimersByTimeAsync(140_000);
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it('a host that stops answering still releases DEFAULT_GATE_TIMEOUT_MS after the last progress', async () => {
    vi.useFakeTimers();
    const { closure, progress } = slowClosure(5_000, { stallAfter: 2 });
    const gate = new CellGate(closure, { objectRadius: () => 1, progress, now: () => Date.now() });
    let out: Awaited<ReturnType<CellGate['prefetch']>> | null = null;
    void gate.prefetch(0xA9B4001C).then((o) => { out = o; });
    // Two blocks land by 10 s; nothing after.
    await vi.advanceTimersByTimeAsync(10_000 + DEFAULT_GATE_TIMEOUT_MS - 2000);
    expect(out).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    const o = out as Awaited<ReturnType<CellGate['prefetch']>> | null;
    expect(o).not.toBeNull();
    expect(o?.ok).toBe(false);
    if (o && !o.ok) expect(o.error.message).toMatch(/timed out after 90000 ms without progress \(2\/9 done\)/);
  });

  it('progress never holds past the cap (ACE logs off a player still teleporting at 5 min), counted from the hold', async () => {
    vi.useFakeTimers();
    const { closure, progress } = slowClosure(60_000); // 9 minutes of steady progress
    const gate = new CellGate(closure, { objectRadius: () => 1, progress, now: () => Date.now() });
    let out: Awaited<ReturnType<CellGate['prefetch']>> | null = null;
    // The hold began 40 s before the prefetch (the world packs were still arriving).
    void gate.prefetch(0xA9B4001C, [], [], { since: Date.now() - 40_000 }).then((o) => { out = o; });
    await vi.advanceTimersByTimeAsync(DEFAULT_GATE_MAX_HOLD_MS - 40_000 - 1000);
    expect(out).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    const o = out as Awaited<ReturnType<CellGate['prefetch']>> | null;
    expect(o?.ok).toBe(false);
    if (o && !o.ok) expect(o.error.message).toMatch(/timed out: held 240\d{3} ms/);
    expect(DEFAULT_GATE_MAX_HOLD_MS).toBeLessThan(5 * 60_000);
  });
});

describe('CellGate — a sealed interior holds for its own landblock only (CEnvCell::PreFetchCells)', () => {
  /** Two neighbouring landblocks with bundles: the destination 0xA9B4 and its neighbour 0xA9B5. */
  async function twoBlocks() {
    const bucket = new FakeBucket();
    const terrain = bucket.put(buildPack([{ id: 0xA9B4FFFF, data: enc('land') }, { id: 0xA9B5FFFF, data: enc('land') }]));
    const own = { lb: 0xA9B4, ...bucket.put(buildPack([{ id: 0xA9B4FFFE, data: enc('info') }, { id: 0xA9B40100, data: enc('dungeon cell') }])) };
    const next = { lb: 0xA9B5, ...bucket.put(buildPack([{ id: 0xA9B5FFFE, data: enc('info2') }, { id: 0xA9B50100, data: enc('other dungeon') }])) };
    const manifest = bucket.put(buildManifest({ packs: [{ role: 4, files: 2, ...terrain }], bundles: [own, next] }));
    const pointer = {
      format: 1, set: 's', iterations: { portal: 1, cell: 1, local: 1, highres: 0 },
      manifest: { key: `v1/o/${manifest.hash}`, size: manifest.size, gzSize: manifest.gzSize },
      packs: { terrain: { key: `v1/o/${terrain.hash}`, size: terrain.size, gzSize: terrain.gzSize, files: 2 } },
    };
    const store = await DatStore.open({
      pointerUrl: 'https://d.test/v1/sets/s.json', fetchPointer: async () => pointer, fetchObject: bucket.fetch,
      cache: new MemoryObjectCache(), packs: ['terrain'], retries: 0, onError: () => {},
    });
    bucket.requests = [];
    return { bucket, store, closure: new DatClosure(store), own, next };
  }

  it('sealed: only the destination\'s bundle is fetched, and the gate is then satisfied', async () => {
    const t = await twoBlocks();
    const asked: number[] = [];
    // The verdict needs the cell's bundle: unknown (null) until it is resident, as main.ts's peek.
    const gate = new CellGate(t.closure, { objectRadius: () => 1, sealedInterior: (c) => { asked.push(c); return t.store.isResident('cell', c) ? true : null; } });
    expect(gate.isSatisfied(0xA9B40100)).toBe(false);
    expect((await gate.prefetch(0xA9B40100)).ok).toBe(true);
    expect(t.bucket.requests).toContain(t.own.hash);
    expect(t.bucket.requests).not.toContain(t.next.hash);
    expect(t.store.isBundleResident(0xA9B5)).toBe(false);
    expect(gate.isSatisfied(0xA9B40100)).toBe(true);
    expect(asked.every((c) => c === 0xA9B40100)).toBe(true);
  });

  it('an outdoor cell or a SeenOutside interior still holds for the landblock ring', async () => {
    for (const verdict of [false, null] as const) {
      const t = await twoBlocks();
      const gate = new CellGate(t.closure, { objectRadius: () => 1, sealedInterior: () => verdict });
      expect((await gate.prefetch(0xA9B40100)).ok).toBe(true);
      expect(t.bucket.requests).toContain(t.next.hash);
    }
  });
});

describe('CellGate — a separate world (AC1999 under the streamed interface, 2026-10-06)', () => {
  it('whole world DATs + a streamed interface: the destination is satisfied, the HUD art still waits for the interface set', async () => {
    const ui = await streamedSet();
    const gate = new CellGate(null, { objectRadius: () => 1, interfaceClosure: ui.closure });
    const hud = [fileKey('portal', ui.leaf.id)];
    expect(gate.isSatisfied(0xA9B40100)).toBe(true);
    expect(gate.isSatisfied(0xA9B40100, [], hud)).toBe(false);
    const out = await gate.prefetch(0xA9B40100, [], hud);
    expect(out.ok).toBe(true);
    expect(ui.store.isResident('portal', ui.leaf.id)).toBe(true);
    // The interface set's landblocks are never the destination's: nothing but the HUD art was fetched.
    expect(ui.store.isBundleResident(0xA9B4)).toBe(false);
    expect(gate.isSatisfied(0xA9B40100, [], hud)).toBe(true);
  });

  it('two streamed sets: the ring + model close over the world set, the HUD art over the interface set', async () => {
    const world = await streamedSet();
    const ui = await streamedSet();
    const gate = new CellGate(world.closure, { objectRadius: () => 0, interfaceClosure: ui.closure });
    const out = await gate.prefetch(0xA9B40100, [fileKey('portal', world.leaf.id)], [fileKey('portal', ui.leaf.id)]);
    expect(out.ok).toBe(true);
    expect(world.store.isBundleResident(0xA9B4)).toBe(true);
    expect(ui.store.isBundleResident(0xA9B4)).toBe(false);
    expect(world.store.isResident('portal', world.leaf.id) && ui.store.isResident('portal', ui.leaf.id)).toBe(true);
  });

  it('one set for both (end of retail): interface roots join the extra roots on the one closure, as before', async () => {
    const one = await streamedSet();
    const gate = new CellGate(one.closure, { objectRadius: () => 0, interfaceClosure: one.closure });
    const roots = [fileKey('portal', one.leaf.id)];
    expect(gate.isSatisfied(0xA9B40100, [], roots)).toBe(false);
    expect((await gate.prefetch(0xA9B40100, [], roots)).ok).toBe(true);
    expect(gate.isSatisfied(0xA9B40100, roots)).toBe(true);
  });
});

describe('PrefetchStatus — CellManager::PreFetchCells / CheckPrefetchStatus\'s DDD count', () => {
  afterEach(() => { vi.useRealTimers(); });

  function status(waiting: () => number) {
    const sent: GateProgress[] = [];
    return { sent, s: new PrefetchStatus({ waiting, onProgress: (p) => sent.push(p) }) };
  }

  it('the first count is the total (done 0); later counts report total − missing; the total only grows', () => {
    let missing = 12;
    const { sent, s } = status(() => missing);
    s.begin();
    expect(sent).toEqual([{ blocking: true, done: 0, total: 12 }]);
    missing = 5; s.check();
    missing = 20; s.check(); // more found missing: total_num_cells_waiting rises
    missing = 1; s.check();
    expect(sent.slice(1)).toEqual([
      { blocking: true, done: 7, total: 12 },
      { blocking: true, done: 0, total: 20 },
      { blocking: true, done: 19, total: 20 },
    ]);
  });

  it('sends nothing while nothing is missing (PreFetchCells only notifies a non-zero count)', () => {
    let missing = 0;
    const { sent, s } = status(() => missing);
    s.begin();
    expect(sent).toEqual([]);
    missing = 3; s.check(); // the prefetch was just issued
    expect(sent).toEqual([{ blocking: true, done: 0, total: 3 }]);
  });

  it('re-checks every 5 s (___real_4014000000000000) until cleared, then sends (false, 0, 0) and zeroes the counters', () => {
    vi.useFakeTimers();
    let missing = 8;
    const { sent, s } = status(() => missing);
    s.begin();
    missing = 6;
    vi.advanceTimersByTime(PREFETCH_STATUS_POLL_MS - 1);
    expect(sent.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(sent[1]).toEqual({ blocking: true, done: 2, total: 8 });
    s.end();
    expect(sent[2]).toEqual({ blocking: false, done: 0, total: 0 });
    vi.advanceTimersByTime(PREFETCH_STATUS_POLL_MS * 3);
    expect(sent.length).toBe(3);
    s.end(); // not blocking: nothing more
    expect(sent.length).toBe(3);
    missing = 4; s.begin(); // a new hold starts its total afresh
    expect(sent[3]).toEqual({ blocking: true, done: 0, total: 4 });
    s.end();
  });

  it('counts a real store\'s in-flight downloads (DatStore.activeLoads) across a gate', async () => {
    const { bucket, store, closure } = await streamedSet();
    bucket.hold();
    const { sent, s } = status(() => store.activeLoads);
    s.begin();
    const gate = new CellGate(closure, { objectRadius: () => 0 });
    const out = gate.prefetch(0xA9B40100);
    s.check();
    expect(sent[0]).toEqual({ blocking: true, done: 0, total: 1 }); // the destination's bundle
    bucket.release();
    expect((await out).ok).toBe(true);
    expect(store.activeLoads).toBe(0);
    s.end();
    expect(sent[sent.length - 1]).toEqual({ blocking: false, done: 0, total: 0 });
  });
});

type Ev = { type: string; n: number };

describe('GatedEventQueue', () => {
  it('passes events straight through when no gate is needed', () => {
    const seen: number[] = [];
    const q = new GatedEventQueue<Ev>({ dispatch: (e) => seen.push(e.n), gateFor: () => null });
    for (let n = 1; n <= 3; n++) q.push({ type: 'message', n });
    expect(seen).toEqual([1, 2, 3]);
    expect(q.holds).toBe(0);
  });

  it('holds the arrival and everything after it, in order; lifecycle events pass; hooks run', async () => {
    const seen: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let beforeReleaseSaw: number[] = [];
    let afterRelease = 0;
    const q = new GatedEventQueue<Ev>({
      dispatch: (e) => seen.push(`${e.type}:${e.n}`),
      gateFor: (e) => (e.type === 'arrive' && e.n === 2 ? gate : null),
      passThrough: (e) => e.type === 'connected',
      beforeRelease: (queued) => { beforeReleaseSaw = queued().map((e) => e.n); return null; },
      afterRelease: () => { afterRelease++; },
    });
    q.push({ type: 'message', n: 1 });
    q.push({ type: 'arrive', n: 2 });
    q.push({ type: 'objectCreate', n: 3 });
    q.push({ type: 'connected', n: 4 });
    q.push({ type: 'message', n: 5 });
    expect(seen).toEqual(['message:1', 'connected:4']);
    expect(q.isHolding).toBe(true);
    expect(q.queuedCount).toBe(3);
    open();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['message:1', 'connected:4', 'arrive:2', 'objectCreate:3', 'message:5']);
    expect(beforeReleaseSaw).toEqual([3, 5]);
    expect(afterRelease).toBe(1);
    expect(q.isHolding).toBe(false);
  });

  it('beforeRelease sees events that keep queuing while it runs (the destination\'s CreateObject burst)', async () => {
    const seen: number[] = [];
    let open!: () => void;
    let sawLater: number[] = [];
    const q = new GatedEventQueue<Ev>({
      dispatch: (e) => seen.push(e.n),
      gateFor: (e) => (e.n === 1 ? new Promise<void>((r) => { open = r; }) : null),
      beforeRelease: (queued) => new Promise<void>((r) => setTimeout(() => { sawLater = queued().map((e) => e.n); r(); }, 5)),
    });
    q.push({ type: 'arrive', n: 1 });
    open();
    await new Promise((r) => setTimeout(r, 0));
    q.push({ type: 'objectCreate', n: 2 }); // arrives during beforeRelease
    await new Promise((r) => setTimeout(r, 20));
    expect(sawLater).toEqual([2]);
    expect(seen).toEqual([1, 2]);
  });

  it('settleBurst waits for a quiet window, bounded', async () => {
    let t = 0;
    let n = 0;
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms; if (t <= 200) n++; } };
    expect(await settleBurst(() => n, { quietMs: 100, maxMs: 1000, pollMs: 50, ...clock })).toBe(4);
    expect(t).toBeGreaterThanOrEqual(300); // last change at 200, then 100 quiet
    t = 0; n = 0;
    const always = { now: () => t, sleep: async (ms: number) => { t += ms; n++; } };
    await settleBurst(() => n, { quietMs: 100, maxMs: 400, pollMs: 50, ...always });
    expect(t).toBeLessThanOrEqual(450);
  });

  it('a failed gate still releases (the player is never trapped)', async () => {
    const seen: number[] = [];
    const q = new GatedEventQueue<Ev>({ dispatch: (e) => seen.push(e.n), gateFor: (e) => (e.n === 1 ? Promise.reject(new Error('x')) : null) });
    q.push({ type: 'arrive', n: 1 });
    q.push({ type: 'message', n: 2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([1, 2]);
  });

  it('a second arrival queued behind the first holds again after the first releases', async () => {
    const seen: number[] = [];
    const opens: Array<() => void> = [];
    const q = new GatedEventQueue<Ev>({
      dispatch: (e) => seen.push(e.n),
      gateFor: (e) => (e.type === 'arrive' ? new Promise<void>((r) => opens.push(r)) : null),
    });
    q.push({ type: 'arrive', n: 1 });
    q.push({ type: 'message', n: 2 });
    q.push({ type: 'arrive', n: 3 });
    q.push({ type: 'message', n: 4 });
    opens[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([1, 2]);
    expect(q.holds).toBe(2);
    opens[1]();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('clear() drops what was held (the session ended)', async () => {
    const seen: number[] = [];
    let open!: () => void;
    const q = new GatedEventQueue<Ev>({ dispatch: (e) => seen.push(e.n), gateFor: (e) => (e.n === 1 ? new Promise<void>((r) => { open = r; }) : null) });
    q.push({ type: 'arrive', n: 1 });
    q.push({ type: 'message', n: 2 });
    q.clear();
    open();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([]);
    q.push({ type: 'message', n: 3 });
    expect(seen).toEqual([3]);
  });

  it('clear() mid-hold still ends the hold through afterRelease, once (the next login opens its own tunnel)', async () => {
    // Coldeve 2026-10-12: a session that ended while the login gate held left
    // main.ts's "the gate opened the tunnel" flag set; the next login skipped
    // its tunnel, the animation never finished and LoginComplete never went
    // out (ACE kept the player Teleporting: Hidden, too busy, no attacks).
    let tunnelOpenedByGate = false;
    let afterRelease = 0;
    let open!: () => void;
    const seen: number[] = [];
    const q = new GatedEventQueue<Ev>({
      dispatch: (e) => seen.push(e.n),
      gateFor: (e) => {
        if (e.type !== 'arrive') return null;
        tunnelOpenedByGate = true;
        return new Promise<void>((r) => { open = r; });
      },
      afterRelease: () => { afterRelease++; tunnelOpenedByGate = false; },
    });
    q.push({ type: 'arrive', n: 1 });
    expect(tunnelOpenedByGate).toBe(true);
    q.clear();
    expect(afterRelease).toBe(1);
    expect(tunnelOpenedByGate).toBe(false);
    open(); // the dropped session's prefetch settles later: nothing more happens
    await new Promise((r) => setTimeout(r, 0));
    expect(afterRelease).toBe(1);
    expect(seen).toEqual([]);
    q.clear(); // not holding: no hook
    expect(afterRelease).toBe(1);
  });

  it('why it matters: ending an animation that is Off never finishes it, so nothing sends LoginComplete', () => {
    const anim = new TeleportAnimation();
    anim.end(0);
    let finished = false;
    for (let t = 0; t < 30; t += 0.1) if (anim.update(t, 0).finished) finished = true;
    expect(finished).toBe(false);
    // Begun first (what showArrivalTunnel now guarantees), the same end finishes.
    const ok = new TeleportAnimation();
    ok.begin(TeleportAnimState.Tunnel, 0);
    ok.end(0.1);
    let done = false;
    for (let t = 0.1; t < 30; t += 0.05) if (ok.update(t, 0).finished) { done = true; break; }
    expect(done).toBe(true);
  });
});

describe('ArrivalEvents', () => {
  const me = 0x50000001;
  const updatePosition = (guid: number, cell: number) => {
    const p = new Uint8Array(32);
    const dv = new DataView(p.buffer);
    dv.setUint32(0, guid, true); dv.setUint32(4, 0, true); dv.setUint32(8, cell, true);
    return { type: 'message', data: { type: 'direct', opcode: GameMessageOpcode.UpdatePosition, payload: p } };
  };

  it('login / re-creation: our CreateObject with a position', () => {
    const ev = { type: 'objectCreate', data: { guid: me, position: { landblock: 0xA9B40019 } } };
    expect(arrivalCellOf(ev, { playerGuid: me, teleportPending: false, worldSession: true })).toBe(0xA9B40019);
    expect(arrivalCellOf({ type: 'objectCreate', data: { guid: 0x80000001, position: { landblock: 1 } } }, { playerGuid: me, teleportPending: false, worldSession: true })).toBeNull();
    expect(arrivalCellOf({ type: 'objectCreate', data: { guid: me, position: null } }, { playerGuid: me, teleportPending: false, worldSession: true })).toBeNull();
    expect(arrivalCellOf(ev, { playerGuid: null, teleportPending: false, worldSession: true })).toBeNull();
  });

  it('teleport: our UpdatePosition only while a PlayerTeleport is pending', () => {
    expect(arrivalCellOf(updatePosition(me, 0x01F60289), { playerGuid: me, teleportPending: true, worldSession: true })).toBe(0x01F60289);
    expect(arrivalCellOf(updatePosition(me, 0x01F60289), { playerGuid: me, teleportPending: false, worldSession: true })).toBeNull();
    expect(arrivalCellOf(updatePosition(0x80000002, 0x01F60289), { playerGuid: me, teleportPending: true, worldSession: true })).toBeNull();
  });

  it('outside a world session nothing is an arrival (the old character\'s guid is kept after a logoff)', () => {
    const create = { type: 'objectCreate', data: { guid: me, position: { landblock: 0xA9B40019 } } };
    expect(arrivalCellOf(create, { playerGuid: me, teleportPending: false, worldSession: false })).toBeNull();
    expect(arrivalCellOf(updatePosition(me, 0x01F60289), { playerGuid: me, teleportPending: true, worldSession: false })).toBeNull();
  });

  it('worldSessionLive: from the enter request until the world is torn down', () => {
    const life = new SessionLifecycle();
    let gameStarted = false;
    const live = () => worldSessionLive({ gameStarted, inWorld: life.inWorld, enterWorldPending: life.enterWorldPending });
    expect(live()).toBe(false); // character select
    life.noteEnterWorldRequested(me);
    expect(live()).toBe(true); // the enter under way (a pre-game PlayerTeleport still counts: BUG.6)
    life.noteWorldEntered();
    expect(live()).toBe(true); // PlayerCreate: the login hold
    gameStarted = true;
    life.noteLoggedOut(); // RequestLogOff's prepare
    expect(live()).toBe(true); // the logoff's seconds: the world is still up
    gameStarted = false; // CharacterLogOff → teardownWorldState
    expect(live()).toBe(false);
    life.noteEnterWorldRequested(me);
    expect(live()).toBe(true); // the next login
    life.noteDisconnected();
    expect(live()).toBe(false); // a drop before the world
  });

  it('an object\'s appearance roots: setup, motion table, palettes, texture + part swaps', () => {
    const roots = appearanceRoots({
      setupId: 0x02000001, motionTableId: 0x09000001, basePalette: 0x04000B6D,
      subPalettes: [{ paletteId: 0x04001071 }, { paletteId: 0x04001071 }],
      textureChanges: [{ newTexture: 0x05000C2C }], animPartChanges: [{ partId: 0x01000123 }],
    });
    expect(roots.length).toBe(6);
    expect(roots).toContain(fileKey('portal', 0x05000C2C));
    expect(queuedObjectRoots([{ type: 'message' }, { type: 'objectCreate', data: { setupId: 0x02000002 } }])).toEqual([fileKey('portal', 0x02000002)]);
  });
});

/**
 * BUG.logout-tunnel-over-charselect (production 2026-11-25, end of retail, trace
 * 01133ebcb3d8b00c): a logout reached character select, and 80 ms after the
 * CharacterList the portal tunnel was up over it until the tab closed (14.5 s).
 * ACE sends a tick's UIQueue (CharacterLogOff, CharacterList) before its
 * SmartboxQueue (PlayerTeleport, UpdatePosition, CreateObject), so the old
 * character's last teleport can land after the logoff. The gate kept the old guid
 * and took that position as an arrival: it opened the tunnel and held, and the
 * released UpdatePosition found no world (onUpdatePosition needs gameStarted), so
 * nothing ever ended the tunnel. This is main.ts's gate wiring (gateFor /
 * passThrough / afterRelease / onPlayerTeleport / onCharacterLogOff →
 * teardownWorldState) over the real GatedEventQueue, SessionLifecycle and
 * ArrivalEvents; `guarded: false` is the build before the fix.
 */
describe('the session gate across a logout (BUG.logout-tunnel-over-charselect)', () => {
  const me = 0x50000001;
  const FAR = 0x01F60289; // a destination that is not resident: the gate holds for it
  type Ev = { type: string; data?: unknown };
  const updatePosition = (cell: number): Ev => {
    const p = new Uint8Array(32);
    const dv = new DataView(p.buffer);
    dv.setUint32(0, me, true); dv.setUint32(8, cell, true);
    return { type: 'message', data: { type: 'direct', opcode: GameMessageOpcode.UpdatePosition, payload: p } };
  };
  const playerTeleport: Ev = { type: 'playerTeleport' };
  const logOff: Ev = { type: 'characterLogOff' };
  const charList: Ev = { type: 'characterList' };
  const login = (cell: number): Ev => ({ type: 'objectCreate', data: { guid: me, position: { landblock: cell } } });

  function client(guarded: boolean) {
    const life = new SessionLifecycle();
    const holds: Array<() => void> = [];
    const c = {
      life, gameStarted: false, pendingTeleport: false, tunnel: false, tunnelOpenedByGate: false,
      seen: [] as string[], teleportsApplied: [] as number[], screen: 'character-select',
    };
    const live = () => worldSessionLive({ gameStarted: c.gameStarted, inWorld: life.inWorld, enterWorldPending: life.enterWorldPending });
    const teardown = () => { c.pendingTeleport = false; c.tunnel = false; c.tunnelOpenedByGate = false; c.gameStarted = false; };
    const q: GatedEventQueue<Ev> = new GatedEventQueue<Ev>({
      dispatch: (e) => {
        c.seen.push(e.type);
        if (e.type === 'playerTeleport') {
          if (guarded && !live()) return;
          c.pendingTeleport = true;
        } else if (e.type === 'message') {
          const cell = arrivalCellOf(e, { playerGuid: me, teleportPending: true, worldSession: true });
          if (c.pendingTeleport && c.gameStarted && cell !== null) {
            c.pendingTeleport = false;
            c.teleportsApplied.push(cell);
            c.tunnel = true; // handleTeleportToPosition → showArrivalTunnel; its load ends it later
          }
        } else if (e.type === 'objectCreate') {
          if (guarded && !live()) return; // onSessionEvent: the ended session's CreateObject
          c.gameStarted = true; c.screen = 'game'; // startGame
        } else if (e.type === 'playerCreate') {
          life.noteWorldEntered();
        } else if (e.type === 'characterLogOff') {
          life.noteLoggedOut();
          if (c.gameStarted) teardown();
        } else if (e.type === 'characterList') {
          c.screen = 'character-select';
        }
      },
      passThrough: (e) => {
        if (e.type === 'disconnected') { q.clear(); life.noteDisconnected(); if (c.gameStarted) teardown(); }
        return e.type === 'disconnected';
      },
      gateFor: (e) => {
        const dest = arrivalCellOf(e, { playerGuid: me, teleportPending: c.pendingTeleport, worldSession: guarded ? live() : true });
        if (dest === null) return null;
        if (!c.tunnelOpenedByGate) { c.tunnel = true; c.tunnelOpenedByGate = true; }
        return new Promise<void>((r) => holds.push(r));
      },
      afterRelease: () => { c.tunnelOpenedByGate = false; },
    });
    const enterWorld = (cell: number) => {
      life.noteEnterWorldRequested(me);
      q.push({ type: 'playerCreate' });
      q.push(login(cell));
    };
    const releaseAll = async () => { while (holds.length) { holds.shift()!(); await new Promise((r) => setTimeout(r, 0)); } };
    return { c, q, enterWorld, releaseAll, endTunnel: () => { c.tunnel = false; } };
  }

  async function inWorld(guarded: boolean) {
    const k = client(guarded);
    k.enterWorld(FAR);
    expect(k.q.isHolding).toBe(true); // the login hold, under its own tunnel
    expect(k.c.tunnel).toBe(true);
    await k.releaseAll();
    k.endTunnel(); // startGame's endPortalSpace
    expect(k.c.gameStarted).toBe(true);
    return k;
  }

  it('before the fix: the old character\'s late teleport raises the tunnel over character select, for good', async () => {
    const k = await inWorld(false);
    k.c.life.noteLoggedOut(); // RequestLogOff
    k.q.push(logOff);
    k.q.push(charList);
    expect(k.c.screen).toBe('character-select');
    expect(k.c.tunnel).toBe(false);
    k.q.push(playerTeleport); // SmartboxQueue, after the UIQueue in ACE's last flush
    k.q.push(updatePosition(FAR));
    expect(k.q.isHolding).toBe(true);
    expect(k.c.tunnel).toBe(true); // the production page_left screen="portal-space"
    await k.releaseAll();
    expect(k.c.teleportsApplied).toEqual([]); // no world to arrive in: nothing ends it
    expect(k.c.tunnel).toBe(true);
  });

  it('after the fix: no hold and no tunnel at character select, and no teleport left pending for the next login', async () => {
    const k = await inWorld(true);
    k.c.life.noteLoggedOut();
    k.q.push(logOff);
    k.q.push(charList);
    k.q.push(playerTeleport);
    k.q.push(updatePosition(FAR));
    k.q.push({ type: 'serverName' });
    expect(k.q.isHolding).toBe(false);
    expect(k.c.tunnel).toBe(false);
    expect(k.c.pendingTeleport).toBe(false);
    expect(k.c.seen.slice(-5)).toEqual(['characterLogOff', 'characterList', 'playerTeleport', 'message', 'serverName']);
  });

  it('the old character\'s CreateObject after the logoff neither holds nor starts a world over character select', async () => {
    const before = await inWorld(false);
    before.c.life.noteLoggedOut();
    before.q.push(logOff);
    before.q.push(charList);
    before.q.push(login(FAR));
    expect(before.q.isHolding).toBe(true); // the old build: a login hold over character select
    expect(before.c.tunnel).toBe(true);
    await before.releaseAll();
    expect(before.c.gameStarted).toBe(true); // …then startGame with no enter request

    const k = await inWorld(true);
    k.c.life.noteLoggedOut();
    k.q.push(logOff);
    k.q.push(charList);
    k.q.push(login(FAR));
    expect(k.q.isHolding).toBe(false);
    expect(k.c.tunnel).toBe(false);
    expect(k.c.gameStarted).toBe(false);
    expect(k.c.screen).toBe('character-select');
  });

  it('a teleport in the logoff\'s seconds (the world still up) is still held and still arrives', async () => {
    const k = await inWorld(true);
    k.c.life.noteLoggedOut(); // RequestLogOff: inWorld is over, the world is not
    k.q.push(playerTeleport);
    k.q.push(updatePosition(FAR));
    expect(k.q.isHolding).toBe(true);
    k.q.push(logOff); // waits behind the hold, in order
    k.q.push(charList);
    expect(k.c.gameStarted).toBe(true);
    await k.releaseAll();
    expect(k.c.teleportsApplied).toEqual([FAR]);
    expect(k.c.seen.slice(-3)).toEqual(['message', 'characterLogOff', 'characterList']);
    expect(k.c.tunnel).toBe(false); // the teardown took the arrival's tunnel with it
    expect(k.q.isHolding).toBe(false);
  });

  it('a logout then a new login: a clean gate, and the login gets its own tunnel and hold', async () => {
    const k = await inWorld(true);
    k.c.life.noteLoggedOut();
    k.q.push(logOff);
    k.q.push(charList);
    k.q.push(playerTeleport);
    k.q.push(updatePosition(FAR));
    expect(k.q.queuedCount).toBe(0);
    k.enterWorld(0xA9B40019);
    expect(k.q.isHolding).toBe(true);
    expect(k.c.tunnel).toBe(true);
    expect(k.c.tunnelOpenedByGate).toBe(true);
    await k.releaseAll();
    expect(k.c.gameStarted).toBe(true);
    // In the world again, a teleport is held and delivered as before.
    k.endTunnel();
    k.q.push(playerTeleport);
    k.q.push(updatePosition(FAR));
    expect(k.q.isHolding).toBe(true);
    await k.releaseAll();
    expect(k.c.teleportsApplied).toEqual([FAR]);
  });

  it('a bridge handover (same session) keeps holding and delivers what queued behind the hold, in order', async () => {
    const k = await inWorld(true);
    k.q.push(playerTeleport);
    k.q.push(updatePosition(FAR));
    expect(k.q.isHolding).toBe(true);
    // The handover swaps the socket only: no lifecycle event, the session's messages keep coming.
    k.q.push({ type: 'handover' });
    k.q.push({ type: 'objectCreateOther' });
    expect(k.q.queuedCount).toBe(3);
    await k.releaseAll();
    expect(k.c.teleportsApplied).toEqual([FAR]);
    expect(k.c.seen.slice(-3)).toEqual(['message', 'handover', 'objectCreateOther']);
  });

  it('a drop mid-hold drops the held events and the gate\'s tunnel; the resume\'s login holds afresh', async () => {
    const k = await inWorld(true);
    k.q.push(playerTeleport);
    k.q.push(updatePosition(FAR));
    k.q.push({ type: 'objectCreateOther' });
    expect(k.q.isHolding).toBe(true);
    k.q.push({ type: 'disconnected' });
    expect(k.q.isHolding).toBe(false);
    expect(k.q.queuedCount).toBe(0);
    expect(k.c.tunnelOpenedByGate).toBe(false);
    expect(k.c.tunnel).toBe(false);
    k.enterWorld(FAR); // the resume re-enters
    expect(k.q.isHolding).toBe(true);
    expect(k.c.tunnel).toBe(true);
  });
});
