/**
 * CORE.8 — Camera clips into terrain when descending hills.
 *
 * Retail ground truth (decompiled EoL client, acclient-decompiled.c):
 * SmartBox::update_viewer @ 00453ce0 sweeps the camera as a collision sphere
 * through the physics world each frame — CTransition::init_object(player,
 * 0x5c) + init_sphere(1, &viewer_sphere, 1.0) + init_path(cell, playerPos,
 * soughtCameraPos), then find_valid_position. viewer_sphere.radius = 0.3.
 * Flags 0x5c = IsViewer(0x4) | PathClipped(0x8) | FreeRotate(0x10) |
 * PerfectClip(0x40) per ACE ObjectInfo.cs (ACE's physics is a port of this
 * client code); PathClipped stops the sweep at the FIRST collision (ACE
 * Transition.cs:590), i.e. the camera boom is clipped where the viewer
 * sphere meets the ground.
 *
 * Our client swept the boom only against building meshes + scenery
 * cylinders (DungeonCollision.getCameraDistance) — never the terrain — so
 * descending a hill put the boom end inside the hillside behind the player.
 *
 * TerrainCollision.getCameraDistance is the terrain leg of that sweep:
 * first distance along the horizontal boom at which the sphere center
 * comes within VIEWER_SPHERE_RADIUS of the terrain surface.
 */
import { describe, it, expect } from 'vitest';
import { TerrainCollision } from '@ac/shared/physics/TerrainCollision.js';

/** Build a landblock whose height depends only on the column (x), making
 *  every cell surface planar so triangle split direction is irrelevant. */
function rampBlock(colHeight: (col: number) => number): TerrainCollision {
  const tc = new TerrainCollision();
  const heights = new Array<number>(81);
  for (let col = 0; col < 9; col++) {
    for (let row = 0; row < 9; row++) {
      heights[col * 9 + row] = colHeight(col);
    }
  }
  tc.setLandblock(0, 0, { heights, blockX: 0, blockY: 0 });
  return tc;
}

describe('CORE.8 — terrain collision on the camera boom', () => {
  it('pins the retail viewer sphere radius from the decompiled client', () => {
    // acclient decomp: viewer_sphere.radius = 0.3
    expect(TerrainCollision.VIEWER_SPHERE_RADIUS).toBe(0.3);
  });

  it('flat terrain far below the eye never clips the boom', () => {
    const tc = rampBlock(() => 0);
    // Eye 1.8m above flat ground, 10m boom in any direction.
    expect(tc.getCameraDistance(96, 1.8, 96, 0, 10, 10)).toBe(10);
    expect(tc.getCameraDistance(96, 1.8, 96, -10, 0, 10)).toBe(10);
  });

  it('clips the boom where the sphere meets a rising slope behind the player', () => {
    // Slope 0.5 m/m along +x (12m per 24m column). Player at x=6 → ground 3,
    // eye 4.8. Sphere contact where h > 4.5 → x > 9 → boom t > 3.
    const tc = rampBlock((col) => col * 12);
    const d = tc.getCameraDistance(6, 4.8, 96, 10, 0, 10);
    expect(d).toBeGreaterThan(2.9);
    expect(d).toBeLessThan(3.05);
    // The clipped camera point still clears the surface by ~the radius.
    const h = tc.getHeightAt(6 + d, 96)!;
    expect(4.8 - h).toBeGreaterThanOrEqual(0.3 - 0.001);
  });

  it('a crest midway along the boom clips early even when the endpoint is clear', () => {
    // Ridge along z at columns 3-4 (x 72-96) rising above the eye, low after.
    const tc = rampBlock((col) => (col === 3 || col === 4 ? 10 : 0));
    // Player at x=24 (col 1, h=0), eye 1.8, boom 100m toward +x. The endpoint
    // x=124 is beyond the ridge (col 5, h=0 → clear), but the ridge between
    // cols 2→3 (x 48→72, h 0→10) crosses eye-0.3=1.5 at x=51.6 → t≈27.6.
    const d = tc.getCameraDistance(24, 1.8, 96, 100, 0, 100);
    expect(d).toBeGreaterThan(27);
    expect(d).toBeLessThan(28.2);
  });

  it('a sheer rise right behind the player pulls the camera nearly to the eye (retail falls back toward the player position)', () => {
    // Near-cliff: column 0 at 0, column 1 at 100 → slope ~4.17 m/m.
    // Player at the base (x=0, ground 0, eye 1.8). Sphere contact where
    // h > 1.5 → x > 0.36 → boom clipped at ~0.36m of the requested 10m.
    const tc = rampBlock((col) => (col === 0 ? 0 : 100));
    const d = tc.getCameraDistance(0, 1.8, 96, 10, 0, 10);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThan(0.45);
  });

  it('unloaded landblocks never clip (no terrain, no contact)', () => {
    const tc = new TerrainCollision();
    expect(tc.getCameraDistance(96, 1.8, 96, 10, 0, 10)).toBe(10);
  });

  it('a zero-length boom or zero max distance returns maxDist unchanged', () => {
    const tc = rampBlock(() => 50); // terrain well above the eye everywhere
    expect(tc.getCameraDistance(96, 1.8, 96, 0, 0, 5)).toBe(5);
    expect(tc.getCameraDistance(96, 1.8, 96, 10, 0, 0)).toBe(0);
  });
});
