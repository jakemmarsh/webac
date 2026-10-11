/**
 * VISUAL.scorecard-world-town-framing — the scorecard's world-at-spawn screen
 * (world-town-day, world-town-far) was shot from `@telepoi holtburg` with a
 * harness yaw: yaw 0 faced a hillside and yaw 1.2 the road, while the retail
 * frame it is judged against (verification/retail-client/ab/retail-holtburg.png)
 * frames the lifestone, the cottages and the oven from the retail A/B spot.
 *
 * Under test: the scene table the harness runs (tools/capture-scenes.ts,
 * imported) puts both scenes on the retail A/B spot (tools/retail-ab-scenes.ts
 * HOLTBURG_SPOT) with the heading from the teleport quaternion (no yaw
 * override), and that heading puts the lifestone ahead-left and the Town Crier
 * behind, as the A/B probe recorded them (verification/retail-client/ab/core18-state.json).
 * And the camera-distance pin (tools/lib/camera-pins.ts) actually moves a
 * real CameraController: the old `cameraDistance = 18` assignment hit a
 * getter and was dropped, so world-town-far equalled world-town-day.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { CAMERA_RESET_JS, ZOOM_FARTHEST, cameraZoomToJs } from '../tools/lib/camera-pins.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCENES, HOLTBURG, HOLTBURG_TOWN_SPOT } from '../tools/capture-scenes.js';
import { HOLTBURG_SPOT } from '../tools/retail-ab-scenes.js';

const ROOT = resolve(__dirname, '..');

function parseTeleloc(cmd: string) {
  const m = /^@teleloc (0x[0-9A-Fa-f]{8}) \[(-?[\d.]+) (-?[\d.]+) (-?[\d.]+)\] (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)$/.exec(cmd);
  if (!m) throw new Error('not a full @teleloc: ' + cmd);
  return { cell: parseInt(m[1], 16), x: +m[2], y: +m[3], z: +m[4], q: { w: +m[5], x: +m[6], y: +m[7], z: +m[8] } };
}

/** AC frame: identity faces north (+Y); a rotation θ about +Z turns the forward vector to (-sin θ, cos θ). */
function forwardOf(q: { w: number; z: number }): { east: number; north: number } {
  const theta = 2 * Math.atan2(q.z, q.w);
  return { east: -Math.sin(theta), north: Math.cos(theta) };
}

