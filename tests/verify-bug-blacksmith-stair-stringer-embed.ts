/**
 * RECON.transition-stepup-stepdown-port.d / .e — the Holtburg blacksmith's
 * stairs (landblock 0xA9B4, building 0x01000C1E, EnvCell 0xA9B40104's
 * staircase static #0, Setup 0x02000278).
 *
 * .d: the last riser's step up was refused by the building's own outer
 * shell. Retail's Placement insert ignores a building shell's solid leaves
 * when the body is in an interior cell (BSPTREE::find_collisions @ 0053a440:
 * clearCell = !hits_interior_cell under bldg_check; ACE BSPTree.cs:143-150).
 *
 * .e: walking west along the staircase's 0.25 m stringer slab (local x
 * −0.95…−0.70, a walkable sloped top) embedded the body in it at the floor.
 * Retail's CPolygon::pos_hits_sphere @ 005394f0 has no walkable filter, so
 * the feet sphere hits the sloped top and steps up onto it, and the body's
 * ground is the contact plane its feet sphere's step down lands on
 * (CTransition::step_down @ 0050b3d0, find_walkable), not a vertical probe
 * under its centre. A step down that lands the body where it does not fit
 * (StepDown's Placement insert) has no contact plane and the step is refused.
 *
 * Behavioral: drives the shipped DungeonCollision, stepPlayerMovement and
 * the outdoor floor follow (traceGroundAlongPath + outdoorGroundY over
 * getBodyFloorHeight, as main.ts runs them) in mock worlds and in the real
 * a9b4 collision world with its interiors.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import {
  makePlane, collectWalkableSphereHits, sphereRestLift, polygonHitsSpherePrecise, FLOOR_WALKABLE_Z,
  type CollisionBSPNode, type PhysicsPolygon,
} from '@ac/shared';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { outdoorGroundY, traceGroundAlongPath, floorSearchFromY } from '../packages/renderer/src/world/outdoorGround.js';
import { stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.js';
import { DAT_PATHS } from './_harness/dat.js';

type V = [number, number, number];

function quad(v0: V, v1: V, v2: V, v3: V): PhysicsPolygon {
  const vertices = [v0, v1, v2, v3].map(([x, y, z]) => ({ x, y, z }));
  return { vertices, plane: makePlane(vertices), numPts: 4 };
}

function leaf(polys: PhysicsPolygon[]): CollisionBSPNode {
  return { type: 'LEAF', solid: false, boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: 100 }, polygons: polys };
}

/** A GfxObj-shaped physics source holding `polys` in one leaf (addGfxObjCollision input). */
function gfx(polys: PhysicsPolygon[]) {
  const physicsPolygons = new Map<number, unknown>();
  const vertices = new Map<number, unknown>();
  let vi = 0;
  polys.forEach((p, pi) => {
    const ids: number[] = [];
    for (const v of p.vertices) { vertices.set(vi, { origin: v, normal: { x: 0, y: 0, z: 1 }, uvs: [] }); ids.push(vi++); }
    physicsPolygons.set(pi, { vertexIndices: ids, numVertices: ids.length, stippling: 0, sidesType: 0, portalIndex: -1, polyId: pi });
  });
  return {
    physicsBSP: { rootNode: { type: 'LEAF', solid: 0, sphere: { origin: { x: 0, y: 0, z: 0 }, radius: 100 }, inPolys: [...physicsPolygons.keys()] } },
    physicsPolygons,
    vertexArray: { vertices },
  } as never;
}

function collider(polys: PhysicsPolygon[]): DungeonCollision {
  const dc = new DungeonCollision();
  dc.addGfxObjCollision(1, gfx(polys), { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);
  return dc;
}

const UP = { x: 0, y: 0, z: 1 };
const R = DungeonCollision.BODY_SPHERE_RADIUS;
const LOW = DungeonCollision.LOWER_SPHERE_HEIGHT;

/** A floor (normal +Z) over [x0, x1] × [y0, y1] at height z. */
const floor = (x0: number, x1: number, y0: number, y1: number, z: number) => quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]);
/** A ceiling (normal −Z) over [x0, x1] × [y0, y1] at height z. */
const ceiling = (x0: number, x1: number, y0: number, y1: number, z: number) => quad([x0, y1, z], [x1, y1, z], [x1, y0, z], [x0, y0, z]);
/**
 * A 45° walkable slab top (normal (−√½, 0, √½)) rising toward +x from z 0
 * at x0 to z (x1 − x0) at x1, over y ∈ [y0, y1] — a stair stringer.
 */
