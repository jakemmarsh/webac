/**
 * BUG.dungeon-login-black (Reddit, The Tower, ACE, end of retail, 2026-11-07; bridge trace 72.85.247.229).
 *
 * "Today when I tried I'm getting a blackscreened gameworld. I can tell everything is loaded up just not seeing
 * anything." Four logins into the dungeon 0x5950 (Firefox 159, GTX 980 via ANGLE D3D11) each sent a first_minute
 * event saying the world was drawn (worldDrawnMs 6-8 s, thousands of world frames, ~475 draw calls and 10-13k
 * triangles a frame, errors 0, no lost context, a healthy cache: cacheBypassed 0, hedges 0). The day before, on
 * ab9b02a28, the same character had played 40 minutes there (fights and casts up to the tab close).
 *
 * Every package change between the builds was read for a way to do that, and none was found: the stray-body
 * rule of 5a407a377 (DungeonCollision.strayScope, STRAY_CELL_REACH) only decides which collision sources a body
 * outside every cell volume meets — the dungeon's drawing follows findCellContaining and the cell PVS, never the
 * scope — and its snap / MovementSync guards run outdoors only; the landscape detail pass is off in end of retail
 * (EraWorldRules.landscapeDetailTextures null) and patches terrain programs only; the slow-cache bypass never
 * started (the sessions' char_list says so). The DAT side, swept here, holds up too: every 0x5950 cell builds,
 * every cell's centre sees lit front faces through its own PVS, and the 3 m rule releases no cell centre in any
 * dungeon of the end-of-retail cell.dat.
 *
 * With nothing to reproduce it, the first_minute event now says what was on screen: a luma sample of the world
 * canvas read right after a world draw (scene/CanvasLuma.ts, WorldReporter lumaMean / lumaDarkPct / lumaAtMs)
 * and the indoor view (viewCell, viewCellFound, cameraCell, visibleCells), whitelisted by the bridge.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import {
  WorldReporter, lumaStats, LUMA_DARK, LUMA_FIRST_MS, LUMA_EVERY_MS, LUMA_SAMPLE_W, LUMA_SAMPLE_H,
  type WorldEvent, type FirstMinuteEvent, type LumaSample, type IndoorViewState,
} from '../packages/renderer/src/telemetry/WorldReporter';
import { sampleCanvasLuma, type LumaScratch } from '../packages/renderer/src/scene/CanvasLuma';
import { sanitizeClientWorld } from '../services/ws-tcp-bridge/src/clientWorld';
import { CLIENT_PREWORLD_MAX_BODY } from '../services/ws-tcp-bridge/src/clientPreworld';
import { DAT_PATHS, openDat } from './_harness/dat.js';

// ── Telemetry ─────────────────────────────────────────────────────────

function rig(indoor: () => IndoorViewState | null = () => null) {
  const events: WorldEvent[] = [];
  const clock = { t: 1000 };
  const asks: Array<(s: LumaSample | null) => void> = [];
  const r = new WorldReporter({
    endpoint: 'http://x/client-preworld', build: 'abc1234', trace: 'feedc0de12345678', era: () => 'eor', server: () => 'the-tower',
    now: () => clock.t, send: (_u, b) => { events.push(JSON.parse(b) as WorldEvent); }, cpuProbe: () => 0.8,
  });
  r.setSources({
    screen: () => 'world', canvas: () => ({ width: 2500, height: 1300 }), dpr: () => 1,
    requestLuma: (done) => { asks.push(done); },
    indoorView: indoor,
  });
  return { r, events, clock, asks };
}
const first = (events: WorldEvent[]) => events.find((e) => e.outcome === 'first_minute') as FirstMinuteEvent;
/** One second: a frame (drawn or not) and the reporter's tick. */
function second(r: WorldReporter, clock: { t: number }, drawn: boolean): void {
  clock.t += 1000;
  r.frame(clock.t, drawn, 5);
  r.tick();
}

/** RGBA bytes of `n` pixels of one colour. */
function pixels(n: number, rgb: [number, number, number]): Uint8Array {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) out.set([...rgb, 255], i * 4);
  return out;
}

