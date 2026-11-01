/**
 * BUG.remote-creature-obstacle-collision — remote creatures move through the static world's
 * transition, as retail moves every active physics object (CPhysicsObj::update_object @ 00515d10 →
 * UpdateObjectInternal @ 005156b0 → CPhysicsObj::transition @ 00512dc0), not only the player.
 *
 * Jake (AC1999 prod, an archer) watched a Drudge Slinker "jumping back and forth" and never reaching
 * him. The server's copy runs retail physics: it stopped at the rock between them while ours ran on
 * through it on its own MoveTo, and each 0.2 s correction pulled ours back. 8e3aa73b3 gave remote
 * creatures the walkable-slope rule; this gives them walls, buildings, rocks, trees, other creatures
 * and our character, with the step up / step down that keeps them climbing stairs and ramps.
 *
 * Drives the shipped DungeonCollision.withBody, world/RemoteTransition.ts (over the player's own
 * player/OutdoorMovement.ts step), RemotePhysicsObject and ServerObjectManager in synthetic worlds,
 * and, with the DATs, in Holtburg's real collision world (end of retail, Dark Majesty, AC1999).
 * Also measures the per-frame cost with many creatures.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { makePlane, PhysicsState, ObjectDescriptionFlag, type PhysicsPolygon } from '@ac/shared';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import {
  remoteBodyShape, remoteTransition, moverBlockedBy, remoteCollider, REMOTE_TRANSITION_RANGE,
  type RemoteBodyShape, type RemoteMove, type RemoteTransitionWorld,
} from '../packages/renderer/src/world/RemoteTransition.js';
import { RemotePhysicsObject, type RemotePhysicsEnv } from '../packages/renderer/src/world/RemotePhysics.js';
import { identityFrame, type SequenceFrame } from '../packages/renderer/src/animation/SequenceFrame.js';
import { addCreatureObstacles } from '../packages/renderer/src/world/CreatureCollision.js';
import type { MovementCreatureObstacles } from '../packages/renderer/src/player/OutdoorMovement.js';
import { TerrainCollision } from '../packages/shared/src/physics/TerrainCollision.js';
import { WaterMap } from '../packages/shared/src/physics/WaterMap.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import type { CreateObjectData } from '@ac/network';
import { DAT_PATHS, DAT_SETS_DIR } from './_harness/dat.js';

// ── Synthetic world: landblock (10, 10), flat ground at z 10 ─────────────

const BX = 10, BY = 10;
const X0 = BX * 192, Y0 = BY * 192;
const CELL = ((BX << 24) | (BY << 16) | 0x0012) >>> 0; // a land cell of the block
const GROUND = 10;

/** The Drudge Slinker's Setup 0x020007DD (end of retail portal.dat): radius, height, step heights, spheres. */
const DRUDGE_SETUP = {
  radius: 0.6165971159934998, height: 1.5295000076293945, stepUpHeight: 0.6218000054359436, stepDownHeight: 1.399999976158142,
  spheres: [{ origin: { x: 0, y: 0, z: 0.4325000047683716 }, radius: 0.4359999895095825 }, { origin: { x: 0, y: 0, z: 1.090000033378601 }, radius: 0.4359999895095825 }],
};
const DRUDGE = remoteBodyShape(DRUDGE_SETUP)!;

function terrain(rise = 0): TerrainCollision {
  const t = new TerrainCollision();
  // heights[col * 9 + row]: col along x (east), row along y (north); `rise` m per m northward.
  const h: number[] = [];
  for (let col = 0; col < 9; col++) for (let row = 0; row < 9; row++) h.push(GROUND + row * 24 * rise);
  t.setLandblock(BX, BY, { heights: h, blockX: BX, blockY: BY });
  return t;
}

function dryWater(): WaterMap {
  const w = new WaterMap();
  w.setLandblock(BX, BY, new Array(256).fill(1));
  return w;
}

function world(outdoor = new DungeonCollision(), opts: { rise?: number; dungeon?: DungeonCollision | null } = {}): RemoteTransitionWorld {
  return { outdoor, dungeon: opts.dungeon ?? null, terrain: terrain(opts.rise), water: dryWater(), waterDepthAt: () => 0 };
}