const rampTop = (x0: number, x1: number, y0: number, y1: number) =>
  quad([x0, y1, 0], [x0, y0, 0], [x1, y0, x1 - x0], [x1, y1, x1 - x0]);

describe('collectWalkableSphereHits — the walkables a step-down sphere lands on', () => {
  it('lists the walkable faces the sphere overlaps, never a wall or a face it misses', () => {
    const fl = floor(-2, 2, -2, 2, 0);
    const wall = quad([1, 2, 0], [1, -2, 0], [1, -2, 3], [1, 2, 3]);
    const far = floor(5, 6, -2, 2, 0);
    const hits = collectWalkableSphereHits(leaf([fl, wall, far]), { center: { x: 0.8, y: 0, z: 0.3 }, radius: R }, UP, FLOOR_WALKABLE_Z);
    expect(hits).toEqual([fl]);
    expect(collectWalkableSphereHits(leaf([fl]), { center: { x: 0, y: 0, z: 2 }, radius: R }, UP, FLOOR_WALKABLE_Z)).toEqual([]);
  });
});

describe('a walkable face is a hit for a feet sphere moving into it (pos_hits_sphere has no walkable filter)', () => {
  it('a body walking into a 45° stringer top steps up onto it', () => {
    const dc = collider([floor(-3, 3, -2, 2, 0), rampTop(1, 3, -0.2, 0.2)]);
    // The feet sphere reaches the slope within r of its plane past x ≈ 0.8: the step lifts it.
    const [dx] = dc.getAdjustedMovement(new THREE.Vector3(0.75, 0, 0), 0.1, 0);
    expect(dx).toBeCloseTo(0.1, 9);
    expect(dc.lastStepUp).toBeGreaterThan(0);
  });

  it('walking along a level floor is no hit (movement · N = 0) and needs no step', () => {
    const dc = collider([floor(-3, 3, -2, 2, 0)]);
    const [dx, dz] = dc.getAdjustedMovement(new THREE.Vector3(0, 0, 0), 0.1, 0.05);
    expect([dx, dz]).toEqual([0.1, 0.05]);
    expect(dc.lastStepUp).toBe(0);
  });
});

describe('a walkable the body stands under is never a landing (an attic roof seen from inside)', () => {
  // A floor at 0, a 0.2 m box ahead (riser at x 0.6), and a walkable-facing
  // slab at z 0.6 over the whole area: the feet sphere (centre 0.475)
  // overlaps it from below.
  const roofed = () => collider([
    floor(-3, 0.6, -2, 2, 0),
    quad([0.6, 2, 0], [0.6, -2, 0], [0.6, -2, 0.2], [0.6, 2, 0.2]),
    floor(0.6, 3, -2, 2, 0.2),
    floor(-3, 3, -2, 2, 0.6),
  ]);

  it('a step up at the box never lifts the body up through the slab overhead', () => {
    const dc = roofed();
    // The box's top is the only landing; the body does not fit there under
    // the slab, so the step fails (find_walkable alone set the feet sphere
    // on the slab's top, 0.605 up, where the body fits).
    dc.getAdjustedMovement(new THREE.Vector3(0.2, 0, 0), 0.1, 0);
    expect(dc.lastStepUp).toBeLessThan(0.3);
  });

  it('the floor follow never stands the body on the slab overhead', () => {
    const dc = roofed();
    expect(dc.getBodyFloorHeight(-1, 0, 0, 0.6)).toBeCloseTo(0, 9);
    expect(dc.stepDownContact(-1, 0, 0.1, 0.6)!.y).toBeCloseTo(0, 9);
  });
});

