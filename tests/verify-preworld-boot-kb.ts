/**
 * RELEASE.preworld-boot-stage — boot telemetry's doneKB / totalKB describe one
 * download, never done > total.
 *
 * Evidence (production bridge, build 83c4ab48, a warm-cache visitor who left
 * after 1 s): `outcome="page_left" screen="boot" stage="world_init"
 * progress=100 doneKB=6570 totalKB=5835 cache="warm"`.
 *
 * Root cause: openStreamingDats reports (done, total) over DatStore.open's
 * manifest + boot/local/skeleton packs, then grows the total by the pre-world
 * layouts' art (`firstTotal + artTotal`). main()'s bootStreamedDats sends the
 * patch meter one Begin on the first report and never re-sends it, but sends
 * every byte as Downloaded — so the reporter's total missed the art its done
 * count included. The meter keeps exactly those events (it reads 100% at the
 * Begin's total); StreamedPatchFeed's `grew` tells the reporter the extra bytes.
 *
 * Drives the real openStreamingDats over a real-gzip set built from the EoL
 * DATs (the real PREWORLD_LAYOUTS and their art), warm from a primed object
 * cache, through the real StreamedPatchFeed into the real PatchStatus meter
 * and the real PreworldReporter.
 */
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { parseMasterProperty, setMasterPropertyTypes } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { layoutArtIds } from '../packages/renderer/src/dat/streaming/DatClosure.js';
import { MemoryObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { openStreamingDats, PREWORLD_LAYOUTS } from '../packages/renderer/src/dat/streaming/StreamingDats.js';
import { PreworldReporter, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { PatchStatus, StreamedPatchFeed, patchProgressText, type PatchEvent } from '../packages/renderer/src/ui/PatchScreen.js';
import { FakeBucket, buildManifest, buildPack } from './_harness/datSet.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const HAVE_DATS = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);
const BASE = 'https://dats.test';
const ITERATION = 0xffff0001;

function reporter(): PreworldReporter {
  return new PreworldReporter({
    endpoint: null, build: 'test', era: () => 'eor', server: () => null, screen: () => 'boot',
    now: () => 0, trace: 'feedc0de12345678', send: () => {},
  });
}

type Snap = Pick<PreworldEvent, 'progress' | 'doneKB' | 'totalKB'>;

/** main()'s bootStreamedDats over one set: feed → meter (onPatchEvent → PatchStatus) + reporter. */
function bootSet(r: PreworldReporter, meter: PatchStatus, running: { bytes: number }, opts: { wholeBytes?: number; withGrew?: boolean } = {}) {
  const events: PatchEvent[] = [];
  const snaps: Snap[] = [];
  const feed = new StreamedPatchFeed({
    wholeBytes: opts.wholeBytes ?? 0,
    announce: (bytes) => (running.bytes += bytes),
    emit: (e) => { events.push(e); r.bootPatchEvent(e); meter.onEvent(e); snaps.push(r.bootSnapshot()); },
    ...(opts.withGrew === false ? {} : { grew: (bytes: number) => r.bootPatchGrew(bytes) }),
  });
  return { feed, events, snaps };
}

describe.skipIf(!HAVE_DATS)('boot KiB over a warm streamed boot (real EoL pre-world layouts)', () => {
  let bucket: FakeBucket;
  let pointer: unknown;
  let firstTotal = 0;
  let artFiles = 0;

  beforeAll(() => {
    const portal: DatDatabase = openDat(DAT_PATHS.portal);
    const local: DatDatabase = openDat(DAT_PATHS.local);
    const read = (db: DatDatabase, id: number) => new Uint8Array(db.getFileData(id)!);
    setMasterPropertyTypes(parseMasterProperty(new DatReader(portal.getFileData(0x39000001)!)));
    bucket = new FakeBucket();
    const pack = (files: Array<{ id: number; data: Uint8Array }>) => ({ ...bucket.put(buildPack(files)), files: files.length });
    const packs = {
      boot: pack([{ id: 0x39000001, data: read(portal, 0x39000001) }]),
      local: pack(local.listFileIds(0x21).filter((id) => id !== ITERATION).map((id) => ({ id, data: read(local, id) }))),
      skeleton: pack([{ id: 0x13000000, data: read(portal, 0x13000000) }]),
      world: pack([]),
      terrain: pack([]),
    };
    // Every pre-world layout's art is a leaf (what the published set does: not in the boot packs).
    const art = layoutArtIds(local, PREWORLD_LAYOUTS).filter((id) => portal.hasFile(id));
    artFiles = art.length;
    const leaves = art.map((id) => ({ id, ...bucket.put(read(portal, id)) }));
    const role = { boot: 1, world: 2, skeleton: 3, terrain: 4, local: 5 } as const;
    const manifest = bucket.put(buildManifest({
      leaves: { portal: leaves },
      packs: (Object.keys(packs) as Array<keyof typeof packs>).map((r) => ({ role: role[r], ...packs[r] })),
    }));
    pointer = {
      format: 1, set: 'test-eol', iterations: { portal: 2072, cell: 982, local: 994, highres: 497 },
      manifest: { key: `v1/o/${manifest.hash}`, hash: manifest.hash, size: manifest.size, gzSize: manifest.gzSize },
      packs: Object.fromEntries(Object.entries(packs).map(([r, p]) => [r, { key: `v1/o/${p.hash}`, size: p.size, gzSize: p.gzSize, files: p.files }])),
    };
    firstTotal = manifest.gzSize + packs.boot.gzSize + packs.local.gzSize + packs.skeleton.gzSize;
  });

  const open = (cache: MemoryObjectCache, onProgress: (d: number, t: number) => void, fetchObject = bucket.fetch) => openStreamingDats({
    pointerUrl: `${BASE}/v1/sets/test-eol.json`,
    fetchPointer: async () => JSON.parse(JSON.stringify(pointer)),
    fetchObject,
    cache,
    onProgress,
  });

  async function warmBoot(withGrew: boolean) {
    const cache = new MemoryObjectCache();
    const cold = await open(cache, () => {});
    await cold.worldPacks;
    await new Promise((res) => setTimeout(res, 0)); // cache writes are fire-and-forget
    const r = reporter();
    const meter = new PatchStatus();
    const b = bootSet(r, meter, { bytes: 0 }, { withGrew });
    const warm = await open(cache, (d, t) => b.feed.onProgress(d, t), async () => { throw new Error('network used on a warm profile'); });
    b.feed.finish();
    expect(warm.store.stats.netObjects).toBe(0);
    return { r, meter, ...b, warm };
  }

  it('reproduces the overcount: the art arrives as Downloaded after the one Begin (without grew, done > total)', async () => {
    const { r, events, warm } = await warmBoot(false);
    expect(artFiles).toBeGreaterThan(0);
    expect(warm.bootReport.preWorldArtFiles).toBeGreaterThan(0);
    const begins = events.filter((e) => e.kind === 'begin');
    expect(begins).toEqual([{ kind: 'begin', expected: firstTotal }]);
    const downloaded = events.reduce((s, e) => s + (e.kind === 'downloaded' ? e.bytes : 0), 0);
    expect(downloaded).toBeGreaterThan(firstTotal);
    const snap = r.bootSnapshot();
    expect(snap.doneKB!).toBeGreaterThan(snap.totalKB!); // the production line's shape
  });

  it('with grew, doneKB never exceeds totalKB and both end on the same bytes; the meter is unchanged', async () => {
    const { r, meter, events, snaps } = await warmBoot(true);
    // The meter: one Begin at the first total, the same Downloaded bytes, "100% of <first>K".
    expect(events.filter((e) => e.kind === 'begin')).toEqual([{ kind: 'begin', expected: firstTotal }]);
    expect(meter.expected).toBe(firstTotal);
    expect(meter.level).toBe(1);
    expect(meter.label.text).toBe(patchProgressText(1, firstTotal));
    const downloaded = events.reduce((s, e) => s + (e.kind === 'downloaded' ? e.bytes : 0), 0);
    for (const s of snaps) expect(s.doneKB!).toBeLessThanOrEqual(s.totalKB!);
    expect(r.bootSnapshot()).toMatchObject({ progress: 100, doneKB: Math.trunc(downloaded / 1024), totalKB: Math.trunc(downloaded / 1024) });
    // DDD_PatchtimeEnd (main() before side_tables): still the same download.
    r.bootPatchEvent({ kind: 'end' });
    expect(r.bootSnapshot()).toMatchObject({ progress: 100, doneKB: Math.trunc(downloaded / 1024), totalKB: Math.trunc(downloaded / 1024) });
  });
});

describe('boot KiB across two sets and whole DATs (AC1999: interface set + world set)', () => {
  it('a later Begin re-announces the running total; the first set\'s growth stays added', () => {
    const r = reporter();
    const meter = new PatchStatus();
    const running = { bytes: 0 };
    // The interface set: 1000 B of packs, then 300 B of pre-world art; whole DATs of 500 B on the same meter.
    const ui = bootSet(r, meter, running, { wholeBytes: 500 });
    ui.feed.onProgress(400, 1000);
    ui.feed.onProgress(1000, 1000);
    ui.feed.onProgress(1000, 1300);
    ui.feed.onProgress(1300, 1300);
    // The world set reports after it: its Begin carries the running total (1500 + 200).
    const world = bootSet(r, meter, running);
    world.feed.onProgress(200, 200);
    world.feed.finish();
    // The whole DATs' bytes (fetchDat's Downloaded).
    r.bootPatchEvent({ kind: 'downloaded', bytes: 500 });
    expect(world.events[0]).toEqual({ kind: 'begin', expected: 1700 });
    expect(meter.expected).toBe(1700); // the meter: unchanged events
    const snap = r.bootSnapshot();
    expect(snap.totalKB).toBe(Math.trunc(2000 / 1024));
    expect(snap.doneKB).toBe(Math.trunc(2000 / 1024));
    expect(snap.progress).toBe(100);
    for (const s of [...ui.snaps, ...world.snaps]) expect(s.doneKB!).toBeLessThanOrEqual(s.totalKB!);
  });

  it('a set that never reports still announces the whole DATs once; one that reported does not re-announce', () => {
    const r = reporter();
    const running = { bytes: 0 };
    const quiet = bootSet(r, new PatchStatus(), running, { wholeBytes: 4096 });
    quiet.feed.finish();
    quiet.feed.finish();
    expect(quiet.events).toEqual([{ kind: 'begin', expected: 4096 }]);
    const loud = bootSet(r, new PatchStatus(), running);
    loud.feed.onProgress(10, 10);
    loud.feed.finish();
    expect(loud.events).toEqual([{ kind: 'begin', expected: 4106 }, { kind: 'downloaded', bytes: 10 }]);
    // Growth of zero or a smaller total is no growth.
    r.bootPatchGrew(0);
    r.bootPatchGrew(-5);
    expect(r.bootSnapshot().totalKB).toBe(Math.trunc(4106 / 1024));
  });
});
