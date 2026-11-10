/**
 * BUG.edge-slide-check-walkable-overhang (+ BUG.ledge-seam-edge-slide-stall), 2026-11-09 — an EdgeSlide body's
 * centre stands up to r / 2 (0.24 m) past a ledge, as retail's does.
 *
 * Retail: CTransition::transitional_insert @ 0050b6f0 steps the DESTINATION down (CTransition::step_down
 * @ 0050b2a0, two halves of StepDownHeight); BSPTREE::step_sphere_down @ 0053a210 → SPHEREPATH::set_walkable
 * @ 00539fc0 record the polygon it lands on; CTransition::check_walkable @ 0050aff0 → SPHEREPATH::check_walkables
 * @ 0050c3e0 halves the sphere's radius and CPolygon::check_walkable @ 00538e60 keeps the step while the centre
 * projects within r / 2 of that polygon (or of a walkable half the step down lower: BSPLEAF::hits_walkable
 * @ 0053d670). Only then CTransition::edge_slide @ 0050b3d0 → SPHEREPATH::precipice_slide @ 0050cc80 slides along the
 * crossed edge of the DESTINATION's walkable (a walkable within StepDownHeight under the destination is still walked
 * off; see the 1 m case below). The 1999 client halves the radius the same way
 * (SPHEREPATH_check_walkables @ 0x0047cac0). The sphere rests on the polygon's plane there
 * (CPolygon::adjust_sphere_to_plane @ 00538210), not down against its edge.
 *
 * Retail ground truth (the lead, 2026-11-09, end-of-retail acclient.exe under Wine against local ACE):
 * `@teleloc 0x01D20294 [70 -65 0]` facing yaw θ (w = cos θ/2, z = sin θ/2), hold W (run) until stopped, `@myloc`:
 *   8° → 0x01D20293 (67.793365, -45.336567)   11° → (67.793419, -45.279163)   13.06° → 0x01D20291 (67.795074, -25.486681)
 *   13.5° → (67.794174, -45.346268)            16° → 0x01D20291 (67.794952, -25.483717)   20° → (67.793663, -45.429298)
 * The walkway's west ledge is x 68.033: the centre overhangs it by 0.238-0.240 m (r / 2 = 0.24). Most headings stop
 * at the walkway's triangulated seam (y ≈ -45.3), some slide on to its end (the wall at y -25, centre r = 0.48 off it).
 * Retail never stops at y -35.0 (our old client did on some headings) nor without the overhang (68.04-68.06, -45.01).
 */
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { makePlane, polygonCheckWalkable, type PhysicsPolygon } from '@ac/shared';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { DAT_PATHS } from './_harness/dat.ts';
import { dungeonNav, type DungeonNav } from './_harness/dungeonNav.ts';
import { precipiceStep } from '../packages/renderer/src/player/OutdoorMovement.js';
import { liveFramesOver } from './_harness/liveFrames.ts';

const UP = { x: 0, y: 0, z: 1 };
const IDENTITY = { w: 1, x: 0, y: 0, z: 0 };