describe('BUG.dungeon-login-black — lumaStats', () => {
  it('a black frame: mean 0, every sample dark', () => {
    expect(lumaStats(pixels(LUMA_SAMPLE_W * LUMA_SAMPLE_H, [0, 0, 0]))).toEqual({ mean: 0, darkPct: 100 });
  });
  it('a lit frame: the Rec. 709 mean of the bytes, none dark', () => {
    expect(lumaStats(pixels(10, [200, 100, 50]))).toEqual({ mean: Math.round(0.2126 * 200 + 0.7152 * 100 + 0.0722 * 50), darkPct: 0 });
  });
  it('a quarter of the frame lit: the dark share is 75 %', () => {
    const a = pixels(4, [0, 0, 0]);
    a.set([255, 255, 255, 255], 0);
    expect(lumaStats(a)).toEqual({ mean: 64, darkPct: 75 });
    // Just under the dark line counts dark; at it, not.
    expect(lumaStats(pixels(1, [LUMA_DARK - 1, LUMA_DARK - 1, LUMA_DARK - 1]))!.darkPct).toBe(100);
    expect(lumaStats(pixels(1, [LUMA_DARK, LUMA_DARK, LUMA_DARK]))!.darkPct).toBe(0);
  });
  it('no pixels: null', () => {
    expect(lumaStats(new Uint8Array(0))).toBeNull();
  });
});

describe('BUG.dungeon-login-black — sampleCanvasLuma reads a downscale of the world canvas', () => {
  function scratch(rgb: [number, number, number] | 'throw' | 'no2d') {
    const calls: unknown[][] = [];
    const s: LumaScratch = {
      width: 300, height: 150,
      getContext: () => rgb === 'no2d' ? null : {
        drawImage: (...a: unknown[]) => { calls.push(a); if (rgb === 'throw') throw new Error('SecurityError'); },
        getImageData: (_x, _y, w, h) => ({ data: pixels(w * h, rgb as [number, number, number]) }),
      },
    };
    return { s, calls };
  }
  it('draws the whole canvas into LUMA_SAMPLE_W × LUMA_SAMPLE_H and reads it', () => {
    const src = { width: 2500, height: 1300 };
    const { s, calls } = scratch([0, 0, 0]);
    expect(sampleCanvasLuma(src, s)).toEqual({ mean: 0, darkPct: 100 });
    expect(calls).toEqual([[src, 0, 0, LUMA_SAMPLE_W, LUMA_SAMPLE_H]]);
    expect([s.width, s.height]).toEqual([LUMA_SAMPLE_W, LUMA_SAMPLE_H]);
  });
  it('a canvas with no size, no 2D context or a failing read: null, never a throw', () => {
    expect(sampleCanvasLuma({ width: 0, height: 0 }, scratch([9, 9, 9]).s)).toBeNull();
    expect(sampleCanvasLuma(null, scratch([9, 9, 9]).s)).toBeNull();
    expect(sampleCanvasLuma({ width: 10, height: 10 }, scratch('no2d').s)).toBeNull();
    expect(sampleCanvasLuma({ width: 10, height: 10 }, scratch('throw').s)).toBeNull();
  });
});