describe('getBodyFloorHeight — the contact plane under the feet sphere (CTransition::step_down)', () => {
  // The stringer top over y ∈ [−0.2, 0.2], over a level floor at z 0.
  const world = () => collider([floor(-3, 4, -2, 2, 0), rampTop(1, 3, -0.2, 0.2)]);
  /** Where a feet sphere lowerSphereHeight off a 45° plane stands, above the plane at its centre. */
  const restAbove45 = LOW * Math.SQRT2 - LOW;

  it('a level floor: the floor itself, as the centre search finds it', () => {
    const dc = world();
    expect(dc.getBodyFloorHeight(-2, 0, 0, 0.6)).toBeCloseTo(0, 9);
    expect(dc.getFloorHeight(-2, 0, 0)).toBeCloseTo(0, 9);
  });

  it('a centre 0.1 m past the stringer\'s side edge still stands on it, resting against that edge; the centre search drops to the floor', () => {
    const dc = world();
    // Plane height at x 2 is 1; the body stood on it (fromY = its rest there).
    const fromY = 1 + restAbove45;
    expect(dc.getFloorHeight(2, 0.3, fromY)).toBeCloseTo(0, 9);
    // The sphere touches the edge line (y 0.2, rising 45°) 0.1 m to its side:
    // its centre √(LOW² − 0.1²) from the line across the slope, √2 × that above it.
    const edgeRest = 1 + Math.SQRT2 * Math.sqrt(LOW * LOW - 0.01) - LOW;
    expect(dc.getBodyFloorHeight(2, 0.3, fromY, 0.6)).toBeCloseTo(edgeRest, 6);
    expect(dc.stepDownContact(2, 0.3, fromY, 0.6)!.normal.y).toBeCloseTo(Math.SQRT1_2, 6);
    // …and keeps standing there (its own step down finds the same rest).
    expect(dc.getBodyFloorHeight(2, 0.3, edgeRest, 0.6)).toBeCloseTo(edgeRest, 6);
  });

  it('over a ramp\'s top edge the sphere rests on the floor beyond, not on the ramp\'s plane carried past it', () => {
    // A 45° ramp from z 0 at x 0 to z 1 at x 1, then a floor at z 1.
    const dc = collider([rampTop(0, 1, -2, 2), floor(1, 4, -2, 2, 1)]);
    // 0.2 m past the edge the ramp's plane is at 1.2: retail's plane rest
    // would put the body at 1.2 + 0.197; it stands on the floor.
    expect(dc.getBodyFloorHeight(1.2, 0, 1 + restAbove45, 0.6)).toBeCloseTo(1, 6);
  });

  it('the step down does not lift the body onto a plane above its search height (the step up does that)', () => {
    const dc = world();
    // At x 1.3 (plane 0.3) standing on the floor beside it: no lift.
    expect(dc.getBodyFloorHeight(1.3, 0.3, 0, 0.6)).toBeCloseTo(0, 9);
  });

  it('the ramp normal is reported for a body standing at its rest height (getFloorNormal)', () => {
    const dc = world();
    const n = dc.getFloorNormal(2, 0, 1 + restAbove45)!;
    expect(n).not.toBeNull();
    expect(n.y).toBeCloseTo(Math.SQRT1_2, 6);
  });
});

describe('stepDownBlocked — a step down that lands the body where it does not fit (StepDown Placement)', () => {
  // A body beside the stringer (centre 0.1 m off its side edge) rests on that
  // edge at x − 1 + √2·√(LOW² − 0.1²) − LOW. Under a ceiling at z 2.64 the head
  // sphere fits while that rest is below ≈ 0.80 (x ≈ 1.62).
  const world = () => collider([floor(-3, 4, -2, 2, 0), rampTop(1, 3, -0.2, 0.2), ceiling(-3, 4, -2, 2, 2.64)]);
  const rest = (x: number) => (x - 1) + Math.SQRT2 * Math.sqrt(LOW * LOW - 0.01) - LOW;

  it('refuses a step whose landing raises the head into the ceiling, from a place the body fits', () => {
    const dc = world();
    expect(dc.stepDownContact(1.6, 0.3, rest(1.6), 0.6)!.fits).toBe(true);
    expect(dc.stepDownContact(1.64, 0.3, rest(1.6), 0.6)!.fits).toBe(false);
    expect(dc.stepDownBlocked(1.6, 0.3, 1.64, 0.3, rest(1.6), 0.6)).toBe(true);
  });

  it('lets a body walk where the landing fits, and away from the stringer', () => {
    const dc = world();
    expect(dc.stepDownBlocked(1.5, 0.3, 1.54, 0.3, rest(1.5), 0.6)).toBe(false);
    expect(dc.stepDownBlocked(1.6, 0.3, 1.56, 0.3, rest(1.6), 0.6)).toBe(false); // downhill
    expect(dc.stepDownBlocked(-2, 0, -1.9, 0, 0, 0.6)).toBe(false); // the level floor
  });

  it('a body that already does not fit is not held by it', () => {
    const dc = world();
    expect(dc.stepDownBlocked(1.7, 0.3, 1.74, 0.3, rest(1.7), 0.6)).toBe(false);
  });
});

