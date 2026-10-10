/**
 * REND.per-frame-allocations — per-frame work made allocation-free /
 * sub-quadratic without changing output:
 *  - RadarDotFeed (the animate() radar populate) reuses its dot array,
 *    records and fellow set, with gmRadarUI::DrawObjects' semantics;
 *  - ParticleSystem expires by one stable compaction pass (survivors keep
 *    their buffer / draw order) and reuses dead particles' vectors;
 *  - TextureManager's LRU lives in the cache Maps' insertion order;
 *  - DegradeLod.updateParts memoizes the ancestor walk per parent per call;
 *  - DungeonCollision floor queries skip cells whose polygons can't lie
 *    under the probe (identical results to the full scan).
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { makePlane } from '@ac/shared';
import type { PhysicsPolygon } from '@ac/shared';
import {
  RadarDotFeed, RadarBlipShape, selectBlipShape, allegianceMember, blipInRange, isPK, isPKLite,
  radarOffsetFromWorld, selectBlipColor, radarRgbaToCss, type RadarFeedContext, type RadarFeedObject,
} from '../packages/renderer/src/ui/RadarBlips.js';
import { ParticleSystem } from '@ac/renderer/effects/ParticleSystem.js';
import type { ParticleEmitterInfo } from '@ac/dat-parser/file-types/ParticleEmitterInfo.js';
import { TextureManager } from '@ac/renderer/models/TextureManager.js';
import { DegradeLod, type DegradeChain } from '../packages/renderer/src/models/DegradeLod.js';
import { DungeonCollision } from '@ac/renderer/world/DungeonCollision.js';
import type { GfxObjLOD } from '@ac/dat-parser';

/* ─────────────── radar ─────────────── */

interface Obj extends RadarFeedObject { eligible: boolean }

function mkCtx(over: Partial<RadarFeedContext<Obj>> = {}): RadarFeedContext<Obj> {
  return {
    playerWorldX: 100, playerWorldZ: 200, playerFeetY: 10, range: 75,
    fellows: null, fellowshipLeaderGuid: 0, playerMonarchGuid: undefined, playerPKStatus: undefined,
    eligible: (o) => o.eligible,
    ...over,
  };
}

/** The pre-change per-frame populate, verbatim semantics (radarOffsetFromWorld + selectBlipShape literal). */
function referenceDots(objs: Obj[], ctx: RadarFeedContext<Obj>) {
  const fellowGuids = new Set<number>(ctx.fellows ? ctx.fellows.map(f => f.guid) : []);
  const out: Array<{ dx: number; dz: number; dy: number; color: string; guid: number; shape: number; name: string }> = [];
  for (const obj of objs) {
    if (!ctx.eligible(obj)) continue;
    const { dx, dz } = radarOffsetFromWorld(obj.worldX, obj.worldZ, ctx.playerWorldX, ctx.playerWorldZ);
    if (!blipInRange(dx, dz, ctx.range)) continue;
    const shape = selectBlipShape({
      isFellow: fellowGuids.has(obj.guid),
      isFellowshipLeader: obj.guid === ctx.fellowshipLeaderGuid,
      isAllegianceMember: allegianceMember(obj.monarchGuid, ctx.playerMonarchGuid),
      objIsPK: isPK(obj.playerKillerStatus), playerIsPK: isPK(ctx.playerPKStatus),
      objIsPKLite: isPKLite(obj.playerKillerStatus), playerIsPKLite: isPKLite(ctx.playerPKStatus),
    });
    const color = radarRgbaToCss(selectBlipColor({
      blipColor: obj.radarColor, objectDescFlags: obj.objectDescFlags ?? 0, itemType: obj.itemType ?? 0,
      isFellow: fellowGuids.has(obj.guid), isFellowshipLeader: obj.guid === ctx.fellowshipLeaderGuid,
    }));
    out.push({ dx, dz, dy: obj.worldY - ctx.playerFeetY, color, guid: obj.guid, shape, name: obj.name });
  }
  return out;
}

function obj(guid: number, x: number, z: number, over: Partial<Obj> = {}): Obj {
  return { guid, worldX: x, worldY: 12, worldZ: z, radarColor: 2, name: `o${guid}`, eligible: true, ...over };
}

