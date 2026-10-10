/**
 * The Holtburg bowyer's front doorway (landblock 0xA9B4, EnvCell 0xA9B40121
 * → vestibule 0xA9B40125 → outside; door #0x7A9B400C at local (104.16,
 * 141.17), held open = Ethereal). Live 2026-10-09: a body at local
 * (103.8, 140.3) facing exactly north moved 0.0 m.
 *
 * Retail-faithful, not a bug: the doorway (Environment 0x0D0002FB, struct 2
 * physics polys 6/7 and struct 6 polys 0/2) is 1.50 m wide (x 103.40–104.90)
 * and the body spheres are 0.48 m, so a north walk clears it only with its
 * centre in x ≈ (103.88, 104.42). At 103.8 the feet sphere's next step
 * touches the west jamb's vertical edge (0.47 m < 0.48 − F_EPSILON):
 * CPolygon::pos_hits_sphere @ 005394f0 counts an edge hit
 * (polygon_hits_sphere_slow_but_sure @ 00538a10), BSPTREE::find_collisions
 * @ 0053a440 runs step_sphere_up with the plane normal, CTransition::step_up
 * @ 0050b610's Placement insert still overlaps the edge, and
 * SPHEREPATH::step_up_slide @ 0050c3b0 → CSphere::slide_sphere slides along
 * cross(N, up) — zero for a head-on move — so the transition collides. A
 * degree of lean toward the opening slides the body along the jamb and out.
 *
 * Behavioral: the shipped DungeonCollision + stepPlayerMovement + outdoor
 * floor follow in the real A9B4 collision world with its interiors.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { outdoorGroundY, traceGroundAlongPath, floorSearchFromY } from '../packages/renderer/src/world/outdoorGround.js';
import { stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.js';
import { DAT_PATHS } from './_harness/dat.js';

const haveDat = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);
const ROOM = 0xa9b40121;
const VESTIBULE = 0xa9b40125;
const DOOR = 0x7a9b400c;

describe.skipIf(!haveDat)('the Holtburg bowyer\'s doorway (A9B4 0x121 → 0x125 → outside)', () => {
  let services: MovementServices;
  let dc: DungeonCollision;
  let OX = 0;
  let OY = 0;

  beforeAll(async () => {
    const { buildA9b4World, A9B4 } = await import('./_harness/a9b4-world.js');
    OX = A9B4.OX;
    OY = A9B4.OY;
    // The door is held open (Ethereal), as the server sent it live (0x1000C).
    services = (await buildA9b4World({ interiors: true }))({ slidingNormal: null }, (g) => (g === DOOR ? 0x1000c : undefined));
    dc = services.outdoorCollision as DungeonCollision;
  }, 120_000);

  function groundAt(x: number, z: number, fromY: number): number | null {
    return outdoorGroundY({
      terrainHeight: (a, b) => services.terrain.getHeightAt(a, b),
      floorHeight: (a, b, y) => dc.getBodyFloorHeight(a, b, y, services.stepDownHeight),
    }, x, z, fromY);
  }

  /** `n` keyed 1/30 s substeps along AC heading `deg` (0 = north, 90 = east) from local (x0, y0). */
  function walk(x0: number, y0: number, deg: number, n: number) {
    let x = OX + x0;
    let z = OY + y0;
    let floorY = 66;
    let minFloor = floorY;
    services.slide!.slidingNormal = null;
    const a = (deg * Math.PI) / 180;
    for (let i = 0; i < n; i++) {
      const r = stepPlayerMovement({ x, z, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 },
        Math.sin(a) * 0.1, Math.cos(a) * 0.1, 1 / 30, services);
      const g = traceGroundAlongPath(groundAt, x, z, r.x, r.z, floorSearchFromY(null, floorY, dc.lastStepUp), dc.transitionSphereRadius);
      x = r.x;
      z = r.z;
      if (g !== null) floorY = g;
      minFloor = Math.min(minFloor, floorY);
    }
    return { x: x - OX, y: z - OY, floorY, minFloor, cell: dc.findCellContaining(x, z, floorY + DungeonCollision.LOWER_SPHERE_HEIGHT) };
  }

  it('the live spot is in the room, 0.9 m inside the door', () => {
    expect(dc.findCellContaining(OX + 103.8, OY + 140.3, 66.5)).toBe(ROOM);
    expect(dc.findCellContaining(OX + 104.15, OY + 140.9, 66.5)).toBe(VESTIBULE);
    expect(dc.findCellContaining(OX + 104.15, OY + 141.5, 66.5)).toBe(0);
  });

  it('head-on at x 103.8 the feet sphere meets the west jamb\'s edge: no move, collision normal = the wall\'s (south)', () => {
    const pos = new THREE.Vector3(OX + 103.8, 66, OY + 140.3);
    // 0.05 m does not reach the edge yet (centre 0.50 m from it)…
    expect(dc.getAdjustedMovement(pos, 0, 0.05)).toEqual([0, 0.05]);
    // …0.1 m does (0.47 m < 0.48 − F_EPSILON): step up fails, the slide is zero.
    dc.collisionNormal = null;
    expect(dc.getAdjustedMovement(pos, 0, 0.1)).toEqual([0, 0]);
    expect(dc.collisionNormal!.x).toBeCloseTo(0, 6);
    expect(dc.collisionNormal!.z).toBeCloseTo(-1, 6);
  });

  it('a straight north walk leaves only with its centre in the doorway\'s 0.54 m window', () => {
    for (const x0 of [103.9, 104.0, 104.15, 104.3, 104.4]) {
      const s = walk(x0, 140.3, 0, 60);
      expect(s.cell, `x ${x0}`).toBe(0);
      expect(s.y, `x ${x0}`).toBeGreaterThan(146);
      // Level threshold: the floor stays 66 out onto the grass (no step down, no edge refusal).
      expect(s.minFloor, `x ${x0}`).toBeCloseTo(66, 3);
    }
    for (const x0 of [103.8, 104.5]) {
      const s = walk(x0, 140.3, 0, 60);
      expect(s.cell, `x ${x0}`).toBe(ROOM);
      expect(s.y, `x ${x0}`).toBeLessThan(140.45);
    }
  });

  it('from x 103.8, a lean toward the opening slides along the jamb and out; a lean into the wall stays', () => {
    for (const deg of [1, 2, 5, 10]) {
      const s = walk(103.8, 140.3, deg, 90);
      expect(s.cell, `heading ${deg}`).toBe(0);
      expect(s.y, `heading ${deg}`).toBeGreaterThan(145);
    }
    for (const deg of [-2, -10]) {
      const s = walk(103.8, 140.3, deg, 90);
      expect(s.cell, `heading ${deg}`).toBe(ROOM);
    }
  });
});