/** A flat square of half-size h at local z, counter-clockwise from above (AC axes). */
function slab(h: number, z = 0): PhysicsPolygon {
  const vertices = [{ x: -h, y: -h, z }, { x: h, y: -h, z }, { x: h, y: h, z }, { x: -h, y: h, z }];
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

describe('CPolygon::check_walkable @ 00538e60 (polygonCheckWalkable)', () => {
  const p = slab(2);
  it('inside the polygon, at any height (projected along up)', () => {
    expect(polygonCheckWalkable(p, { x: 0.5, y: -1, z: 3 }, UP, 0.24)).toBe(true);
  });
  it('past an edge: within the radius of its segment yes, beyond it no', () => {
    expect(polygonCheckWalkable(p, { x: 2.23, y: 0, z: 0.48 }, UP, 0.24)).toBe(true);
    expect(polygonCheckWalkable(p, { x: 2.25, y: 0, z: 0.48 }, UP, 0.24)).toBe(false);
  });
  it('past a corner: within the radius of the vertex only', () => {
    expect(polygonCheckWalkable(p, { x: 2.15, y: 2.15, z: 0.48 }, UP, 0.24)).toBe(true); // 0.212 from (2, 2)
    expect(polygonCheckWalkable(p, { x: 2.2, y: 2.2, z: 0.48 }, UP, 0.24)).toBe(false); // 0.283
  });
});

describe('DungeonCollision.edgeSlideStep / stepDownContact on a slab over a drop', () => {
  // Renderer (x, y, z) = AC (x, z, y). A 6 m slab at height 20 centred on (10, 10); its +x edge is x 13.
  const world = (pitZ?: number) => {
    const dc = new DungeonCollision();
    dc.addGfxObjCollision('ledge', mockGfx(slab(3)), { x: 10, y: 10, z: 20 }, IDENTITY, 0, 0);
    if (pitZ !== undefined) dc.addGfxObjCollision('pit', mockGfx(slab(30)), { x: 10, y: 10, z: pitZ }, IDENTITY, 0, 0);
    return dc;
  };

  it('a destination whose centre is within r / 2 past the edge stands; farther, the crossed edge slides it', () => {
    const dc = world();
    const r = dc.transitionSphereRadius;
    expect(r).toBeCloseTo(0.48, 6);
    expect(dc.edgeSlideStep(12.9, 10, 20, 13 + r / 2 - 0.01, 10, 1.5)).toEqual({ ok: true });
    const past = dc.edgeSlideStep(13.2, 10, 20, 13 + r / 2 + 0.03, 10, 1.5);
    expect(past).toMatchObject({ ok: false });
    expect((past as { edge: { x: number } }).edge.x).toBeCloseTo(-1, 6);
  });

  it('a centre within r / 2 past a level edge stands on the plane (retail\'s adjust_sphere_to_plane), not sunk against the edge', () => {
    const dc = world();
    expect(dc.stepDownContact(13.2, 10, 20, 1.5)!.y).toBeCloseTo(20, 6);
    // Farther out the polygon rest (edge contact) applies, lower than the plane: the body is no longer standing there.
    expect(dc.stepDownContact(13.3, 10, 20, 1.5)!.y).toBeLessThan(20 - 0.05);
  });

  it('a 1 m drop (within StepDownHeight) is walked off at any step size', () => {
    // The decomp alone would hold a step that stays within the first half step down's reach of the edge (the lowered
    // sphere lands on the ledge and check_walkable fails; the second look, half StepDownHeight lower, stops short of
    // the floor 1 m down). Retail's 1/30 s physics quantum (MIN_QUANTUM) moves a running body 0.2-0.4 m a step, past
    // that reach, so a run walks off; our 60 Hz frames are half that and would hold it. DungeonCollision.edgeSlideStep
    // keeps the walk-off onto a walkable within StepDownHeight under the destination.
    const dc = world(19);
    expect(dc.edgeSlideStep(13.2, 10, 20, 13.3, 10, 1.5)).toEqual({ ok: true });
    expect(dc.edgeSlideStep(13.1, 10, 20, 13.55, 10, 1.5)).toEqual({ ok: true });
  });

  it('a drop of 10 m holds at any step size (nothing in reach)', () => {
    const dc = world(10);
    expect(dc.edgeSlideStep(13.1, 10, 20, 13.55, 10, 1.5)).toMatchObject({ ok: false });
  });
});

describe('precipiceStep: the cheap floor test first', () => {
  // Every grounded dungeon step asks precipiceStep; edgeSlideStep's BSP walk (walkableLanding over the cell array)
  // is only for a step out over a real drop. The agent's long walks (verify-agent-nav-planner's AC1999 tutorial run,
  // ~1.5 M step-downs) ran 5-15 % slower and over their timeouts when it was asked on every step (2026-11-09).
  it('a walkable within StepDownHeight under the destination returns at once, edgeSlideStep never asked', () => {
    let asked = 0;
    const c = { edgeSlideStep: () => { asked++; return { ok: true as const }; }, collisionNormal: null };
    expect(precipiceStep(c, 0, 0, 20, 0.3, 0, 1.5, () => 19)).toBeNull();
    expect(asked).toBe(0);
    // Over a drop deeper than StepDownHeight it is asked.
    expect(precipiceStep(c, 0, 0, 20, 0.3, 0, 1.5, (x) => (x === 0 ? 20 : 10))).toBeNull();
    expect(asked).toBe(1);
  });
});

const haveEor = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);
const MK = 0x01d20000;
const START = { x: 70, y: -65, z: 0 };
const LEDGE_X = 68.033;
/** The six retail runs (yaw → @myloc). */
const RETAIL: [number, number, number][] = [
  [8, 67.793365, -45.336567], [11, 67.793419, -45.279163], [13.06, 67.795074, -25.486681],
  [13.5, 67.794174, -45.346268], [16, 67.794952, -25.483717], [20, 67.793663, -45.429298],
];