describe('RadarDotFeed — the animate() radar populate', () => {
  const objs: Obj[] = [
    obj(1, 110, 190),                                          // near, NE
    obj(2, 100 + 73.9, 200),                                   // just inside (range-1)=74
    obj(3, 100 + 74, 200),                                     // on the (range-1) edge → out
    obj(4, 90, 210, { eligible: false }),                      // culled by radarDotEligible
    obj(5, 101, 201, { monarchGuid: 0x5001 }),                 // allegiance member
    obj(6, 102, 202, { playerKillerStatus: 0x04 }),            // PK
    obj(7, 103, 203, { playerKillerStatus: 0x40, radarColor: 5 }), // PKLite
    obj(8, 104, 204),                                          // fellow
    obj(9, 105, 205),                                          // fellowship leader
  ];

  it('matches the reference populate for every blip-shape branch and the range edge', () => {
    const feed = new RadarDotFeed<Obj>();
    const ctx = mkCtx({
      fellows: [{ guid: 8 }, { guid: 9 }], fellowshipLeaderGuid: 9,
      playerMonarchGuid: 0x5001, playerPKStatus: 0x04 | 0x40,
    });
    const dots = feed.build(objs, ctx);
    expect(dots.map(d => ({ ...d }))).toEqual(referenceDots(objs, ctx));
    const byGuid = new Map(dots.map(d => [d.guid, d.shape]));
    expect(byGuid.has(3)).toBe(false);
    expect(byGuid.has(4)).toBe(false);
    expect(byGuid.get(5)).toBe(RadarBlipShape.AllegianceMember);
    expect(byGuid.get(6)).toBe(RadarBlipShape.Threat);
    expect(byGuid.get(7)).toBe(RadarBlipShape.Threat);
    expect(byGuid.get(8)).toBe(RadarBlipShape.Fellowship);
    expect(byGuid.get(9)).toBe(RadarBlipShape.FellowshipLeader);
    // dz is metres SOUTH (worldZ = AC north): object 1 sits 10 m south → dz +10.
    expect(dots.find(d => d.guid === 1)!.dz).toBe(10);
  });

  it('reuses the array + records frame to frame, and re-reads an in-place roster edit', () => {
    const feed = new RadarDotFeed<Obj>();
    const fellows = [{ guid: 8 }];
    const ctx = mkCtx({ fellows });
    const a = feed.build(objs, ctx);
    const rec0 = a[0];
    expect(a.find(d => d.guid === 8)!.shape).toBe(RadarBlipShape.Fellowship);
    fellows[0] = { guid: 1 }; // same array, different member
    ctx.playerWorldX = 104; ctx.playerWorldZ = 204;
    const b = feed.build(objs, ctx);
    expect(b).toBe(a);
    expect(b[0]).toBe(rec0);
    expect(b.map(d => ({ ...d }))).toEqual(referenceDots(objs, ctx));
    expect(b.find(d => d.guid === 8)!.shape).toBe(RadarBlipShape.Default);
    // Fewer blips next frame: the array shrinks, nothing stale remains.
    const c = feed.build([objs[0]], ctx);
    expect(c).toHaveLength(1);
    expect(c[0].guid).toBe(1);
  });
});

/* ─────────────── particles ─────────────── */

function makeInfo(overrides: Partial<ParticleEmitterInfo>): ParticleEmitterInfo {
  return {
    id: 0, emitterType: 1, particleType: 1 /* Still */, gfxObjId: 0, hwGfxObjId: 0,
    birthrate: 0, maxParticles: 100, initialParticles: 0, totalParticles: 0, totalSeconds: 0,
    lifespan: 100, lifespanRand: 0,
    offsetDir: { x: 0, y: 0, z: 1 }, minOffset: 0, maxOffset: 0,
    a: { x: 0, y: 0, z: 0 }, minA: 0, maxA: 0,
    b: { x: 0, y: 0, z: 0 }, minB: 0, maxB: 0,
    c: { x: 0, y: 0, z: 0 }, minC: 0, maxC: 0,
    startScale: 1, finalScale: 1, scaleRand: 0, startTrans: 0, finalTrans: 0, transRand: 0, isParentLocal: 0,
    ...overrides,
  } as ParticleEmitterInfo;
}