type V = [number, number, number];
function quad(v0: V, v1: V, v2: V, v3: V): PhysicsPolygon {
  const vertices = [v0, v1, v2, v3].map(([x, y, z]) => ({ x, y, z }));
  return { vertices, plane: makePlane(vertices), numPts: 4 };
}
/** A GfxObj-shaped physics source holding `polys` in one leaf (addGfxObjCollision input). */
function gfx(polys: PhysicsPolygon[], radius: number) {
  const physicsPolygons = new Map<number, unknown>();
  const vertices = new Map<number, unknown>();
  let vi = 0;
  polys.forEach((p, pi) => {
    const ids: number[] = [];
    for (const v of p.vertices) { vertices.set(vi, { origin: v, normal: { x: 0, y: 0, z: 1 }, uvs: [] }); ids.push(vi++); }
    physicsPolygons.set(pi, { vertexIndices: ids, numVertices: ids.length, stippling: 0, sidesType: 0, portalIndex: -1, polyId: pi });
  });
  return {
    physicsBSP: { rootNode: { type: 'LEAF', solid: 0, sphere: { origin: { x: 0, y: 0, z: 0 }, radius }, inPolys: [...physicsPolygons.keys()] } },
    physicsPolygons,
    vertexArray: { vertices },
  } as never;
}
/** Register `polys` (AC global coordinates) under `key`, as a part placed at their centre. */
function addPolys(dc: DungeonCollision, key: string | number, polys: PhysicsPolygon[]): DungeonCollision {
  const all = polys.flatMap((p) => p.vertices);
  const o = { x: all.reduce((a, v) => a + v.x, 0) / all.length, y: all.reduce((a, v) => a + v.y, 0) / all.length, z: 0 };
  const local = polys.map((p) => {
    const vs = p.vertices.map((v) => [v.x - o.x, v.y - o.y, v.z] as V);
    return quad(vs[0], vs[1], vs[2], vs[3]);
  });
  const radius = Math.max(...all.map((v) => Math.hypot(v.x - o.x, v.y - o.y, v.z))) + 1;
  dc.addGfxObjCollision(key, gfx(local, radius), o, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);
  return dc;
}
/** A wall in the plane x = `x`, facing −x (west), over y ∈ [y0, y1], z ∈ [z0, z1]. */
const wallX = (x: number, y0: number, y1: number, z0: number, z1: number) => quad([x, y1, z0], [x, y0, z0], [x, y0, z1], [x, y1, z1]);
/** A floor (normal +z) over [x0, x1] × [y0, y1] at height z. */
const floor = (x0: number, x1: number, y0: number, y1: number, z: number) => quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]);

/** A creature walking on its own motion: `secs` of frames at `speed` m/s along (dx, dy), its ground followed. */
function walk(
  w: RemoteTransitionWorld, start: { x: number; y: number; z: number }, dir: { x: number; y: number }, secs: number,
  opts: { shape?: RemoteBodyShape; speed?: number; cell?: number; obstacles?: MovementCreatureObstacles | null; collide?: boolean } = {},
) {
  const shape = opts.shape ?? DRUDGE;
  const speed = opts.speed ?? 4;
  const dt = 1 / 60;
  const len = Math.hypot(dir.x, dir.y);
  const pos = { ...start };
  const slide = { slidingNormal: null };
  const path: { x: number; y: number; z: number }[] = [];
  let blocked = 0;
  for (let i = 0; i < secs * 60; i++) {
    const to = { x: pos.x + (dir.x / len) * speed * dt, y: pos.y + (dir.y / len) * speed * dt };
    if (opts.collide === false) {
      pos.x = to.x; pos.y = to.y;
    } else {
      const move: RemoteMove = {
        shape, cell: opts.cell ?? CELL, from: { ...pos }, to, airborne: false, edgeSlide: false, slide,
        obstacles: opts.obstacles ?? null, wantGround: true,
      };
      const r = remoteTransition(w, move)!;
      pos.x = r.x; pos.y = r.y;
      if (r.groundZ !== null) pos.z = r.groundZ;
      if (r.blocked) blocked++;
    }
    path.push({ ...pos });
  }
  return { pos, path, blocked };
}

describe('the mover\'s shape (CTransition::init_sphere from its Setup × scale)', () => {
  it('two spheres, radius, height and step heights, scaled', () => {
    expect(DRUDGE).toEqual({
      radius: DRUDGE_SETUP.radius, height: DRUDGE_SETUP.height, stepUpHeight: DRUDGE_SETUP.stepUpHeight,
      stepDownHeight: DRUDGE_SETUP.stepDownHeight, sphereRadius: DRUDGE_SETUP.spheres[0].radius,
      sphereHeights: [DRUDGE_SETUP.spheres[0].origin.z, DRUDGE_SETUP.spheres[1].origin.z],
    });
    const big = remoteBodyShape(DRUDGE_SETUP, 2)!;
    expect(big.sphereRadius).toBeCloseTo(DRUDGE_SETUP.spheres[0].radius * 2, 9);
    expect(big.stepUpHeight).toBeCloseTo(DRUDGE_SETUP.stepUpHeight * 2, 9);
    expect(big.sphereHeights[1]).toBeCloseTo(DRUDGE_SETUP.spheres[1].origin.z * 2, 9);
  });

  it('one sphere is both feet and head; no spheres = never transitioned (UpdateObjectInternal only set_frames it)', () => {
    const one = remoteBodyShape({ ...DRUDGE_SETUP, spheres: [DRUDGE_SETUP.spheres[0]] })!;
    expect(one.sphereHeights).toEqual([DRUDGE_SETUP.spheres[0].origin.z, DRUDGE_SETUP.spheres[0].origin.z]);
    expect(remoteBodyShape({ ...DRUDGE_SETUP, spheres: [] })).toBeNull();
    expect(remoteBodyShape(null)).toBeNull();
  });
});

