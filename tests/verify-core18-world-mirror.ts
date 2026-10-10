/**
 * CORE.18 — the 3D world rendered as an east-west mirror image of Dereth.
 *
 * World geometry is built with AC (x, y, z) → three (x, z, y) (three +X = AC
 * east, +Z = AC north): a reflection. The world camera now carries the one
 * compensating mirror (scene/WorldMirror.ts), the renderer inverts the front
 * face for draws through it, and the controls turn/strafe/look the way the
 * (now true-handed) screen shows. Retail reference (same ACE, same spot,
 * facing north): the Holtburg lifestone draws LEFT of centre, the east-side
 * objects RIGHT — verification/retail-client/ab/retail-holtburg.png.
 *
 * Every test drives the shipped modules: SceneManager's world camera, the
 * CameraController, buildGfxObjGeometry and the culling hook.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SceneManager } from '../packages/renderer/src/scene/SceneManager.js';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import {
  mirrorCameraX, isMirroredCamera, installMirrorAwareCulling, type MirrorCullingRenderer,
} from '../packages/renderer/src/scene/WorldMirror.js';
import { buildGfxObjGeometry } from '../packages/renderer/src/models/GfxObjMesh.js';

/** AC world (east, north, up) → the renderer's three space (x, z, y). */
function acToThree(east: number, north: number, up: number): THREE.Vector3 {
  return new THREE.Vector3(east, up, north);
}

/** A world camera at the origin, 1.6 m up, facing AC north (yaw π). */
function northFacingWorldCamera(): { sm: SceneManager; cc: CameraController } {
  const sm = new SceneManager();
  sm.camera.aspect = 16 / 9;
  sm.camera.updateProjectionMatrix();
  const cc = new CameraController(sm.camera);
  cc.setPosition(0, 1.6, 0);
  cc.playerYaw = Math.PI;
  cc.update(0);
  sm.camera.updateMatrixWorld(true);
  return { sm, cc };
}

function ndcX(camera: THREE.Camera, p: THREE.Vector3): number {
  return p.clone().project(camera).x;
}

/** AC forward (east, north) of the controller's player heading. */
function acForward(cc: CameraController): { east: number; north: number } {
  return { east: -Math.sin(cc.playerYaw), north: -Math.cos(cc.playerYaw) };
}

describe('CORE.18 — world camera projection is true-handed', () => {
  it('facing north, an object to the EAST draws right of centre and WEST draws left (retail Holtburg frame)', () => {
    const { sm } = northFacingWorldCamera();
    expect(isMirroredCamera(sm.camera)).toBe(true);
    // The Bind Stone (dEast +60.7) / Portal to Town Network (dEast −69.9)
    // arrangement from the A/B probe, scaled into view.
    const east = acToThree(+20, 30, 1.6);
    const west = acToThree(-20, 30, 1.6);
    expect(ndcX(sm.camera, east)).toBeGreaterThan(0.2);
    expect(ndcX(sm.camera, west)).toBeLessThan(-0.2);
  });

  it('the same scene through an un-mirrored three camera is the east-west mirror image (the defect)', () => {
    const { sm } = northFacingWorldCamera();
    const plain = new THREE.PerspectiveCamera(sm.camera.fov, sm.camera.aspect, 0.1, 2000);
    plain.position.copy(sm.camera.position);
    plain.quaternion.copy(sm.camera.quaternion);
    plain.updateMatrixWorld(true);
    const east = acToThree(+20, 30, 1.6);
    expect(ndcX(plain, east)).toBeCloseTo(-ndcX(sm.camera, east), 6);
  });

  it('the mirror survives resize / FOV changes (updateProjectionMatrix)', () => {
    const { sm } = northFacingWorldCamera();
    sm.resize(1600, 900);
    sm.camera.fov = 70;
    sm.camera.updateProjectionMatrix();
    sm.camera.updateMatrixWorld(true);
    expect(ndcX(sm.camera, acToThree(10, 30, 1.6))).toBeGreaterThan(0);
    // projectionMatrixInverse stays the exact inverse (unproject / picking)
    const id = sm.camera.projectionMatrix.clone().multiply(sm.camera.projectionMatrixInverse);
    const e = id.elements;
    const I = new THREE.Matrix4().elements;
    for (let i = 0; i < 16; i++) expect(e[i]).toBeCloseTo(I[i], 9);
  });

  it('mirrorCameraX is idempotent (a second call does not un-mirror)', () => {
    const cam = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
    mirrorCameraX(cam);
    const once = cam.projectionMatrix.clone();
    mirrorCameraX(cam);
    cam.updateProjectionMatrix();
    expect(cam.projectionMatrix.equals(once)).toBe(true);
  });

  it('picking follows the mirror: a Raycaster through the projected screen point hits the east object', () => {
    const { sm } = northFacingWorldCamera();
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
    box.position.copy(acToThree(+8, 25, 1.6));
    box.updateMatrixWorld(true);
    const decoy = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
    decoy.position.copy(acToThree(-8, 25, 1.6));
    decoy.updateMatrixWorld(true);
    const ndc = box.position.clone().project(sm.camera);
    expect(ndc.x).toBeGreaterThan(0);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), sm.camera);
    const hits = rc.intersectObjects([box, decoy]);
    expect(hits[0]?.object).toBe(box);
  });

  it('frustum culling built from the mirrored projection keeps objects on both sides in view', () => {
    const { sm } = northFacingWorldCamera();
    const f = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(sm.camera.projectionMatrix, sm.camera.matrixWorldInverse));
    expect(f.containsPoint(acToThree(10, 30, 1.6))).toBe(true);
    expect(f.containsPoint(acToThree(-10, 30, 1.6))).toBe(true);
    expect(f.containsPoint(acToThree(0, -30, 1.6))).toBe(false); // behind
  });
});

