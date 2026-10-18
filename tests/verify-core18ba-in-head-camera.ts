/**
 * CORE.18.b.a — the retail in-head view and the camera's player translucency.
 *
 * acclient.exe: CameraSet::Closer @ 004586d0 refuses a step below
 * CAMERA_MIN_CHAR_DIST (0.5); CameraManager::OnAction 0x3a → CameraSet::SetInHead
 * @ 00458ce0 (viewer_offset (0, CAMERA_IN_HEAD_Y 0.18, 0), target direction
 * (0, 1, 0)); CameraSet::UpdateCamera @ 00458ae0 sets the player's
 * translucency: 1 in the head, else 1 − (0.2 − d) / (0.2 − 0.45) clamped when
 * the viewer is within CAMERA_MIN_CHAR_DIST2 (0.45) of the pivot, else 0.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import {
  CAMERA_IN_HEAD_Y, CAMERA_MIN_CHAR_DIST2, CAMERA_MIN_CHAR_TRANS_DIST, cameraPlayerTranslucency,
} from '../packages/renderer/src/scene/RetailCamera.js';
import { applyViewerFade, viewerFadeLevel, withoutViewerFade } from '../packages/renderer/src/scene/ViewerFade.js';
import { ACT } from '../packages/renderer/src/input/KeybindDefaults.js';

describe('CORE.18.b.a retail camera translucency curve', () => {
  it('uses the .rdata constants', () => {
    expect(CAMERA_IN_HEAD_Y).toBe(0.18);
    expect(CAMERA_MIN_CHAR_DIST2).toBe(0.45);
    expect(CAMERA_MIN_CHAR_TRANS_DIST).toBe(0.2);
  });

  it('is fully translucent in the head regardless of distance', () => {
    expect(cameraPlayerTranslucency(true, 5)).toBe(1);
  });

  it('is opaque at and beyond CAMERA_MIN_CHAR_DIST2', () => {
    expect(cameraPlayerTranslucency(false, 0.45)).toBe(0);
    expect(cameraPlayerTranslucency(false, 2.87)).toBe(0);
  });

  it('fades linearly from 0.45 m (opaque) to 0.2 m (invisible) and clamps', () => {
    expect(cameraPlayerTranslucency(false, 0.325)).toBeCloseTo(0.5, 6);
    expect(cameraPlayerTranslucency(false, 0.4)).toBeCloseTo(0.2, 6);
    expect(cameraPlayerTranslucency(false, 0.2)).toBeCloseTo(1, 6);
    expect(cameraPlayerTranslucency(false, 0.05)).toBe(1);
  });
});

describe('CORE.18.b.a in-head camera', () => {
  it('the wheel alone never yields the in-head translucency', () => {
    const c = new CameraController(new THREE.PerspectiveCamera());
    c.zoomBy(-1000);
    for (let i = 0; i < 300; i++) c.update(1 / 60);
    expect(c.isFirstPerson).toBe(false);
    // The closest boom (0.602 m) keeps the player opaque — only collision can fade it.
    expect(cameraPlayerTranslucency(c.isFirstPerson, c.cameraDistance)).toBe(0);
  });

  it('action 0x3a is the retail First Person Camera action', () => {
    expect(ACT.FirstPersonCamera).toBe(0x3a);
  });
});

describe('CORE.18.b.a applyViewerFade', () => {
  function playerLike(): { root: THREE.Group; mesh: THREE.Mesh; shared: THREE.MeshBasicMaterial } {
    const shared = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), shared);
    const root = new THREE.Group();
    root.add(mesh);
    return { root, mesh, shared };
  }

  it('the paperdoll\'s clone of a first-person (hidden) or half-faded player is whole and opaque; the live model stays as it was', () => {
    for (const level of [1, 0.6]) {
      const { root, mesh, shared } = playerLike();
      applyViewerFade(root, level);
      const clone = withoutViewerFade(root, () => root.clone(true));
      expect(clone.visible).toBe(true);
      expect(clone.userData.acNoDraw).toBeUndefined();
      expect((clone.children[0] as THREE.Mesh).material).toBe(shared);
      // The world view keeps its fade.
      expect(viewerFadeLevel(root)).toBe(level);
      expect(root.visible).toBe(level < 1);
      if (level < 1) expect((mesh.material as THREE.Material).opacity).toBeCloseTo(1 - level, 6);
    }
    // Not faded: just the callback.
    const plain = playerLike();
    expect(withoutViewerFade(plain.root, () => 7)).toBe(7);
  });

  it('never writes to the shared (cached) material', () => {
    const { root, mesh, shared } = playerLike();
    applyViewerFade(root, 0.5);
    expect(mesh.material).not.toBe(shared);
    expect((mesh.material as THREE.Material).opacity).toBeCloseTo(0.5, 6);
    expect((mesh.material as THREE.Material).transparent).toBe(true);
    expect(shared.opacity).toBe(1);
    expect(shared.transparent).toBe(false);
    expect(root.visible).toBe(true);
  });

  it('restores the shared material at 0 and reuses its clone on the next fade', () => {
    const { root, mesh, shared } = playerLike();
    applyViewerFade(root, 0.3);
    const clone = mesh.material;
    applyViewerFade(root, 0);
    expect(mesh.material).toBe(shared);
    applyViewerFade(root, 0.6);
    expect(mesh.material).toBe(clone);
    expect((mesh.material as THREE.Material).opacity).toBeCloseTo(0.4, 6);
    expect(viewerFadeLevel(root)).toBe(0.6);
  });

  it('fully translucent hides the model and puts the shared material back', () => {
    const { root, mesh, shared } = playerLike();
    applyViewerFade(root, 0.5);
    applyViewerFade(root, 1);
    expect(root.visible).toBe(false);
    expect(mesh.material).toBe(shared);
    applyViewerFade(root, 0);
    expect(root.visible).toBe(true);
  });

  it('scales an already-translucent material from its own opacity', () => {
    const { root, mesh, shared } = playerLike();
    shared.transparent = true;
    shared.opacity = 0.8;
    applyViewerFade(root, 0.5);
    expect((mesh.material as THREE.Material).opacity).toBeCloseTo(0.4, 6);
  });
});

// BUG.bunker-camera-in-head's viewer cell rule (which land cells the boom meets from an env cell):
// tests/verify-bug-viewer-cell-rule.ts.