describe('BUG.dungeon-login-black — first_minute says what was on screen', () => {
  const dungeon: IndoorViewState = { cell: 0x5950012d, cellFound: true, cameraCell: 0x5950012d, visibleCells: 214 };

  it('the reported shape: drawn at 6 s, left at 15 s — the event carries a black sample and the dungeon view', () => {
    const { r, events, clock, asks } = rig(() => dungeon);
    r.enteredWorld();
    for (let i = 0; i < 5; i++) second(r, clock, false);        // portal space: no world draw, nothing asked
    expect(asks).toHaveLength(0);
    second(r, clock, true);                                       // the first world draw at 6 s
    expect(asks).toHaveLength(0);                                 // asked LUMA_FIRST_MS later, not at once
    for (let i = 0; i < LUMA_FIRST_MS / 1000; i++) second(r, clock, true);
    expect(asks).toHaveLength(1);
    asks[0]({ mean: 1, darkPct: 100 });                           // the frame after that draw
    const tookAt = clock.t;
    for (let i = 0; i < 7; i++) second(r, clock, true);
    r.left('closed_tab');
    const ev = first(events);
    expect(ev).toMatchObject({
      exit: 'closed_tab', lumaMean: 1, lumaDarkPct: 100, lumaAtMs: tookAt - 1000,
      viewCell: '5950012d', viewCellFound: true, cameraCell: '5950012d', visibleCells: 214,
    });
  });

  it('later samples replace earlier ones (every LUMA_EVERY_MS), one in flight at a time', () => {
    const { r, events, clock, asks } = rig();
    r.enteredWorld();
    second(r, clock, true);
    for (let i = 0; i < LUMA_FIRST_MS / 1000; i++) second(r, clock, true);
    expect(asks).toHaveLength(1);
    // Unanswered (the world stopped drawing): no second request piles up.
    for (let i = 0; i < LUMA_EVERY_MS / 1000 + 2; i++) second(r, clock, true);
    expect(asks).toHaveLength(1);
    asks[0]({ mean: 3, darkPct: 99 });
    for (let i = 0; i < LUMA_EVERY_MS / 1000; i++) second(r, clock, true);
    expect(asks).toHaveLength(2);
    asks[1]({ mean: 80, darkPct: 4 });
    while (!events.some((e) => e.outcome === 'first_minute')) second(r, clock, true);
    expect(first(events)).toMatchObject({ exit: 'still_in', lumaMean: 80, lumaDarkPct: 4, viewCell: null, viewCellFound: null, cameraCell: null, visibleCells: null });
  });

  it('a sample that could not be read, or one landing after the next login, is not reported', () => {
    const { r, events, clock, asks } = rig();
    r.enteredWorld();
    second(r, clock, true);
    for (let i = 0; i < LUMA_FIRST_MS / 1000; i++) second(r, clock, true);
    asks[0](null);
    r.left('logout');
    r.enteredWorld();
    second(r, clock, true);
    for (let i = 0; i < LUMA_FIRST_MS / 1000; i++) second(r, clock, true);
    const stale = asks[1];
    r.left('logout');
    r.enteredWorld();
    stale({ mean: 200, darkPct: 0 });                             // the previous session's frame
    r.left('logout');
    const minutes = events.filter((e) => e.outcome === 'first_minute') as FirstMinuteEvent[];
    expect(minutes).toHaveLength(3);
    for (const m of minutes) expect(m).toMatchObject({ lumaMean: null, lumaDarkPct: null, lumaAtMs: null });
  });

  it('a camera out of every cell reads 00000000; a throwing source sends nulls', () => {
    const { r, events, clock } = rig(() => ({ cell: 0x59500100, cellFound: false, cameraCell: 0, visibleCells: 0 }));
    r.enteredWorld();
    second(r, clock, true);
    r.left('logout');
    expect(first(events)).toMatchObject({ viewCell: '59500100', viewCellFound: false, cameraCell: '00000000', visibleCells: 0 });
    const t = rig(() => { throw new Error('boom'); });
    t.r.enteredWorld();
    second(t.r, t.clock, true);
    t.r.left('logout');
    expect(first(t.events)).toMatchObject({ viewCell: null, viewCellFound: null, cameraCell: null, visibleCells: null });
  });

  it('the bridge keeps the fields, drops malformed ones, and the body stays under the cap', () => {
    const { r, events, clock, asks } = rig(() => dungeon);
    r.enteredWorld();
    second(r, clock, true);
    for (let i = 0; i < LUMA_FIRST_MS / 1000; i++) second(r, clock, true);
    asks[0]({ mean: 255, darkPct: 0 });
    r.left('closed_tab');
    const ev = first(events);
    const out = sanitizeClientWorld(ev) as FirstMinuteEvent;
    expect(out).toMatchObject({ lumaMean: 255, lumaDarkPct: 0, viewCell: '5950012d', viewCellFound: true, cameraCell: '5950012d', visibleCells: 214 });
    expect(out.lumaAtMs).toBe(ev.lumaAtMs);
    const bad = sanitizeClientWorld({ ...ev, lumaMean: 256, lumaDarkPct: 101, viewCell: '5950012D', cameraCell: 'x; rm', viewCellFound: 'yes', visibleCells: -1 }) as FirstMinuteEvent;
    expect(bad).toMatchObject({ lumaMean: null, lumaDarkPct: null, viewCell: null, cameraCell: null, viewCellFound: null, visibleCells: null });
    // An older page sends none of them: none appear.
    const older = { ...ev } as Record<string, unknown>;
    for (const k of ['lumaMean', 'lumaDarkPct', 'lumaAtMs', 'viewCell', 'viewCellFound', 'cameraCell', 'visibleCells']) delete older[k];
    expect(Object.keys(sanitizeClientWorld(older)!)).not.toContain('viewCell');
    expect(JSON.stringify({ ...ev, gpuName: 'x'.repeat(96) }).length).toBeLessThan(CLIENT_PREWORLD_MAX_BODY);
  });
});

// ── The dungeon 0x5950 and every dungeon's cells (end-of-retail DATs) ─────────

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);
const LB = 0x5950;
const GEO = ((LB << 16) | 0xffff) >>> 0;
const BX = (LB >> 8) * 192;
const BY = (LB & 0xff) * 192;