describe('CORE.18 — front faces survive the mirror (culling hook + mesh winding)', () => {
  /** Signed screen area (NDC, y up): > 0 = counter-clockwise on screen. */
  function screenArea(camera: THREE.Camera, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number {
    const A = a.clone().project(camera), B = b.clone().project(camera), C = c.clone().project(camera);
    return (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
  }

  it('a GfxObj polygon whose outward normal faces the camera is front-facing under the mirrored camera + inverted front face', () => {
    // AC polygon 5 m north of the viewer, outward normal pointing SOUTH (at
    // the viewer), vertices counter-clockwise about that normal (right-hand
    // rule — the sanity check below proves the order).
    const n = { x: 0, y: -1, z: 0 };
    const v = (id: number, x: number, z: number) => [id, { origin: { x, y: 5, z }, normal: n, uvs: [] }] as const;
    const gfx = {
      vertexArray: { vertices: new Map([v(0, 1, 0), v(1, -1, 0), v(2, 0, 3)]) },
      polygons: [{ vertexIndices: [0, 2, 1], posUVIndices: [0, 0, 0], posSurface: 0 }],
      physicsPolygons: new Map(),
    };
    // Sanity: the chosen order is CCW about the outward normal in AC space.
    const P = [gfx.vertexArray.vertices.get(0)!.origin, gfx.vertexArray.vertices.get(2)!.origin, gfx.vertexArray.vertices.get(1)!.origin];
    const e1 = new THREE.Vector3(P[1].x - P[0].x, P[1].y - P[0].y, P[1].z - P[0].z);
    const e2 = new THREE.Vector3(P[2].x - P[0].x, P[2].y - P[0].y, P[2].z - P[0].z);
    expect(e1.cross(e2).dot(new THREE.Vector3(n.x, n.y, n.z))).toBeGreaterThan(0);

    const geo = buildGfxObjGeometry(gfx as never);
    expect(geo.indices.length).toBe(3);
    const pos = (i: number) => new THREE.Vector3(geo.positions[i * 3], geo.positions[i * 3 + 1], geo.positions[i * 3 + 2]);
    const [a, b, c] = [pos(geo.indices[0]), pos(geo.indices[1]), pos(geo.indices[2])];

    const { sm } = northFacingWorldCamera();
    sm.camera.position.set(0, 1, 0);
    sm.camera.updateMatrixWorld(true);
    // Mirrored projection: the triangle is CLOCKWISE on screen …
    expect(screenArea(sm.camera, a, b, c)).toBeLessThan(0);
    // … and the hook hands three frontFaceCW = true for it (gl.frontFace CW),
    // so it is the FRONT face and is drawn — exactly as the un-mirrored
    // camera drew it CCW with gl.frontFace CCW.
    const seen: boolean[] = [];
    const fake: MirrorCullingRenderer = {
      state: { setMaterial: (_m, cw) => { seen.push(cw); } },
      renderBufferDirect(camera, _s, _g, material, object) {
        const cw = (object as THREE.Mesh).isMesh && object.matrixWorld.determinant() < 0;
        this.state.setMaterial(material, cw);
      },
    };
    installMirrorAwareCulling(fake);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    fake.renderBufferDirect(sm.camera, null, mesh.geometry, mesh.material as THREE.Material, mesh, null);
    expect(seen).toEqual([true]);
  });

  it('draws through an un-mirrored camera (UI previews, portal space) keep three\'s own front face', () => {
    const seen: boolean[] = [];
    const fake: MirrorCullingRenderer = {
      state: { setMaterial: (_m, cw) => { seen.push(cw); } },
      renderBufferDirect(_c, _s, _g, material, object) {
        this.state.setMaterial(material, object.matrixWorld.determinant() < 0);
      },
    };
    installMirrorAwareCulling(fake);
    installMirrorAwareCulling(fake); // idempotent: a double install must not cancel out
    const plain = new THREE.PerspectiveCamera();
    const mirrored = mirrorCameraX(new THREE.PerspectiveCamera());
    const flipped = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    flipped.scale.set(-1, 1, 1);
    flipped.updateMatrixWorld(true);
    const upright = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    const m = upright.material as THREE.Material;
    fake.renderBufferDirect(plain, null, upright.geometry, m, upright, null);
    fake.renderBufferDirect(plain, null, flipped.geometry, m, flipped, null);
    fake.renderBufferDirect(mirrored, null, upright.geometry, m, upright, null);
    fake.renderBufferDirect(mirrored, null, flipped.geometry, m, flipped, null);
    expect(seen).toEqual([false, true, true, false]);
  });
});

describe('CORE.18 — controls match the true-handed screen', () => {
  it('turn left (A) from north swings the heading WEST; turn right (D) swings it EAST', () => {
    const { cc } = northFacingWorldCamera();
    cc.simulateKeyDown('KeyA');
    cc.update(0.1);
    cc.simulateKeyUp('KeyA');
    expect(acForward(cc).east).toBeLessThan(0);
    expect(acForward(cc).north).toBeGreaterThan(0.9);

    const { cc: cc2 } = northFacingWorldCamera();
    cc2.simulateKeyDown('KeyD');
    cc2.update(0.1);
    expect(acForward(cc2).east).toBeGreaterThan(0);
  });

  it('turning left moves a straight-ahead object to the RIGHT of the screen (the view pans left)', () => {
    const { sm, cc } = northFacingWorldCamera();
    const ahead = acToThree(0, 30, 1.6);
    expect(Math.abs(ndcX(sm.camera, ahead))).toBeLessThan(1e-6);
    cc.simulateKeyDown('KeyA');
    cc.update(0.1);
    sm.camera.updateMatrixWorld(true);
    expect(ndcX(sm.camera, ahead)).toBeGreaterThan(0);
  });

  it('strafe left (Z) facing north moves WEST, strafe right (C) moves EAST', () => {
    const { sm, cc } = northFacingWorldCamera();
    cc.simulateKeyDown('KeyZ');
    cc.update(0.1);
    cc.simulateKeyUp('KeyZ');
    expect(sm.camera.position.x).toBeLessThan(0); // three x = AC east
    expect(Math.abs(sm.camera.position.z)).toBeLessThan(1e-9);

    const { sm: sm2, cc: cc2 } = northFacingWorldCamera();
    cc2.simulateKeyDown('KeyC');
    cc2.update(0.1);
    expect(sm2.camera.position.x).toBeGreaterThan(0);
  });

  it('mouse-look right is Rotate Camera Right (retail MouseLookHandler → Rotate(0) in 3rd person): the view moves exactly as the key moves it', () => {
    const ahead = acToThree(0, 30, 1.6);
    // The key: one Rotate Camera Right tick.
    const k = northFacingWorldCamera();
    let tk = 100; k.cc.clock = () => tk;
    k.cc.startRotate('right'); tk += 0.1; k.cc.tickHeldActions(); k.cc.stopRotate();
    k.cc.update(0); k.sm.camera.updateMatrixWorld(true);
    const keySign = Math.sign(ndcX(k.sm.camera, ahead));
    expect(keySign).not.toBe(0);
    // The mouse: mouse-look on, drag right over >5 consecutive updates.
    const m = northFacingWorldCamera();
    let tm = 100; m.cc.clock = () => tm;
    m.cc.setMouseLook(true);
    for (let i = 0; i < 8; i++) { tm += 0.016; m.cc.simulateMouseMove(20, 0); m.cc.update(0); }
    m.sm.camera.updateMatrixWorld(true);
    expect(Math.sign(ndcX(m.sm.camera, ahead))).toBe(keySign);
    expect(Math.sign(m.cc.cameraYawOffset)).toBe(Math.sign(k.cc.cameraYawOffset));
    // mouse look orbits the camera only; the player heading is unchanged
    expect(m.cc.playerYaw).toBe(Math.PI);
  });
});
