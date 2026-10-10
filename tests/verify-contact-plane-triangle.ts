/**
 * MOVE.retail-ab-god-rerecord — the contact plane that drives retail's
 * position-event rule (CommandInterpreter::ShouldSendPositionEvent
 * @ 006b45e0: inside the 1 s window, send iff the cell or the contact plane
 * changed) must be the plane of the terrain TRIANGLE under the player
 * (CLandCell::find_terrain_poly). getNormalAt's 0.5 m finite difference
 * blends two triangles within half a metre of an edge, so the plane changed
 * every frame there and every frame sent an AutonomousPosition: in the
 * retail A/B stop coast, ours sent 5 in 0.2 s where retail sent 1.
 *
 * Drives the real TerrainCollision + contactPlaneFromNormal + the real
 * shouldSendPositionEvent.
 */
import { describe, it, expect } from 'vitest';
import { TerrainCollision } from '../packages/shared/src/physics/TerrainCollision.js';
import {
  contactPlaneFromNormal, contactPlanesEqual, shouldSendPositionEvent,
} from '../packages/renderer/src/network/MovementSync.js';

const uneven = Array.from({ length: 81 }, (_, i) => ((i * 37) % 23) * 1.7);

function terrain(): TerrainCollision {
  const tc = new TerrainCollision();
  tc.setLandblock(0, 0, { heights: uneven, blockX: 0, blockY: 0 });
  return tc;
}

/** A walk along z inside one cell, 0.2 m per frame, ending 0.1 m before the cell's edge. */
function walk(tc: TerrainCollision, normalOf: (x: number, z: number) => { x: number; y: number; z: number } | null) {
  const x = 24 * 3 + 2; // near the cell's west edge, away from its diagonal for z ∈ [z0+3, z0+23]
  const out = [];
  for (let z = 24 * 3 + 21; z < 24 * 4 - 0.1; z += 0.2) {
    const y = tc.getHeightAt(x, z)!;
    out.push({ z, plane: contactPlaneFromNormal(normalOf(x, z)!, x, z, y) });
  }
  return out;
}

describe('the contact plane is the terrain triangle\'s plane', () => {
  it('stays equal frame to frame within one triangle (no position-event burst)', () => {
    const tc = terrain();
    const steps = walk(tc, (x, z) => tc.getTriangleNormalAt(x, z));
    for (let i = 1; i < steps.length; i++) expect(contactPlanesEqual(steps[i - 1].plane, steps[i].plane)).toBe(true);
    // And so the real rule sends nothing inside the 1 s window.
    const last = { cellId: 1, x: 0, y: 0, z: 0, qw: 1, qx: 0, qy: 0, qz: 0, contactPlane: steps[0].plane };
    for (const s of steps) {
      expect(shouldSendPositionEvent(last, 0, { cellId: 1, x: 0, y: s.z, z: 0, qw: 1, qx: 0, qy: 0, qz: 0 }, () => s.plane, 500)).toBe(false);
    }
  });

  it('the old finite-difference normal changes frame to frame near a triangle edge', () => {
    const tc = terrain();
    const steps = walk(tc, (x, z) => tc.getNormalAt(x, z));
    const changes = steps.slice(1).filter((s, i) => !contactPlanesEqual(steps[i].plane, s.plane)).length;
    expect(changes).toBeGreaterThan(1);
  });
});