describe.skipIf(!haveEor)('Mountain Keep 0x01D2 walkway (end of retail): the retail runs from 0x01D20294 (needs DAT files)', () => {
  let nav: DungeonNav;
  beforeAll(async () => { nav = await dungeonNav(MK, { statics: true }); }, 120_000);

  it('the retail endpoints themselves: 0.24 m (r / 2) past the west ledge, at the seam or at the walkway\'s end wall', () => {
    for (const [, x, y] of RETAIL) {
      expect(LEDGE_X - x).toBeGreaterThan(0.237);
      expect(LEDGE_X - x).toBeLessThan(0.241);
      expect(Math.abs(y + 45.35) < 0.1 || Math.abs(y + 25.485) < 0.005).toBe(true);
    }
  });

  it('ours, at those six headings and the capture\'s run speeds: the overhang, and a stop at the seam or the end', () => {
    const off: string[] = [];
    for (const speed of [4.5, 6.54]) {
      for (const [deg] of RETAIL) {
        const t = (deg * Math.PI) / 180;
        const r = liveFramesOver(nav, MK, START, { walk: { vx: -speed * Math.sin(t), vy: speed * Math.cos(t) }, seconds: 14 });
        // The overhang: retail's centre stops 0.238-0.240 past the ledge; ours stops at the last step that passed
        // check_walkable, so up to one 60 Hz frame's westward step (< 0.03 m here) short of r / 2.
        const xOk = r.x > LEDGE_X - 0.241 && r.x < LEDGE_X - 0.205;
        const seam = Math.abs(r.y + 45.3) <= 0.2;
        const end = Math.abs(r.y + 25.48) <= 0.05;
        if (!xOk || !(seam || end) || Math.abs(r.z) > 0.005 || r.fell) off.push(`${speed} ${deg}°: (${r.x.toFixed(4)}, ${r.y.toFixed(4)}, ${r.z.toFixed(3)})`);
      }
    }
    expect(off).toEqual([]);
  }, 300_000);

  it('never the old stops: none at the y -35 seam, none hugging the ledge with no overhang', () => {
    const base = Math.atan2(-50 - START.y, 66.52 - START.x);
    const bad: string[] = [];
    for (let k = -40; k <= 40; k += 8) {
      for (const speed of [3.12, 6.5]) {
        const h = base + k * 0.0005;
        const r = liveFramesOver(nav, MK, START, { walk: { vx: speed * Math.cos(h), vy: speed * Math.sin(h) }, seconds: 14 });
        if (Math.abs(r.y + 35) < 0.1 || (r.x > LEDGE_X - 0.01 && r.y > -46)) bad.push(`${speed} ${k}: (${r.x.toFixed(3)}, ${r.y.toFixed(3)})`);
      }
    }
    expect(bad).toEqual([]);
  }, 300_000);
});
