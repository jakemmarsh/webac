/**
 * RELEASE.portal-space-cell-gate — the retail CellManager gate:
 * CellGate (CellManager::PreFetchCells / CheckPrefetchStatus) holds an
 * arrival until the destination is resident, GatedEventQueue is the
 * blocking_for_cells stop over the session's events, and ArrivalEvents picks
 * the events that place our player.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameMessageOpcode } from '../packages/network/src/GameMessageOpcode.js';
import { CellGate, GatedEventQueue, PREFETCH_STATUS_POLL_MS, PrefetchStatus, settleBurst, type GateProgress } from '../packages/renderer/src/dat/streaming/PortalSpaceGate.js';
import { DatClosure } from '../packages/renderer/src/dat/streaming/DatClosure.js';
import { DatStore, fileKey } from '../packages/renderer/src/dat/streaming/DatStore.js';
import { appearanceRoots, arrivalCellOf, queuedObjectRoots } from '../packages/renderer/src/dat/streaming/ArrivalEvents.js';
import { MemoryObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { FakeBucket, buildManifest, buildPack } from './_harness/datSet.js';

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
    expect(arrivalCellOf(ev, { playerGuid: me, teleportPending: false })).toBe(0xA9B40019);
    expect(arrivalCellOf({ type: 'objectCreate', data: { guid: 0x80000001, position: { landblock: 1 } } }, { playerGuid: me, teleportPending: false })).toBeNull();
    expect(arrivalCellOf({ type: 'objectCreate', data: { guid: me, position: null } }, { playerGuid: me, teleportPending: false })).toBeNull();
    expect(arrivalCellOf(ev, { playerGuid: null, teleportPending: false })).toBeNull();
  });

  it('teleport: our UpdatePosition only while a PlayerTeleport is pending', () => {
    expect(arrivalCellOf(updatePosition(me, 0x01F60289), { playerGuid: me, teleportPending: true })).toBe(0x01F60289);
    expect(arrivalCellOf(updatePosition(me, 0x01F60289), { playerGuid: me, teleportPending: false })).toBeNull();
    expect(arrivalCellOf(updatePosition(0x80000002, 0x01F60289), { playerGuid: me, teleportPending: true })).toBeNull();
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