/** Signed bearing (degrees, + = to the right) of an offset relative to `fwd`. */
function relBearingDeg(fwd: { east: number; north: number }, d: { dEast: number; dNorth: number }): number {
  const cross = fwd.north * d.dEast - fwd.east * d.dNorth;
  const dot = fwd.east * d.dEast + fwd.north * d.dNorth;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

describe('VISUAL.scorecard-world-town-framing — the town scenes frame what the retail Holtburg frame shows', () => {
  const day = SCENES.find((s) => s.name === 'world-town-day')!;
  const far = SCENES.find((s) => s.name === 'world-town-far')!;

  it('both scenes teleport to the retail A/B spot, not the @telepoi arrival', () => {
    expect(HOLTBURG_TOWN_SPOT).toBe(HOLTBURG_SPOT);
    expect(day.teleport).toBe(HOLTBURG_SPOT);
    expect(far.teleport).toBe(HOLTBURG_SPOT);
    expect(day.teleport).not.toBe(HOLTBURG);
  });

  it('the heading comes from the teleport quaternion: no harness yaw on either scene', () => {
    expect(day.yaw).toBeUndefined();
    expect(far.yaw).toBeUndefined();
  });

  it('world-town-far is the same view with the camera pulled back', () => {
    expect(far.cameraDistance).toBe(ZOOM_FARTHEST);
    expect(day.cameraDistance).toBeUndefined();
    expect(far.timeOfDay).toBe(day.timeOfDay);
  });

  it('the scene the scorecard pairs with the retail frame is still the noon baseline', () => {
    expect(day.timeOfDay).toBe(0.5);
  });

  it("the spot is a full @teleloc into Holtburg's landblock 0xA9B4, a pure heading rotation", () => {
    const t = parseTeleloc(HOLTBURG_TOWN_SPOT);
    expect(t.cell >>> 16).toBe(0xa9b4);
    expect(t.q.x).toBe(0);
    expect(t.q.y).toBe(0);
    expect(Math.hypot(t.q.w, t.q.z)).toBeCloseTo(1, 3);
  });

  it('from that heading the lifestone is ahead-left and the Town Crier behind (the A/B probe offsets)', () => {
    const state = JSON.parse(readFileSync(resolve(ROOT, 'verification/retail-client/ab/core18-state.json'), 'utf8')) as {
      retailHeading: { name: string; dEast: number; dNorth: number }[];
    };
    const fwd = forwardOf(parseTeleloc(HOLTBURG_TOWN_SPOT).q);
    // facing a little east of north
    expect(fwd.north).toBeGreaterThan(0.95);
    expect(fwd.east).toBeGreaterThan(0);
    const at = (n: string) => state.retailHeading.find((o) => o.name === n)!;
    const life = relBearingDeg(fwd, at('Life Stone'));
    expect(life).toBeLessThan(0); // left of centre, as in retail-holtburg.png
    expect(life).toBeGreaterThan(-45); // inside a 16:9 frame
    expect(Math.abs(relBearingDeg(fwd, at('Town Crier')))).toBeGreaterThan(90);
  });
});

describe('VISUAL.scorecard-world-town-framing — the camera pin zooms the real rig, capped at retail\'s far limit', () => {
  const g = globalThis as { window?: unknown };
  const had = 'window' in g;
  const prev = g.window;
  afterEach(() => { if (had) g.window = prev; else delete g.window; });

  function rig(): CameraController {
    const c = new CameraController(new THREE.PerspectiveCamera());
    for (let i = 0; i < 20; i++) c.frameRate.push(1 / 60);
    g.window = { __ac: { cameraController: c } };
    return c;
  }
  const run = (js: string): unknown => (0, eval)(js);

  it('a direct cameraDistance write is dropped (the bug: a getter-only property)', () => {
    const c = rig();
    const home = c.cameraDistance;
    expect(() => { (c as unknown as { cameraDistance: number }).cameraDistance = 18; }).toThrow(TypeError);
    expect(c.cameraDistance).toBe(home);
  });

  it('ZOOM_FARTHEST ends at full zoom-out: the boom stops where retail refuses the next Farther tick (10 m back)', () => {
    const c = rig();
    const home = c.cameraDistance;
    const boom = run(cameraZoomToJs(ZOOM_FARTHEST)) as number;
    expect(boom).toBe(c.cameraDistance);
    expect(boom).toBeGreaterThan(home * 3);
    const back = c.thirdPersonBoom().back;
    expect(back).toBeLessThanOrEqual(10);
    expect(back * (1 + (1 / 60) * 40 * 0.2)).toBeGreaterThan(10);
  });

  it('a reachable distance stops at the first notch at or past it', () => {
    const c = rig();
    const boom = run(cameraZoomToJs(5)) as number;
    expect(boom).toBeGreaterThanOrEqual(5);
    expect(boom / (1 + (1 / 60) * 40 * 0.2)).toBeLessThan(5);
  });

  it('starts from the default boom whatever the last scene left, and the reset returns to it', () => {
    const c = rig();
    const home = c.cameraDistance;
    c.zoomBy(-3);
    const a = run(cameraZoomToJs(5)) as number;
    c.zoomBy(4);
    const b = run(cameraZoomToJs(5)) as number;
    expect(b).toBeCloseTo(a, 9);
    run(CAMERA_RESET_JS);
    expect(c.cameraDistance).toBeCloseTo(home, 9);
  });
});
