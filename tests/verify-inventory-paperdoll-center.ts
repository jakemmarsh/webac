/**
 * CORE.17.m — the paperdoll figure is framed by the RETAIL camera, not by a
 * bounding-box fit or a 2D centroid shift (VISUAL.42's mass-centroid
 * re-centering is superseded: retail never re-centers, it places the
 * camera 0.12 m off-axis so the figure sits under the drag band
 * 0x100001d6, centred at x=101 of 224).
 *
 * Ground truth (decompiled EoL client):
 * - gmPaperDollUI::PostInit @ 004a5360 → UIElement_Viewport::SetCamera
 *   (position (0.12, -2.4, 0.88), direction (0,0,0)) — literals recovered
 *   from the disassembly at 004a5a39..004a5a61.
 * - gmPaperDollUI::UpdateForRace @ 004a3ed0: Gearknight/Tumerok y=-3.0;
 *   Lugian y=-3.4 z=1.0; Empyrean/Olthoi/OlthoiAcid y=-3.4.
 * - CreatureMode::CreatureMode @ 00454390: FOV 0.7853982 rad, ambient 0.3;
 *   Render::SetFOVInternal @ 0054b340 derives the view distance from the
 *   viewport HEIGHT, so the FOV is vertical.
 * - gmPaperDollUI::RedressCreature @ 004a3bc0: set_heading(191.3679).
 *
 * Before this fix the camera was (0, 0.85, 4.2) at 30° looking at y=0.65:
 * the crown of a standing figure projected ABOVE the 214px viewport
 * (verification/core17-inventory/before-*.png — decapitated doll).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  PAPERDOLL_CAMERA_DEFAULT, PAPERDOLL_CAMERA_BY_HERITAGE, PAPERDOLL_FOV_RAD,
  PAPERDOLL_HEADING_DEG, PAPERDOLL_AMBIENT, PAPERDOLL_DISTANT_LIGHT,
  resolvePaperdollCamera, buildPaperdollCamera, paperdollFigureRotationY,
  paperdollVisibleYRange, projectPaperdollPoint,
} from '../packages/renderer/src/ui/PaperdollFraming.js';

const W = 224, H = 214; // layout 0x21000024 viewport 0x100001d5

describe('CORE.17.m — retail paperdoll camera (gmPaperDollUI)', () => {
  it('pins the decompiled constants', () => {
    expect(PAPERDOLL_CAMERA_DEFAULT).toEqual({ x: 0.12, y: -2.4, z: 0.88 });
    expect(PAPERDOLL_FOV_RAD).toBeCloseTo(Math.PI / 4, 6);
    expect(PAPERDOLL_HEADING_DEG).toBeCloseTo(191.3679, 4);
    expect(PAPERDOLL_AMBIENT).toBe(0.3);
    expect(PAPERDOLL_DISTANT_LIGHT).toBe(2.0);
  });

  it('UpdateForRace overrides: Gearknight/Tumerok -3.0, Lugian -3.4/1.0, Empyrean/Olthoi -3.4; humans keep the PostInit default', () => {
    expect(resolvePaperdollCamera(6)).toEqual({ x: 0.12, y: -3.0, z: 0.88 });
    expect(resolvePaperdollCamera(7)).toEqual({ x: 0.12, y: -3.0, z: 0.88 });
    expect(resolvePaperdollCamera(8)).toEqual({ x: 0.12, y: -3.4, z: 1.0 });
    for (const h of [9, 12, 13]) expect(resolvePaperdollCamera(h)).toEqual({ x: 0.12, y: -3.4, z: 0.88 });
    for (const h of [0, 1, 2, 3, 4, 5, 10, 11, 99]) expect(resolvePaperdollCamera(h)).toBe(PAPERDOLL_CAMERA_DEFAULT);
    expect([...PAPERDOLL_CAMERA_BY_HERITAGE.keys()].sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 12, 13]);
  });

  it('builds a 45° vertical-FOV camera with no pitch at the AC position through the world\'s (x, z, y) mapping (CORE.18.f)', () => {
    const cam = buildPaperdollCamera(1, W, H);
    expect(cam.fov).toBeCloseTo(45, 4);
    expect(cam.aspect).toBeCloseTo(W / H, 6);
    expect(cam.position.x).toBeCloseTo(0.12, 6);
    expect(cam.position.y).toBeCloseTo(0.88, 6);
    expect(cam.position.z).toBeCloseTo(-2.4, 6);
    // No pitch: the view axis is horizontal, along AC +y = three +z.
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    expect(fwd.y).toBeCloseTo(0, 6);
    expect(fwd.z).toBeCloseTo(1, 6);
  });

  it('a standing 1.85 m figure at the origin fits the frame: sole and crown both inside the 214px viewport with headroom', () => {
    const cam = buildPaperdollCamera(1, W, H);
    const crown = projectPaperdollPoint(cam, new THREE.Vector3(0, 1.85, 0), W, H);
    const sole = projectPaperdollPoint(cam, new THREE.Vector3(0, 0, 0), W, H);
    expect(crown.y).toBeGreaterThan(0);
    expect(crown.y).toBeLessThan(20);      // a few px of headroom, like inventory-panel.jpg
    expect(sole.y).toBeLessThan(H);
    expect(sole.y).toBeGreaterThan(H - 30); // boots near the bottom edge
    // Visible range at the figure plane: 0.88 ± 2.4·tan(22.5°)
    const r = paperdollVisibleYRange(1);
    expect(r.bottom).toBeCloseTo(0.88 - 2.4 * Math.tan(Math.PI / 8), 6);
    expect(r.top).toBeCloseTo(0.88 + 2.4 * Math.tan(Math.PI / 8), 6);
    expect(r.top).toBeGreaterThan(1.85);
    expect(r.bottom).toBeLessThan(0);
  });

  it('the old (0, 0.85, 4.2) 30° camera looking at y=0.65 DID cut the crown off (regression witness)', () => {
    const old = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);
    old.position.set(0, 0.85, 4.2);
    old.lookAt(0, 0.65, 0);
    old.updateMatrixWorld(true);
    const crown = projectPaperdollPoint(old, new THREE.Vector3(0, 1.85, 0), W, H);
    expect(crown.y).toBeLessThan(0);
  });

  it('the figure lands left of centre under the drag band (0x100001d6 centred at x=101), not re-centred to 112', () => {
    const cam = buildPaperdollCamera(1, W, H);
    const chest = projectPaperdollPoint(cam, new THREE.Vector3(0, 1.0, 0), W, H);
    expect(chest.x).toBeLessThan(W / 2);
    expect(chest.x).toBeGreaterThan(90);
    expect(chest.x).toBeLessThan(110);
  });

  it('Lugians (heritage 8) get the further, higher camera so the taller figure still fits', () => {
    const cam = buildPaperdollCamera(8, W, H);
    expect(cam.position.z).toBeCloseTo(-3.4, 6);
    expect(cam.position.y).toBeCloseTo(1.0, 6);
    const crown = projectPaperdollPoint(cam, new THREE.Vector3(0, 2.3, 0), W, H);
    expect(crown.y).toBeGreaterThan(0);
  });

  it('figure yaw is 180° + 11.3679° (retail heading 191.3679 with 180 = square-on; the model faces three +z at 0)', () => {
    expect(paperdollFigureRotationY()).toBeCloseTo(Math.PI + 11.3679 * Math.PI / 180, 6);
  });
});