describe('which objects stop a mover (CPhysicsObj::FindObjCollisions @ 0050f050)', () => {
  const creature = { physicsState: PhysicsState.Gravity, objectDescFlags: 0 };
  const player = (flags = 0) => ({ physicsState: PhysicsState.Gravity, objectDescFlags: ObjectDescriptionFlag.Player | flags });
  const ethereal = { physicsState: PhysicsState.Gravity | PhysicsState.Ethereal, objectDescFlags: 0 };
  const staticObj = { physicsState: PhysicsState.Static, objectDescFlags: 0 };

  it('a creature is stopped by creatures and by players (no IgnoreCreatures in the client)', () => {
    expect(moverBlockedBy(creature, creature)).toBe(true);
    expect(moverBlockedBy(creature, player())).toBe(true);
  });
  it('an Ethereal obstacle stops nothing; an Ethereal mover passes everything but Static objects', () => {
    expect(moverBlockedBy(creature, ethereal)).toBe(false);
    expect(moverBlockedBy(ethereal, creature)).toBe(false);
    expect(moverBlockedBy(ethereal, staticObj)).toBe(true);
  });
  it('a player moving into a player is exempt unless both are PK or both PK-Lite', () => {
    expect(moverBlockedBy(player(), player())).toBe(false);
    expect(moverBlockedBy(player(ObjectDescriptionFlag.PlayerKiller), player(ObjectDescriptionFlag.PlayerKiller))).toBe(true);
    expect(moverBlockedBy(player(ObjectDescriptionFlag.PkLiteStatus), player(ObjectDescriptionFlag.PkLiteStatus))).toBe(true);
    expect(moverBlockedBy(player(ObjectDescriptionFlag.PlayerKiller), player())).toBe(false);
    expect(moverBlockedBy(player(), creature)).toBe(true);
  });
});

describe('DungeonCollision.withBody — the mover\'s shape in, the player\'s back after', () => {
  it('inside: the mover\'s spheres and step height; after: the player\'s, and its last move\'s results', () => {
    const dc = new DungeonCollision();
    dc.lastStepUp = 0.3;
    dc.collisionNormal = { x: 1, z: 0 };
    const playerLayout = dc.bodySphereLayout;
    let inside: { radius: number; heights: readonly number[] } | null = null;
    dc.withBody({ ...DRUDGE, cell: CELL }, () => {
      inside = dc.bodySphereLayout;
      expect(dc.transitionSphereRadius).toBeCloseTo(DRUDGE.sphereRadius, 9);
      expect(dc.lastStepUp).toBe(0);
      dc.lastStepUp = 0.5;
      dc.collisionNormal = { x: 0, z: 1 };
    });
    expect(inside).toEqual({ radius: DRUDGE.sphereRadius, heights: [...DRUDGE.sphereHeights] });
    expect(dc.bodySphereLayout).toEqual(playerLayout);
    expect(dc.lastStepUp).toBe(0.3);
    expect(dc.collisionNormal).toEqual({ x: 1, z: 0 });
  });

  it('restores the player\'s shape when the move throws', () => {
    const dc = new DungeonCollision();
    const before = dc.bodySphereLayout;
    expect(() => dc.withBody({ ...DRUDGE, cell: CELL }, () => { throw new Error('boom'); })).toThrow('boom');
    expect(dc.bodySphereLayout).toEqual(before);
  });
});

describe('a remote creature stops where retail\'s does', () => {
  const start = { x: X0 + 40, y: Y0 + 40, z: GROUND };

  it('a tree (CylSphere): pre-fix it ran straight through; now it stops at the trunk', () => {
    const tree = { x: X0 + 50, y: Y0 + 40, r: 0.8 };
    const dc = new DungeonCollision();
    dc.addCylinderObstacle('sc:tree', tree.x, tree.y, tree.r, GROUND, GROUND + 6);
    const through = walk(world(dc), start, { x: 1, y: 0 }, 4, { collide: false });
    expect(through.pos.x).toBeGreaterThan(tree.x + 5);
    const { pos, path } = walk(world(dc), start, { x: 1, y: 0 }, 4);
    for (const p of path) expect(Math.hypot(p.x - tree.x, p.y - tree.y)).toBeGreaterThanOrEqual(tree.r + DRUDGE.sphereRadius - 0.01);
    expect(pos.x).toBeLessThan(tree.x - tree.r);
    expect(pos.x).toBeGreaterThan(tree.x - tree.r - DRUDGE.sphereRadius - 0.3);
  });

  it('a glancing run slides round the trunk and goes on (no freeze)', () => {
    const tree = { x: X0 + 50, y: Y0 + 40.6, r: 0.8 };
    const dc = new DungeonCollision();
    dc.addCylinderObstacle('sc:tree', tree.x, tree.y, tree.r, GROUND, GROUND + 6);
    const { pos } = walk(world(dc), start, { x: 1, y: 0 }, 5);
    expect(pos.x).toBeGreaterThan(tree.x + 3);
  });

  it('a boulder (Setup sphere) stops it too', () => {
    const rock = { x: X0 + 50, y: Y0 + 40, z: GROUND + 0.5, r: 1.5 };
    const dc = new DungeonCollision();
    dc.addSphereObstacle('sc:rock', rock.x, rock.z, rock.y, rock.r);
    const { pos } = walk(world(dc), start, { x: 1, y: 0 }, 4);
    expect(pos.x).toBeLessThan(rock.x - 1);
  });

  it('a building wall stops it; the doorway in the wall lets it through', () => {
    const wx = X0 + 50;
    const dc = addPolys(new DungeonCollision(), 'bl:wall', [
      wallX(wx, Y0 + 30, Y0 + 39, GROUND - 1, GROUND + 4),
      wallX(wx, Y0 + 41, Y0 + 50, GROUND - 1, GROUND + 4),
    ]);
    const wall = walk(world(dc), { ...start, y: Y0 + 35 }, { x: 1, y: 0 }, 4);
    expect(wall.pos.x).toBeLessThan(wx);
    expect(wall.pos.x).toBeGreaterThan(wx - DRUDGE.sphereRadius - 0.3);
    const door = walk(world(dc), { ...start, y: Y0 + 40 }, { x: 1, y: 0 }, 4);
    expect(door.pos.x).toBeGreaterThan(wx + 3);
    expect(door.blocked).toBe(0);
  });

  it('another creature in the way stops it (creature vs creature), unless the mover is ethereal', () => {
    const other = { x: X0 + 46, y: Y0 + 40 };
    const obstacles: MovementCreatureObstacles = (collider, x, z, range) => {
      const near = Math.hypot(other.x - x, other.y - z) <= range ? [{
        guid: 2, worldX: other.x, worldY: GROUND, worldZ: other.y, collisionRadius: 0.44, setupId: 0x020007dd,
        quat: { w: 1, x: 0, y: 0, z: 0 }, scale: 1, physicsState: PhysicsState.Gravity,
      }] : [];
      const keys = addCreatureObstacles(collider as DungeonCollision, near, () => ({
        parts: [], hasPhysicsBSP: false, cylSpheres: [], spheres: DRUDGE_SETUP.spheres, sortingSphere: { origin: { x: 0, y: 0, z: 0 }, radius: 1 },
      }));
      return () => { for (const k of keys) (collider as DungeonCollision).removeKey(k); };
    };
    const { pos } = walk(world(), start, { x: 1, y: 0 }, 3, { obstacles });
    expect(pos.x).toBeLessThan(other.x - 2 * DRUDGE.sphereRadius + 0.01);
    // An ethereal mover never has them registered (moverBlockedBy): it walks on.
    const ghost = walk(world(), start, { x: 1, y: 0 }, 3, { obstacles: null });
    expect(ghost.pos.x).toBeGreaterThan(other.x + 3);
  });
});