type Dc = import('../packages/renderer/src/world/DungeonCollision').DungeonCollision;
type Ecr = import('../packages/renderer/src/world/EnvCellRenderer').EnvCellRenderer;

/** Rotate p by the unit quaternion q (w, x, y, z). */
function rotate(q: { w: number; x: number; y: number; z: number }, p: { x: number; y: number; z: number }) {
  const { w, x, y, z } = q;
  const ix = w * p.x + y * p.z - z * p.y, iy = w * p.y + z * p.x - x * p.z, iz = w * p.z + x * p.y - y * p.x, iw = -x * p.x - y * p.y - z * p.z;
  return { x: ix * w - iw * x - iy * z + iz * y, y: iy * w - iw * y - iz * x + ix * z, z: iz * w - iw * z - ix * y + iy * x };
}

/** The cell's vertex bounds in its landblock's frame (the CellStruct through the cell's Frame). */
function cellBounds(ecr: Ecr, id: number) {
  const d = ecr.getCellCollisionData(id);
  if (!d) return null;
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const v of (d.cellStruct.vertexArray.vertices as Map<number, { origin: { x: number; y: number; z: number } }>).values()) {
    const r = rotate(d.position.orientation, v.origin);
    const p = { x: d.position.origin.x + r.x, y: d.position.origin.y + r.y, z: d.position.origin.z + r.z };
    lo.x = Math.min(lo.x, p.x); lo.y = Math.min(lo.y, p.y); lo.z = Math.min(lo.z, p.z);
    hi.x = Math.max(hi.x, p.x); hi.y = Math.max(hi.y, p.y); hi.z = Math.max(hi.z, p.z);
  }
  return Number.isFinite(lo.x) ? { lo, hi, data: d } : null;
}

describe.skipIf(!haveDat)('BUG.dungeon-login-black — the dungeon 0x5950 (end of retail)', () => {
  let ecr: Ecr;
  let dr: import('../packages/renderer/src/world/DungeonRenderer').DungeonRenderer;
  let dc: Dc;
  let group: THREE.Group;
  let ids: number[];

  beforeAll(async () => {
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { SceneryInstancer } = await import('../packages/renderer/src/terrain/SceneryInstancer.js');
    const { DungeonRenderer } = await import('../packages/renderer/src/world/DungeonRenderer.js');
    const { DungeonCollision } = await import('../packages/renderer/src/world/DungeonCollision.js');
    const { populateDungeonCollision } = await import('../packages/renderer/src/world/DungeonCollisionBuild.js');
    const portalDb = openDat(DAT_PATHS.portal);
    const cellDb = openDat(DAT_PATHS.cell);
    const mf = new MaterialFactory(portalDb, new TextureManager(portalDb));
    const mr = new ModelRenderer(portalDb, mf);
    const sr = new SetupModelRenderer(portalDb, mr);
    ecr = new EnvCellRenderer(portalDb, cellDb, mf, sr, mr);
    ecr.setInstancer(new SceneryInstancer(mr, sr));
    dr = new DungeonRenderer(cellDb, ecr);
    group = dr.initStream(GEO)!;
    dc = new DungeonCollision();
    populateDungeonCollision(dc, GEO, {
      findInteriorCells: (l: number) => dr.findInteriorCells(l),
      getCellCollisionData: (id: number) => ecr.getCellCollisionData(id),
      loadEnvCell: (id: number) => ecr.loadEnvCell(id),
      loadSetupModel: (id: number) => sr.loadSetupModel(id),
      loadGfxObj: (id: number) => mr.loadGfxObj(id),
      loadLandblockInfo: (l: number) => dr.loadLandblockInfo(l),
    });
    ids = dr.findInteriorCells(GEO);
  }, 300_000);

  it('608 sealed cells, all registered for collision', () => {
    expect(ids).toHaveLength(608);
    expect(ids.every((id) => (ecr.loadEnvCell(id)!.flags & 1) === 0)).toBe(true);
    expect(ids.every((id) => dc.hasCell(id))).toBe(true);
  });

  it('from every cell\'s centre the body stays in a cell, the PVS draws, and lit front faces are in view', () => {
    const ray = new THREE.Raycaster();
    const blind: string[] = [];
    const stray: string[] = [];
    for (const id of ids) {
      const b = cellBounds(ecr, id)!;
      const gx = BX + (b.lo.x + b.hi.x) / 2;
      const gy = BY + (b.lo.y + b.hi.y) / 2;
      const feet = b.lo.z + 0.05;
      // The body: in a cell's volume, or (a seam) kept in its own by the stray rule.
      const found = dc.findCellContaining(gx, gy, feet + 0.5, id);
      if (found === 0 && dc.nextBodyCell(id, gx, gy, feet) === 0) stray.push(id.toString(16));
      // What the frame draws: the streamed cells around the body, culled to the found cell's PVS.
      const { localX, localY } = dr.worldToLocal(gx, gy);
      dr.updateStream(localX, localY);
      dr.applyPortalVisibility(found);
      expect(dr.drawnCellCount).toBeGreaterThan(0);
      group.updateMatrixWorld(true);
      const drawn = group.children.filter((c) => c.visible);
      // Eye height above the cell floor, looking level and slightly down, 16 headings: the front faces hit.
      const eye = new THREE.Vector3(gx, feet + 1.6, gy);
      let hits = 0;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        ray.set(eye, new THREE.Vector3(Math.cos(a), -0.15, Math.sin(a)).normalize());
        const front = ray.intersectObjects(drawn, true).some((h) => {
          const mat = (h.object as THREE.Mesh).material as THREE.Material;
          if (mat.side === THREE.DoubleSide) return true;
          return h.face!.normal.clone().transformDirection(h.object.matrixWorld).dot(ray.ray.direction) < 0;
        });
        if (front) hits++;
      }
      if (hits === 0) blind.push(id.toString(16));
    }
    expect(stray).toEqual([]);
    expect(blind).toEqual([]);
  }, 300_000);

  it('a body far outside the dungeon (a stray snap) still leaves its cell (the 3 m rule, inverse)', () => {
    const id = ids[0];
    expect(dc.nextBodyCell(id, BX + 110, BY - 30 + 200, -24)).toBe(0);
    expect(dc.nextBodyCell(id, BX + 110, BY - 30, -23.95)).not.toBe(0);
  });
});