function bufferPositions(sys: ParticleSystem): string[] {
  const out: string[] = [];
  for (let i = 0; i < sys.activeCount; i++) {
    const p = sys.positionAt(i);
    out.push(`${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`);
  }
  return out;
}

describe('ParticleSystem — O(n) expiry keeps survivors in order; dead particles are reused', () => {
  it('FIFO lifetimes: the buffer is always the newest k spawns in spawn order, with freshly randomized offsets', () => {
    // Still particles with a random perpendicular offset each: every spawn
    // lands at its own fixed point. One per 0.1 s, each living 0.35 s.
    const sys = new ParticleSystem(makeInfo({ birthrate: 0.1, lifespan: 0.35, maxOffset: 2, minOffset: 0 }));
    const spawned: string[] = [];
    for (let step = 0; step < 40; step++) {
      const before = sys.totalEmittedCount;
      sys.update(0.1);
      const buf = bufferPositions(sys);
      const k = sys.totalEmittedCount - before; // new spawns append at the end
      if (k > 0) spawned.push(...buf.slice(buf.length - k));
      expect(buf).toEqual(spawned.slice(spawned.length - buf.length));
      expect(buf.length).toBeLessThanOrEqual(4);
    }
    expect(new Set(spawned).size).toBe(spawned.length); // reused particles got new offsets
  });

  it('mixed lifetimes: survivors keep their relative order (normal-blend draw order)', () => {
    // lifespanRand spreads deaths out of spawn order.
    const rand = vi.spyOn(Math, 'random');
    let seed = 7;
    rand.mockImplementation(() => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; });
    try {
      // A long interval: only the burst is alive (birthrate 0 would emit one
      // per update — ParticleEmitter::UpdateParticles).
      const sys = new ParticleSystem(makeInfo({ initialParticles: 60, lifespan: 1, lifespanRand: 0.9, maxOffset: 3, birthrate: 100 }));
      const initial = bufferPositions(sys);
      expect(initial).toHaveLength(60);
      sys.update(0.8);
      const survivors = bufferPositions(sys);
      expect(survivors.length).toBeGreaterThan(0);
      expect(survivors.length).toBeLessThan(60);
      // survivors is an in-order subsequence of initial
      let j = 0;
      for (const p of initial) if (j < survivors.length && survivors[j] === p) j++;
      expect(j).toBe(survivors.length);
    } finally {
      rand.mockRestore();
    }
  });

  it('an expired particle (and its vectors) is reused by the next spawn — steady state allocates no particles', () => {
    const sys = new ParticleSystem(makeInfo({ birthrate: 0.1, lifespan: 0.25, maxOffset: 1 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = sys as any;
    // 0.11 s updates: every update is past the 0.1 s interval → exactly one
    // emission per update (DECOMP.emitter-backlog), a steady 2–3 alive.
    const seen = new Set<object>();
    const seenVec = new Set<object>();
    for (let i = 0; i < 10; i++) {
      sys.update(0.11);
      for (const p of internals.particles) { seen.add(p); seenVec.add(p.offset); seenVec.add(p.a); }
      for (const p of internals.pool) { seen.add(p); seenVec.add(p.offset); seenVec.add(p.a); }
    }
    const warm = seen.size;
    for (let i = 0; i < 50; i++) {
      sys.update(0.11);
      for (const p of internals.particles) {
        expect(seen.has(p)).toBe(true);
        expect(seenVec.has(p.offset)).toBe(true);
        expect(seenVec.has(p.a)).toBe(true);
      }
    }
    expect(seen.size).toBe(warm);
    expect(sys.totalEmittedCount).toBeGreaterThan(50);
  });
});

/* ─────────────── TextureManager LRU ─────────────── */

/** A 0x06 Texture file: id, unknown, w, h, format, length 0 (→ blank RGBA). */
function textureFile(id: number): ArrayBuffer {
  const b = new ArrayBuffer(24);
  const v = new DataView(b);
  v.setUint32(0, id, true); v.setInt32(4, 0, true); v.setInt32(8, 1, true); v.setInt32(12, 1, true);
  v.setUint32(16, 21, true); v.setInt32(20, 0, true);
  return b;
}
/** A 0x05 SurfaceTexture with one level. */
function surfaceTextureFile(id: number, tex: number): ArrayBuffer {
  const b = new ArrayBuffer(17);
  const v = new DataView(b);
  v.setUint32(0, id, true); v.setInt32(4, 0, true); v.setUint8(8, 0); v.setInt32(9, 1, true); v.setUint32(13, tex, true);
  return b;
}
function fakeDb() {
  const reads: number[] = [];
  const db = {
    getFileData(id: number): ArrayBuffer | null {
      reads.push(id);
      if ((id >>> 24) === 0x06) return textureFile(id);
      if ((id >>> 24) === 0x05) return surfaceTextureFile(id, 0x06000000 | (id & 0xffff));
      return null;
    },
    hasFile(id: number) { return (id >>> 24) === 0x06 || (id >>> 24) === 0x05; },
  };
  return { db, reads };
}

describe('TextureManager — LRU in Map insertion order', () => {
  it('RGBA cache: a hit refreshes recency; the least recently used entry is evicted', () => {
    const { db, reads } = fakeDb();
    const tm = new TextureManager(db as never, 0, 3);
    for (const id of [0x06000001, 0x06000002, 0x06000003]) tm.getDirectRGBA(id);
    tm.getDirectRGBA(0x06000001); // hit → most recent; order 2,3,1
    expect(reads.filter(r => r === 0x06000001)).toHaveLength(1);
    tm.getDirectRGBA(0x06000004); // evicts 2
    expect(tm.stats.rgbaEntries).toBe(3);
    reads.length = 0;
    tm.getDirectRGBA(0x06000001); tm.getDirectRGBA(0x06000003); tm.getDirectRGBA(0x06000004);
    expect(reads).toEqual([]); // all still cached
    tm.getDirectRGBA(0x06000002);
    expect(reads).toEqual([0x06000002]); // was evicted → re-read
  });

  it('texture cache: evicts the LRU entry without disposing it (sweep() owns disposal); 0 = unlimited', () => {
    const { db } = fakeDb();
    const tm = new TextureManager(db as never, 2, 0);
    const disposed: number[] = [];
    const t1 = tm.getTexture(0x05000001)!; t1.addEventListener('dispose', () => disposed.push(1));
    const t2 = tm.getTexture(0x05000002)!; t2.addEventListener('dispose', () => disposed.push(2));
    expect(tm.getTexture(0x05000001)).toBe(t1); // hit → t2 is now LRU
    tm.getTexture(0x05000003);
    expect(disposed).toEqual([]); // PERF.browser-memory-crash: eviction forgets only
    expect(tm.getTexture(0x05000001)).toBe(t1);
    expect(tm.stats.textures).toBe(2);
    tm.sweep(new Set([t1]));
    expect(disposed).toEqual([2]);

    const { db: db2 } = fakeDb();
    const unlimited = new TextureManager(db2 as never, 0, 0);
    for (let i = 1; i <= 50; i++) unlimited.getTexture(0x05000000 + i);
    expect(unlimited.stats.textures).toBe(50);
    expect(unlimited.stats.rgbaEntries).toBe(50);
  });
});

/* ─────────────── DegradeLod ancestor memo ─────────────── */

const GFX = 0x01000100;
function lod(gfxObjId: number, min: number, ideal: number, max: number): GfxObjLOD {
  return { gfxObjId, degradeMode: 1, minDist: min, idealDist: ideal, maxDist: max };
}
const CHAIN: DegradeChain = {
  infoId: 0x11000000,
  degrades: [lod(GFX, 10, 25, 50), lod(0x01000101, 25, 50, 100), lod(0, 1e38, 1e38, 1e38)],
  levelIds: [GFX, 0x01000101, 0],
  sortCenter: new THREE.Vector3(),
};
function meshGroup(): THREE.Object3D {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  return g;
}

describe('DegradeLod.updateParts — per-call ancestor memo', () => {
  function setup() {
    const lodSys = new DegradeLod(null);
    lodSys.setChain(GFX, CHAIN);
    const scene = new THREE.Scene();
    const holder = new THREE.Group(); // e.g. the landblock group
    scene.add(holder);
    const obj = new THREE.Group();
    obj.position.set(500, 0, 0); // far → INVALID (level 2) when degradable
    holder.add(obj);
    const parts = [0, 1, 2].map(() => {
      const p = new THREE.Group();
      p.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
      obj.add(p);
      expect(lodSys.attachPart(p, GFX, () => meshGroup())).toBe(true);
      return p;
    });
    scene.updateMatrixWorld(true);
    return { lodSys, scene, holder, obj, parts };
  }

  it('a no-degrade mark on a grandparent applies to every sibling part; clearing it is seen next frame', () => {
    const { lodSys, holder, parts } = setup();
    holder.userData[DegradeLod.NO_DEGRADE_KEY] = true;
    lodSys.updateParts(new THREE.Vector3());
    for (const p of parts) expect(p.userData.acDegrade.level).toBe(0);
    delete holder.userData[DegradeLod.NO_DEGRADE_KEY];
    lodSys.updateParts(new THREE.Vector3());
    for (const p of parts) expect(p.userData.acDegrade.level).toBe(2);
  });

  it('a part moved between frames under a detached group is pruned; its siblings are kept', () => {
    const { lodSys, parts } = setup();
    lodSys.updateParts(new THREE.Vector3());
    expect(lodSys.partCount).toBe(3);
    const limbo = new THREE.Group();
    limbo.add(parts[0]);
    lodSys.updateParts(new THREE.Vector3());
    expect(lodSys.partCount).toBe(2);
  });

  it("a part's own LAND_CELL_KEY still counts even when a sibling under the same parent lacks it", () => {
    const { lodSys, obj, parts } = setup();
    obj.position.set(0, 200, 90); // 219 m 3-D; land cell centre (12, 84) → 84.9 m 2-D
    obj.updateMatrixWorld(true);
    parts[0].userData[DegradeLod.LAND_CELL_KEY] = true;
    lodSys.updateParts(new THREE.Vector3());
    // cell path: 84.9 − 50 = 34.9 → level 1; object path: 219 − 50 → INVALID
    expect(parts[0].userData.acDegrade.level).toBe(1);
    expect(parts[1].userData.acDegrade.level).toBe(2);
  });
});

/* ─────────────── DungeonCollision floor queries ─────────────── */

describe('DungeonCollision floor queries — per-cell XY bounds reject', () => {
  const T = Math.tan(15 * Math.PI / 180);
  function ramp(): PhysicsPolygon {
    const vertices = [
      { x: -2, y: -2, z: -2 * T }, { x: 2, y: -2, z: -2 * T },
      { x: 2, y: 2, z: 2 * T }, { x: -2, y: 2, z: 2 * T },
    ];
    return { vertices, plane: makePlane(vertices), numPts: 4 };
  }
  function mockGfx(poly: PhysicsPolygon) {
    const vertices = new Map<number, unknown>();
    poly.vertices.forEach((v, i) => vertices.set(i, { origin: v, normal: { x: 0, y: 0, z: 1 }, uvs: [] }));
    return {
      physicsBSP: { rootNode: { type: 'LEAF', solid: 0, sphere: { origin: { x: 0, y: 0, z: 0 }, radius: 100 }, inPolys: [0] } },
      physicsPolygons: new Map([[0, { vertexIndices: [0, 1, 2, 3], numVertices: 4, stippling: 0, sidesType: 0, portalIndex: -1, polyId: 0 }]]),
      vertexArray: { vertices },
    } as never;
  }
  interface Placement { key: number; origin: { x: number; y: number; z: number }; quat: { w: number; x: number; y: number; z: number }; bx: number; by: number }

  it('every probe answers exactly as a collision holding only the cells under it would', () => {
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const placements: Placement[] = [];
    for (let i = 0; i < 40; i++) {
      const yaw = rnd() * Math.PI * 2;
      placements.push({
        key: i + 1,
        origin: { x: 20 + rnd() * 150, y: 20 + rnd() * 150, z: 5 + rnd() * 2 },
        quat: { w: Math.cos(yaw / 2), x: 0, y: 0, z: Math.sin(yaw / 2) },
        bx: (i % 3) * 192, by: (i % 2) * 192,
      });
    }
    const all = new DungeonCollision();
    for (const p of placements) all.addGfxObjCollision(p.key, mockGfx(ramp()), p.origin, p.quat, p.bx, p.by);

    let hits = 0;
    for (const p of placements) {
      const single = new DungeonCollision();
      single.addGfxObjCollision(p.key, mockGfx(ramp()), p.origin, p.quat, p.bx, p.by);
      // Probes at the ramp centre, near its rotated corners (inside), and
      // just outside an edge — in world coords (block offset added back).
      const yaw = 2 * Math.atan2(p.quat.z, p.quat.w);
      const probes: Array<[number, number]> = [[0, 0], [1.99, 1.99], [-1.99, 1.99], [1.99, -1.99], [2.01, 0], [0, -2.01]];
      for (const [lx, ly] of probes) {
        const gx = p.origin.x + lx * Math.cos(yaw) - ly * Math.sin(yaw) + p.bx;
        const gy = p.origin.y + lx * Math.sin(yaw) + ly * Math.cos(yaw) + p.by;
        // Reference: the full scan restricted to the cells whose polygon
        // contains the probe — computed with the single-cell collisions.
        const expectH = (() => {
          const hs = placements.map(q => {
            const s = new DungeonCollision();
            s.addGfxObjCollision(q.key, mockGfx(ramp()), q.origin, q.quat, q.bx, q.by);
            return s.getFloorHeight(gx, gy, p.origin.z);
          }).filter((h): h is number => h !== null);
          return hs;
        })();
        const h = all.getFloorHeight(gx, gy, p.origin.z);
        if (expectH.length === 0) expect(h).toBeNull();
        else { expect(h).not.toBeNull(); hits++; }
        const own = single.getFloorHeight(gx, gy, p.origin.z);
        if (own !== null) {
          const n = all.getFloorNormal(gx, gy, own);
          expect(n).not.toBeNull();
          expect(Math.hypot(n!.x, n!.y, n!.z)).toBeCloseTo(1, 6);
        }
      }
    }
    expect(hits).toBeGreaterThan(100);
  });

  it('a rotated, block-offset cell still reports its ramp normal right at the polygon edge', () => {
    const dc = new DungeonCollision();
    const q = { w: Math.cos(Math.PI / 4), x: 0, y: 0, z: Math.sin(Math.PI / 4) }; // +90° about z
    dc.addGfxObjCollision(1, mockGfx(ramp()), { x: 10, y: 10, z: 5 }, q, 192, 384);
    // Local (1.999, 0) → landblock (10, 11.999) → world (202, 395.999).
    const y = dc.getFloorHeight(202, 395.999, 5);
    expect(y).not.toBeNull();
    const n = dc.getFloorNormal(202, 395.999, y!)!;
    expect(n).not.toBeNull();
    expect(n.y).toBeCloseTo(Math.cos(15 * Math.PI / 180), 6);
    expect(dc.getFloorNormal(202, 396.1, y!)).toBeNull(); // off the ramp
  });

  it('a SCALED source keeps its floor: the bounds reject uses the scaled footprint', () => {
    // Merge guard: the XY-bounds reject (REND.per-frame-allocations) must be
    // taken through the source's scale (ObjectCollision scaled BSPs, ACE
    // CacheLocalSpaceSphere(pos, scale)) or it rejects real hits.
    const dc = new DungeonCollision();
    dc.addGfxObjCollision(1, mockGfx(ramp()), { x: 10, y: 10, z: 5 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0, 2);
    // Local ramp spans ±2 m; at scale 2 it spans ±4 m. Probe 3 m out.
    expect(dc.getFloorHeight(13, 10, 5.5)).not.toBeNull();
    expect(dc.getFloorHeight(14.5, 10, 5.5)).toBeNull();
  });
});