describe('a remote creature does not stick where retail\'s moves on', () => {
  const start = { x: X0 + 40, y: Y0 + 40, z: GROUND };

  it('stairs: 0.25 m risers (under its 0.62 m step up) are climbed onto the landing, its feet on each tread', () => {
    const sx = X0 + 45;
    const polys: PhysicsPolygon[] = [];
    for (let i = 0; i < 4; i++) {
      const x = sx + 0.4 * i;
      polys.push(wallX(x, Y0 + 38, Y0 + 42, GROUND + 0.25 * i, GROUND + 0.25 * (i + 1)));
      polys.push(floor(x, i === 3 ? sx + 12 : x + 0.4, Y0 + 38, Y0 + 42, GROUND + 0.25 * (i + 1)));
    }
    const dc = addPolys(new DungeonCollision(), 'bl:stairs', polys);
    const { pos, path } = walk(world(dc), start, { x: 1, y: 0 }, 3);
    expect(pos.x).toBeGreaterThan(sx + 5);
    expect(pos.z).toBeCloseTo(GROUND + 1, 2);
    // Never below a tread it stands over (no sinking into the stairs).
    for (const p of path) {
      const i = Math.floor((p.x - sx) / 0.4);
      if (i >= 0 && i < 4) expect(p.z).toBeGreaterThanOrEqual(GROUND + 0.25 * i - 1e-6);
    }
  });

  it('a 1.2 m ledge (over its step up) is a wall', () => {
    const lx = X0 + 45;
    const dc = addPolys(new DungeonCollision(), 'bl:ledge', [
      wallX(lx, Y0 + 30, Y0 + 50, GROUND, GROUND + 1.2),
      floor(lx, lx + 10, Y0 + 30, Y0 + 50, GROUND + 1.2),
    ]);
    const { pos } = walk(world(dc), start, { x: 1, y: 0 }, 3);
    expect(pos.x).toBeLessThan(lx);
    expect(pos.z).toBeCloseTo(GROUND, 6);
  });

  it('a slope under the walkable limit is climbed; a face over it is not (FloorZ, as the player\'s GAP.5)', () => {
    const gentle = walk(world(new DungeonCollision(), { rise: 0.5 }), { x: X0 + 100, y: Y0 + 30, z: GROUND + 30 * 0.5 }, { x: 0, y: 1 }, 3);
    expect(gentle.pos.y).toBeGreaterThan(Y0 + 40);
    expect(gentle.pos.z).toBeCloseTo(GROUND + (gentle.pos.y - Y0) * 0.5, 2);
    const steep = walk(world(new DungeonCollision(), { rise: 2 }), { x: X0 + 100, y: Y0 + 30, z: GROUND + 60 }, { x: 0, y: 1 }, 3);
    expect(steep.pos.y).toBeLessThan(Y0 + 30.5);
  });

  it('a dungeon: its walls stop it and its ramp is climbed (pre-fix the height stood still indoors)', () => {
    const DCELL = 0x01d90105;
    const dun = new DungeonCollision();
    // A floor, a 30° ramp up to a landing 2 m higher, and a wall across the far end.
    const rise = Math.tan(Math.PI / 6);
    addPolys(dun, DCELL, [
      floor(X0 + 30, X0 + 50, Y0 + 35, Y0 + 45, 0),
      quad([X0 + 50, Y0 + 35, 0], [X0 + 50 + 2 / rise, Y0 + 35, 2], [X0 + 50 + 2 / rise, Y0 + 45, 2], [X0 + 50, Y0 + 45, 0]),
      floor(X0 + 50 + 2 / rise, X0 + 60, Y0 + 35, Y0 + 45, 2),
      wallX(X0 + 58, Y0 + 35, Y0 + 45, 0, 5),
    ]);
    const w = world(new DungeonCollision(), { dungeon: dun });
    expect(remoteCollider(w, DCELL)?.inDungeon).toBe(true);
    const { pos } = walk(w, { x: X0 + 40, y: Y0 + 40, z: 0 }, { x: 1, y: 0 }, 6, { cell: DCELL });
    expect(pos.z).toBeCloseTo(2, 2);
    expect(pos.x).toBeLessThan(X0 + 58);
    expect(pos.x).toBeGreaterThan(X0 + 57);
  });

  it('a body in a cell no world we hold has is not collided (its motion stands, as before)', () => {
    expect(remoteCollider(world(), 0x01d90105)).toBeNull();
    expect(remoteTransition(world(), {
      shape: DRUDGE, cell: 0x01d90105, from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0 }, airborne: false, edgeSlide: false,
      slide: { slidingNormal: null }, obstacles: null, wantGround: true,
    })).toBeNull();
  });
});