describe.skipIf(!haveDat)('BUG.dungeon-login-black — the 3 m stray rule releases no cell centre in any dungeon (end of retail)', () => {
  it('every sealed landblock\'s every cell centre, on its floor: in a cell or kept', async () => {
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { DungeonCollision } = await import('../packages/renderer/src/world/DungeonCollision.js');
    const portalDb = openDat(DAT_PATHS.portal);
    const cellDb = openDat(DAT_PATHS.cell);
    const mf = new MaterialFactory(portalDb, new TextureManager(portalDb));
    const mr = new ModelRenderer(portalDb, mf);
    const ecr = new EnvCellRenderer(portalDb, cellDb, mf, new SetupModelRenderer(portalDb, mr), mr);
    const blocks = new Map<number, number[]>();
    for (const id of cellDb.listFileIds()) {
      const lo = id & 0xffff;
      if (lo < 0x100 || lo >= 0xfffe) continue;
      const a = blocks.get(id >>> 16) ?? [];
      a.push(id >>> 0);
      blocks.set(id >>> 16, a);
    }
    let dungeons = 0;
    let strays = 0;
    const released: string[] = [];
    for (const [lb, cellIds] of blocks) {
      if (cellIds.some((id) => { const e = ecr.loadEnvCell(id); return !e || (e.flags & 1) !== 0; })) continue;
      dungeons++;
      const dc = new DungeonCollision();
      for (const id of cellIds) {
        const d = ecr.getCellCollisionData(id);
        if (d) dc.addCell(id, d.cellStruct, d.position, d.outsidePortalPolygonIds, d.neighborCellIds);
      }
      const bx = (lb >> 8) * 192, by = (lb & 0xff) * 192;
      for (const id of cellIds) {
        const b = cellBounds(ecr, id);
        if (!b) continue;
        const gx = bx + (b.lo.x + b.hi.x) / 2, gy = by + (b.lo.y + b.hi.y) / 2, feet = b.lo.z + 0.05;
        if (dc.findCellContaining(gx, gy, feet + 0.5, id) !== 0) continue;
        strays++;
        // Before 5a407a377 such a body always kept its cell (a sealed cell has no outside portal).
        if (dc.nextBodyCell(id, gx, gy, feet) === 0) released.push(id.toString(16));
      }
    }
    expect(dungeons).toBeGreaterThan(1800);
    expect(strays).toBeGreaterThan(0);
    expect(released).toEqual([]);
  }, 600_000);
});