describe('sphereRestLift — where a sphere coming down rests on a polygon', () => {
  const R0 = 0.5;
  const sq = floor(0, 1, 0, 1, 0);
  it('on the face: radius above the plane', () => {
    expect(sphereRestLift(sq, { x: 0.5, y: 0.5, z: 0 }, UP, R0)).toBeCloseTo(0.5, 9);
  });
  it('on an edge beside it: √(r² − d²) above the edge', () => {
    expect(sphereRestLift(sq, { x: 1.3, y: 0.5, z: 0 }, UP, R0)).toBeCloseTo(0.4, 9);
  });
  it('on a corner: √(r² − d²) above the vertex', () => {
    expect(sphereRestLift(sq, { x: 1.3, y: 1.3, z: 0 }, UP, R0)).toBeCloseTo(Math.sqrt(0.25 - 0.18), 9);
  });
  it('out of reach: null', () => {
    expect(sphereRestLift(sq, { x: 2, y: 0.5, z: 0 }, UP, R0)).toBeNull();
  });
});

// ── The Holtburg blacksmith (needs DAT files) ──────────────────────────

const haveDat = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);

describe.skipIf(!haveDat)('the Holtburg blacksmith stairs (A9B4, EnvCell 0xA9B40104)', () => {
  type World = Awaited<ReturnType<typeof import('./_harness/a9b4-world.js').buildA9b4World>>;
  let services: MovementServices;
  let dc: DungeonCollision;
  let OX = 0;
  let OY = 0;
  let stairPolys: { cell: { origin: { x: number; y: number; z: number }; quat: { w: number; x: number; y: number; z: number } }; polys: PhysicsPolygon[] };
  let shellAsStatic: DungeonCollision;

  beforeAll(async () => {
    const { buildA9b4World, A9B4 } = await import('./_harness/a9b4-world.js');
    OX = A9B4.OX;
    OY = A9B4.OY;
    const mk: World = await buildA9b4World({ interiors: true });
    services = mk();
    dc = services.outdoorCollision as DungeonCollision;
    // The staircase static's polygons in its frame (collisionKey.cellStatic).
    const { collisionKey } = await import('../packages/renderer/src/world/DungeonCollision.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (dc as any).cells.get(collisionKey.cellStatic(0xa9b40104, 0, 'p', 0));
    const polys: PhysicsPolygon[] = [];
    const stack: (CollisionBSPNode | undefined)[] = [entry.bsp];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      for (const p of n.polygons ?? []) if (!polys.includes(p)) polys.push(p);
      stack.push(n.posNode, n.negNode);
    }
    stairPolys = { cell: entry, polys };

    // The same world with the blacksmith's shell registered as a plain
    // static object (no bldg_check), for the .d contrast.
    shellAsStatic = (await buildA9b4World({ interiors: true }))().outdoorCollision as DungeonCollision;
    const { openDat } = await import('./_harness/dat.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { LandblockInfo } = await import('@ac/dat-parser');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { resolveObjectPhysics, addObjectCollision } = await import('../packages/renderer/src/world/ObjectCollision.js');
    const portalDb = openDat(DAT_PATHS.portal);
    const cellDb = openDat(DAT_PATHS.cell);
    const mr = new ModelRenderer(portalDb, new MaterialFactory(portalDb, new TextureManager(portalDb)));
    const sr = new SetupModelRenderer(portalDb, mr);
    const src = { loadSetupModel: (id: number) => sr.loadSetupModel(id), loadGfxObj: (id: number) => mr.loadGfxObj(id) };
    const info = new LandblockInfo(new DatReader(cellDb.getFileData(0xa9b4fffe)!));
    let k = 0;
    for (const b of info.buildings) {
      const phys = resolveObjectPhysics(b.modelId, src);
      if (!phys) continue;
      if (b.modelId === 0x01000c1e) {
        const key = k;
        // The harness's key for this building's parts, re-registered without the flag.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        addObjectCollision(shellAsStatic, (a, j) => `s${key}:${a}${j}` as any, phys, b.frame.origin, b.frame.orientation, 1, OX, OY);
      }
      k++;
    }
  }, 120_000);

  /** The player's floor follow, as main.ts runs it outdoors. */
  function groundAt(x: number, z: number, fromY: number): number | null {
    return outdoorGroundY({
      terrainHeight: (a, b) => services.terrain.getHeightAt(a, b),
      floorHeight: (a, b, y) => dc.getBodyFloorHeight(a, b, y, services.stepDownHeight),
    }, x, z, fromY);
  }

  type Body = { x: number; z: number; floorY: number };
  /** `n` keyed substeps of (dx, dz) from local (x, y) on the floor at `floor0`, each followed by the floor follow. */
  function walk(x0: number, y0: number, dx: number, dz: number, n: number, floor0 = 66, onStep?: (s: Body) => void): Body {
    let x = OX + x0;
    let z = OY + y0;
    let floorY = floor0;
    if (services.slide) services.slide.slidingNormal = null;
    for (let i = 0; i < n; i++) {
      const r = stepPlayerMovement({ x, z, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 }, dx, dz, 1 / 30, services);
      const g = traceGroundAlongPath(groundAt, x, z, r.x, r.z, floorSearchFromY(null, floorY, dc.lastStepUp), dc.transitionSphereRadius);
      x = r.x;
      z = r.z;
      if (g !== null) floorY = g;
      onStep?.({ x, z, floorY });
    }
    return { x, z, floorY };
  }

  /** Headings (of 16, 0 = east) whose 0.1 m move the collision world lets through (getAdjustedMovement). */
  function freeHeadings(s: { x: number; z: number; floorY: number }): number {
    let free = 0;
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI) / 8;
      const [dx, dz] = dc.getAdjustedMovement(new THREE.Vector3(s.x, s.floorY, s.z), Math.cos(a) * 0.1, Math.sin(a) * 0.1);
      if (Math.hypot(dx, dz) > 0.01) free++;
    }
    return free;
  }

  /** Whether a 0.1 m keyed substep along heading `a` (radians, 0 = east) moves the body. */
  function keyedMoves(s: { x: number; z: number; floorY: number }, a: number): boolean {
    if (services.slide) services.slide.slidingNormal = null;
    const r = stepPlayerMovement({ ...s, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 },
      Math.cos(a) * 0.1, Math.sin(a) * 0.1, 1 / 30, services);
    return Math.hypot(r.x - s.x, r.z - s.z) > 0.01;
  }

  /**
   * Staircase polygons a body sphere sinks into deeper than a standing body's
   * feet sphere sits in its floor (centre lowerSphereHeight off the plane:
   * so the test radius is that, not the 0.48 sphere radius).
   */
  function embeddedIn(s: { x: number; z: number; floorY: number }): number {
    const { cell, polys } = stairPolys;
    const q = cell.quat;
    let count = 0;
    for (const h of [DungeonCollision.LOWER_SPHERE_HEIGHT, DungeonCollision.UPPER_SPHERE_HEIGHT]) {
      const p = new THREE.Vector3(s.x - OX - cell.origin.x, s.z - OY - cell.origin.y, s.floorY + h - cell.origin.z)
        .applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w).invert());
      for (const poly of polys) {
        if (polygonHitsSpherePrecise(poly, { center: { x: p.x, y: p.y, z: p.z }, radius: LOW }).hit) count++;
      }
    }
    return count;
  }

  it('local (81, 129.9, 66.5) is inside the stair room 0xA9B40104', () => {
    expect(dc.findCellContaining(OX + 81, OY + 129.9, 66.5)).toBe(0xa9b40104);
  });

  it('.d: the last riser (cell 0x10C) steps up indoors; the shell as a plain static refuses it (its solid leaf)', () => {
    const pos = new THREE.Vector3(OX + 77.64, 68.97, OY + 128.92);
    const [dx] = dc.getAdjustedMovement(pos, -0.1, 0);
    expect(dx).toBeCloseTo(-0.1, 9);
    expect(dc.lastStepUp).toBeGreaterThan(0.3);
    shellAsStatic.getAdjustedMovement(pos, -0.1, 0);
    expect(shellAsStatic.lastStepUp).toBe(0);
  });

  it('a centre-line climb from (82.6, 128.84) reaches the landing at 69.5', () => {
    const s = walk(82.6, 128.84, -0.1, 0, 60);
    expect(s.floorY).toBeGreaterThanOrEqual(69.49);
    expect(freeHeadings(s)).toBe(16);
  });

  it('.e: walking west along the stringer never embeds the body; it stays free to move', () => {
    for (let y = 129.6; y <= 130.4 + 1e-9; y += 0.1) {
      const s = walk(82.6, y, -0.1, 0, 40);
      expect(embeddedIn(s), `y ${y.toFixed(1)}`).toBe(0);
      // Under the upper floor (its underside at z 69.0 from y 129.64 north)
      // the head stops the climb up the stringer: the uphill (west) headings
      // stay blocked there, the rest move (it was 1/16, embedded at z 66).
      expect(freeHeadings(s), `y ${y.toFixed(1)}`).toBeGreaterThanOrEqual(10);
      // The keyed path backs out: every heading with an eastward component.
      for (let i = -3; i <= 3; i++) expect(keyedMoves(s, (i * Math.PI) / 8), `y ${y.toFixed(1)} heading ${i * 22.5}`).toBe(true);
    }
  });

  it('.e: the body at y 129.9 stands on the stringer it stepped up onto, not on the floor under it', () => {
    const s = walk(82.6, 129.9, -0.1, 0, 40);
    expect(s.floorY).toBeGreaterThan(67);
    // Stopped by the upper floor's underside, not by the slab.
    expect(s.floorY + DungeonCollision.UPPER_SPHERE_HEIGHT + R).toBeLessThanOrEqual(69.0 + 0.01);
    expect(s.x - OX).toBeLessThan(80.5);
  });

  // The bowyer's attic (cell 0xA9B40123, floor z 69, origin local (104.5,
  // 135.5)) under a 45° roof whose outside reaches z 73.2. Live (2026-10-09,
  // build 4fcbd953) a body walking round it rose 69 → 70.60 → 72.81 and stood
  // on the roof's outside at 73.2: from the eave the floor follow took the
  // roof over its head for a floor, and the head walked into the eave because
  // a downward face was never a hit.
  const ATTIC = 0xa9b40123;
  const ATTIC_FLOOR = 69;
  const ceilingY = ATTIC_FLOOR + DungeonCollision.STEP_UP_HEIGHT + 1e-3;

  function checkAttic(s: Body, label: string): void {
    expect(s.floorY, label).toBeLessThanOrEqual(ceilingY);
    const cell = dc.findCellContaining(s.x, s.z, s.floorY + DungeonCollision.LOWER_SPHERE_HEIGHT);
    // Out of the attic only at or below its floor (its stair opening into
    // 0x121; the eave, where the cell is lower than the feet sphere's centre).
    if (cell !== ATTIC) expect(s.floorY, `${label}: left 0x123 in 0x${cell.toString(16)}`).toBeLessThanOrEqual(ATTIC_FLOOR + 1e-3);
    // Never outside the building: the column is the bowyer's (0x121 below, 0x123 above).
    expect(dc.findCellContaining(s.x, s.z, 66.5) !== 0 || dc.findCellContaining(s.x, s.z, ATTIC_FLOOR + 0.2) !== 0, `${label}: outside at local (${(s.x - OX).toFixed(2)}, ${(s.z - OY).toFixed(2)})`).toBe(true);
    // Never standing over the roof: no surface above the attic's reach lies under the feet.
    for (const p of dc.floorPlanesAt(s.x, s.z, 0.01)) {
      if (p.y > ceilingY) expect(p.y, `${label}: over a surface at ${p.y.toFixed(2)}`).toBeGreaterThan(s.floorY);
    }
  }

  it('the attic 0x123: walking toward every wall and roof slope never leaves it upward or stands on the roof', () => {
    expect(dc.findCellContaining(OX + 104.5, OY + 135.5, ATTIC_FLOOR + 0.5)).toBe(ATTIC);
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI) / 8;
      const label = `heading ${i * 22.5}`;
      walk(104.5, 135.5, Math.cos(a) * 0.1, Math.sin(a) * 0.1, 80, ATTIC_FLOOR, (s) => checkAttic(s, label));
    }
  });

  it('the live repro\'s eave spot (107.1, 131.0): the roof over the head is no floor, and no heading climbs out', () => {
    // The floor follow there found the roof's outside (70.45) for a floor.
    expect(dc.getBodyFloorHeight(OX + 107.1, OY + 130.9, ATTIC_FLOOR, 0.6)!).toBeLessThanOrEqual(ceilingY);
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI) / 8;
      const label = `eave heading ${i * 22.5}`;
      walk(107.1, 131.0, Math.cos(a) * 0.1, Math.sin(a) * 0.1, 80, ATTIC_FLOOR, (s) => checkAttic(s, label));
    }
  });

  it('the head sphere walking into the attic\'s sloped ceiling is stopped (a downward face is a hit)', () => {
    // South from the attic centre toward the eave at y ≈ 131.
    const s = walk(104.5, 135.5, 0, -0.1, 80, ATTIC_FLOOR);
    expect(s.z - OY).toBeGreaterThan(132);
    expect(s.floorY).toBeCloseTo(ATTIC_FLOOR, 3);
  });
});