// ── RemotePhysicsObject: the chase, the corrections, the interpolation ─────

const LB_CELL = CELL;

/** A creature chasing east on its own MoveTo at 4 m/s, its transition through `w` (null = none, pre-fix). */
function chaser(w: RemoteTransitionWorld | null, at = { x: X0 + 40, y: Y0 + 40, z: GROUND }) {
  // Heading east: AC orientation rotating local +y onto +x (−90° about z).
  const q = { w: Math.SQRT1_2, x: 0, y: 0, z: -Math.SQRT1_2 };
  const body = new RemotePhysicsObject({ position: { cell: LB_CELL, pos: { ...at }, orient: q }, state: PhysicsState.Gravity });
  body.motion = { ...body.motion, adjustedMaxSpeed: () => 4, maxSpeed: () => 4, isMovingTo: () => true, radius: () => DRUDGE.radius };
  const calls = { n: 0 };
  if (w) {
    const slide = { slidingNormal: null };
    body.transition = (to, opts) => {
      calls.n++;
      return remoteTransition(w, {
        shape: DRUDGE, cell: body.cell, from: body.pos, to, airborne: opts.airborne, edgeSlide: false, slide, obstacles: null, wantGround: opts.wantGround,
      });
    };
  }
  return { body, calls };
}
const run = (dt: number): SequenceFrame => {
  const f = identityFrame();
  f.origin = { x: 0, y: 4 * dt, z: 0 };
  return f;
};
const flatEnv: RemotePhysicsEnv = { terrainHeight: () => GROUND };

/** Frames at 60 fps; `server` = the server's held position, sent every 0.2 s (AC1999 mid-moveto). Returns each correction's gap to ours. */
function chase(body: RemotePhysicsObject, secs: number, server?: { x: number; y: number; z: number }): number[] {
  const dt = 1 / 60;
  let t = 0, next = 0.2, stamp = 1;
  const gaps: number[] = [];
  for (let i = 0; i < secs * 60; i++) {
    t += dt;
    if (server && t >= next) {
      next += 0.2;
      gaps.push(Math.hypot(server.x - body.pos.x, server.y - body.pos.y));
      body.receivePosition({ cell: LB_CELL, pos: { ...server }, orient: body.orient, contact: true, positionTs: ++stamp }, 10);
    }
    body.update(dt, run(dt), flatEnv, t);
  }
  return gaps;
}

describe('the chase behind a rock: our copy no longer runs ahead of the server\'s held one', () => {
  const rock = { x: X0 + 50, y: Y0 + 40, r: 1.5 };
  const rockWorld = () => {
    const dc = new DungeonCollision();
    dc.addCylinderObstacle('sc:rock', rock.x, rock.y, rock.r, GROUND, GROUND + 2);
    return world(dc);
  };
  // Where the server's copy stands: pressed against the rock (its own transition).
  const held = { x: rock.x - rock.r - DRUDGE.sphereRadius, y: rock.y, z: GROUND };

  it('pre-fix: every correction found ours run on past the rock (the "jumping back and forth")', () => {
    const { body } = chaser(null, { ...held });
    const gaps = chase(body, 4, held);
    // 0.2 s at 4 m/s between corrections, half of it pulled back by the interpolation each time.
    expect(Math.min(...gaps.slice(5))).toBeGreaterThan(0.4);
  });

  it('now: ours is stopped by the same rock, and every correction lands within a few cm', () => {
    const { body } = chaser(rockWorld(), { ...held });
    const gaps = chase(body, 4, held);
    expect(Math.max(...gaps)).toBeLessThan(0.1);
    expect(body.pos.x).toBeLessThan(rock.x - rock.r);
  });

  it('an interpolated step is not collided again: a correction past the rock is reached (the server\'s transition got there)', () => {
    const { body, calls } = chaser(rockWorld(), { ...held });
    const beyond = { x: rock.x + rock.r + 1, y: rock.y, z: GROUND };
    body.receivePosition({ cell: LB_CELL, pos: beyond, orient: body.orient, contact: true, positionTs: 50 }, 10);
    const before = calls.n;
    let t = 0;
    for (let i = 0; i < 120 && body.interp.isInterpolating(); i++) { t += 1 / 60; body.update(1 / 60, identityFrame(), flatEnv, t); }
    expect(Math.hypot(body.pos.x - beyond.x, body.pos.y - beyond.y)).toBeLessThan(0.1);
    expect(calls.n).toBe(before);
  });

  it('a snap or a teleport places it wherever the server says (SetPositionSimple has no transition)', () => {
    const { body } = chaser(rockWorld(), { ...held });
    body.receivePosition({ cell: LB_CELL, pos: { x: rock.x, y: rock.y, z: GROUND }, orient: body.orient, contact: true, positionTs: 60 }, 500);
    expect(body.pos).toMatchObject({ x: rock.x, y: rock.y });
  });

  it('a standing creature is never transitioned (UpdateObjectInternal only set_frames an unmoved one)', () => {
    const { body, calls } = chaser(rockWorld());
    for (let i = 0; i < 30; i++) body.update(1 / 60, identityFrame(), flatEnv, i / 60);
    expect(calls.n).toBe(0);
  });
});

// ── ServerObjectManager: the wiring, the range budget, our character ────────

const LB = 0xa9b40017;
const OX = 0xa9 * 192, OY = 0xb4 * 192;

function somRig(opts: { playerAt?: { x: number; z: number } } = {}) {
  const t = new TerrainCollision();
  t.setLandblock(0xa9, 0xb4, { heights: new Array(81).fill(GROUND), blockX: 0xa9, blockY: 0xb4 });
  const w = new WaterMap();
  w.setLandblock(0xa9, 0xb4, new Array(256).fill(1));
  const outdoor = new DungeonCollision();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager({ loadSetupModel: () => ({ ...DRUDGE_SETUP, cylSpheres: [] }) } as any, {} as any, { add: () => {}, remove: () => {} } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (som as any).buildMesh = () => new THREE.Group();
  som.setPlayerGuid(0x50000001);
  som.setTerrainCollision(t as never);
  const me = opts.playerAt ?? { x: OX + 100, z: OY + 80 };
  som.localPlayerPosition = () => ({ x: me.x, z: me.z, y: GROUND, radius: 0.68, height: 1.8 });
  som.objectPhysics = () => ({
    parts: [], hasPhysicsBSP: false, cylSpheres: [], spheres: DRUDGE_SETUP.spheres, sortingSphere: { origin: { x: 0, y: 0, z: 0 }, radius: 1 },
  });
  som.remoteTransitionWorld = { outdoor, dungeon: null, terrain: t, water: w, waterDepthAt: () => 0 };
  return { som, outdoor };
}

function spawn(som: ServerObjectManager, guid: number, x: number, y: number, state = PhysicsState.Gravity, east = true) {
  som.createObject({
    guid, name: 'Drudge Slinker', weenieClassId: 193, itemType: 0x10, setupId: 0x020007dd, motionTableId: 0,
    position: { landblock: LB, x, y, z: GROUND, rw: east ? Math.SQRT1_2 : 1, rx: 0, ry: 0, rz: east ? -Math.SQRT1_2 : 0 },
    physicsState: state, timestamps: [1, 1, 1, 1, 1, 1, 1, 1, 1],
    subPalettes: [], textureChanges: [], animPartChanges: [], objScale: 1, useRadius: 0.6,
  } as unknown as CreateObjectData);
  // A sequence that runs it forward at 4 m/s (its root motion).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mm = { activeMotionTable: null, currentStyleId: 0, getPartTransforms: () => null } as any;
  som.registerAnimatedEntity(guid, {
    motionManager: mm,
    update: (dt: number, motion?: { frame: SequenceFrame }) => { if (motion) motion.frame.origin = { x: 0, y: 4 * dt, z: 0 }; },
  } as never);
  return som.getObject(guid)!;
}
const tick = (som: ServerObjectManager, secs: number) => { for (let i = 0; i < secs * 60; i++) som.updateAnimations(1 / 60); };

describe('ServerObjectManager runs each remote object\'s transition', () => {
  it('a creature running at a tree stops at it', () => {
    const { som, outdoor } = somRig();
    outdoor.addCylinderObstacle('sc:tree', OX + 60, OY + 50, 0.8, GROUND, GROUND + 5);
    const obj = spawn(som, 0x80000a1c, 50, 50);
    tick(som, 4);
    expect(obj.physics!.pos.x).toBeLessThan(OX + 60 - 0.8);
    expect(som.transitionStats.blocked).toBeGreaterThan(0);
  });

  it('the player\'s collider keeps its own results across the remote transitions', () => {
    const { som, outdoor } = somRig();
    outdoor.addCylinderObstacle('sc:tree', OX + 60, OY + 50, 0.8, GROUND, GROUND + 5);
    outdoor.lastStepUp = 0.2;
    outdoor.collisionNormal = { x: 0, z: -1 };
    const layout = outdoor.bodySphereLayout;
    spawn(som, 0x80000a1c, 50, 50);
    tick(som, 2);
    expect(outdoor.lastStepUp).toBe(0.2);
    expect(outdoor.collisionNormal).toEqual({ x: 0, z: -1 });
    expect(outdoor.bodySphereLayout).toEqual(layout);
  });

  it('another creature stops it; our character stops it', () => {
    const { som } = somRig({ playerAt: { x: OX + 58, z: OY + 50 } });
    const a = spawn(som, 0x80000a1c, 50, 50);
    // A standing creature 4 m ahead on the second lane (it never moves: no sequence).
    som.createObject({
      guid: 0x80000a1d, name: 'Drudge Slinker', weenieClassId: 193, itemType: 0x10, setupId: 0x020007dd, motionTableId: 0,
      position: { landblock: LB, x: 54, y: 60, z: GROUND, rw: 1, rx: 0, ry: 0, rz: 0 },
      physicsState: PhysicsState.Gravity, timestamps: [1, 1, 1, 1, 1, 1, 1, 1, 1],
      subPalettes: [], textureChanges: [], animPartChanges: [], objScale: 1, useRadius: 0.6,
    } as unknown as CreateObjectData);
    const b = spawn(som, 0x80000a1e, 50, 60);
    tick(som, 3);
    // Our character (spheres r 0.48) at x 58 on a's lane.
    expect(a.physics!.pos.x).toBeLessThan(OX + 58 - 0.48 - DRUDGE.sphereRadius + 0.01);
    expect(b.physics!.pos.x).toBeLessThan(OX + 54 - 2 * DRUDGE.sphereRadius + 0.01);
  });

  it('beyond MAX_PHYSICS_DISTANCE (96 m) of our character it is not transitioned (update_object\'s active range)', () => {
    expect(REMOTE_TRANSITION_RANGE).toBe(96);
    const { som, outdoor } = somRig({ playerAt: { x: OX + 50 + 150, z: OY + 50 } });
    outdoor.addCylinderObstacle('sc:tree', OX + 60, OY + 50, 0.8, GROUND, GROUND + 5);
    const obj = spawn(som, 0x80000a1c, 50, 50);
    tick(som, 4);
    expect(som.transitionStats.runs).toBe(0);
    expect(obj.physics!.pos.x).toBeGreaterThan(OX + 62);
  });

  it('frame cost through updateAnimations: 30 creatures running in a pack (their neighbours registered each move)', () => {
    const timed = (withWorld: boolean) => {
      const { som, outdoor } = somRig({ playerAt: { x: OX + 120, z: OY + 100 } });
      for (let i = 0; i < 200; i++) outdoor.addCylinderObstacle(`sc:t${i}`, OX + 20 + (i % 20) * 8, OY + 20 + Math.floor(i / 20) * 9, 0.6, GROUND, GROUND + 6);
      if (!withWorld) som.remoteTransitionWorld = null;
      for (let i = 0; i < 30; i++) spawn(som, 0x80001000 + i, 40 + (i % 6) * 3, 60 + Math.floor(i / 6) * 3);
      tick(som, 0.25); // warm
      const t0 = performance.now();
      tick(som, 2);
      return (performance.now() - t0) / 120;
    };
    const base = timed(false);
    const collided = timed(true);
    console.log(`[remote-transition cost, ServerObjectManager] 30 creatures in a pack: ${collided.toFixed(3)} ms/frame with transitions vs ${base.toFixed(3)} without (+${(collided - base).toFixed(3)} ms)`);
    expect(collided - base).toBeLessThan(8);
  });

  it('a Missile-state object is not transitioned here (MissilePhysics flies missiles)', () => {
    const { som } = somRig();
    spawn(som, 0x80000a1c, 50, 50, PhysicsState.Gravity | PhysicsState.Missile);
    tick(som, 1);
    expect(som.transitionStats.runs).toBe(0);
  });
});

// ── Frame cost: N creatures chasing through a dense world ──────────────────

describe('frame cost with many moving creatures', () => {
  it('measures the transitions of 10 / 30 / 60 creatures per frame among 400 trees and a walled yard', () => {
    const dc = new DungeonCollision();
    for (let i = 0; i < 400; i++) dc.addCylinderObstacle(`sc:t${i}`, X0 + 10 + (i % 20) * 8, Y0 + 10 + Math.floor(i / 20) * 8, 0.6, GROUND, GROUND + 6);
    const walls: PhysicsPolygon[] = [];
    for (let k = 0; k < 10; k++) walls.push(wallX(X0 + 20 + k * 15, Y0 + 5, Y0 + 185, GROUND - 1, GROUND + 4));
    addPolys(dc, 'bl:yard', walls);
    const w = world(dc);
    const results: string[] = [];
    for (const n of [10, 30, 60]) {
      const movers = Array.from({ length: n }, (_, i) => ({
        pos: { x: X0 + 12 + (i % 10) * 15, y: Y0 + 12 + Math.floor(i / 10) * 25, z: GROUND },
        dir: { x: Math.cos(i), y: Math.sin(i) },
        slide: { slidingNormal: null },
      }));
      const frames = 120;
      const t0 = performance.now();
      for (let f = 0; f < frames; f++) {
        for (const m of movers) {
          const r = remoteTransition(w, {
            shape: DRUDGE, cell: CELL, from: m.pos, to: { x: m.pos.x + m.dir.x * 4 / 60, y: m.pos.y + m.dir.y * 4 / 60 },
            airborne: false, edgeSlide: false, slide: m.slide, obstacles: null, wantGround: true,
          })!;
          m.pos = { x: r.x, y: r.y, z: r.groundZ ?? m.pos.z };
        }
      }
      const perFrame = (performance.now() - t0) / frames;
      results.push(`${n} creatures: ${perFrame.toFixed(3)} ms/frame (${(perFrame / n * 1000).toFixed(1)} µs each)`);
      // Generous bound (a slow CI runner): well under a 16.7 ms frame at 60 creatures.
      expect(perFrame / n).toBeLessThan(0.5);
    }
    console.log(`[remote-transition cost] ${results.join('; ')}`);
  });
});

// ── The real world: Holtburg's collision, three eras ─────────────────────

const ERAS: { name: string; dats?: { portal: string; cell: string; ac1999?: boolean } }[] = [
  { name: 'end of retail' },
  { name: 'Dark Majesty', dats: { portal: resolve(DAT_SETS_DIR, 'classic-dereth-1.1/client_portal.dat'), cell: resolve(DAT_SETS_DIR, 'classic-dereth-1.1/client_cell_1.dat') } },
  { name: 'AC1999', dats: { portal: resolve(DAT_SETS_DIR, 'ac1999-retail/portal.dat'), cell: resolve(DAT_SETS_DIR, 'ac1999-retail/cell.dat'), ac1999: true } },
];
const present = (e: (typeof ERAS)[number]) => (e.dats ? existsSync(e.dats.portal) && existsSync(e.dats.cell) : existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell));

for (const era of ERAS) {
  describe.skipIf(!present(era))(`Holtburg's real collision world (${era.name} DATs)`, () => {
    let w: RemoteTransitionWorld;
    const HX = 0xa9 * 192, HY = 0xb4 * 192;
    const HCELL = 0xa9b40001;

    beforeAll(async () => {
      const { buildLandblockWorld } = await import('./_harness/a9b4-world.js');
      const s = (await buildLandblockWorld(0xa9, 0xb4, { interiors: true, dats: era.dats }))({ slidingNormal: null });
      w = { outdoor: s.outdoorCollision as DungeonCollision, dungeon: null, terrain: s.terrain, water: s.water, waterDepthAt: () => 0 };
    }, 180_000);

    /** Run a drudge from (x, y) toward (tx, ty) for `secs`; returns the end and the free-run distance. */
    function runAt(x: number, y: number, tx: number, ty: number, secs: number) {
      const z = w.terrain.getHeightAt(HX + x, HY + y)!;
      const r = walk(w, { x: HX + x, y: HY + y, z }, { x: tx - x, y: ty - y }, secs, { cell: HCELL });
      return { ...r, free: 4 * secs };
    }

    it('a drudge running into a building is stopped by its wall (the house at local (79.5, 37.5))', () => {
      // North from the lifestone lane at x 79.5 runs into the house 0x01000BC3 (tools/retail-movement-ab.ts).
      const r = runAt(79.5, 25, 79.5, 60, 6);
      expect(r.blocked).toBeGreaterThan(0);
      expect(r.pos.y - (HY + 25)).toBeLessThan(r.free - 3);
    });

    it('a drudge crossing open ground from the lifestone east goes the whole way', () => {
      const r = runAt(85, 20.5, 125, 20.5, 3);
      expect(Math.hypot(r.pos.x - (HX + 85), r.pos.y - (HY + 20.5))).toBeGreaterThan(r.free - 1.5);
    });

    // The blacksmith's staircase (EnvCell 0xA9B40104, verify-bug-blacksmith-stair-stringer-embed.ts): the
    // player's centre-line climb, now by a drudge on its own motion. End-of-retail interiors only.
    it.skipIf(!!era.dats)('a drudge climbs the Holtburg blacksmith\'s stairs to the landing (no freeze on the risers)', () => {
      const r = walk(w, { x: HX + 82.6, y: HY + 128.84, z: 66 }, { x: -1, y: 0 }, 2, { cell: 0xa9b40104 });
      expect(r.pos.z).toBeGreaterThanOrEqual(69.49);
    });

    it('frame cost: 40 drudges roaming Holtburg', () => {
      const n = 40;
      const movers = Array.from({ length: n }, (_, i) => {
        const x = HX + 40 + (i % 8) * 15, y = HY + 20 + Math.floor(i / 8) * 25;
        return { pos: { x, y, z: w.terrain.getHeightAt(x, y)! }, dir: { x: Math.cos(i * 1.7), y: Math.sin(i * 1.7) }, slide: { slidingNormal: null } };
      });
      const frames = 120;
      const t0 = performance.now();
      for (let f = 0; f < frames; f++) {
        for (const m of movers) {
          const r = remoteTransition(w, {
            shape: DRUDGE, cell: HCELL, from: m.pos, to: { x: m.pos.x + m.dir.x * 4 / 60, y: m.pos.y + m.dir.y * 4 / 60 },
            airborne: false, edgeSlide: false, slide: m.slide, obstacles: null, wantGround: true,
          })!;
          m.pos = { x: r.x, y: r.y, z: r.groundZ ?? m.pos.z };
        }
      }
      const perFrame = (performance.now() - t0) / frames;
      console.log(`[remote-transition cost, Holtburg ${era.name}] ${n} drudges: ${perFrame.toFixed(3)} ms/frame (${(perFrame / n * 1000).toFixed(1)} µs each)`);
      expect(perFrame / n).toBeLessThan(1);
    });
  });
}
