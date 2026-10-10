/**
 * CORE.18.f — the UI's own 3D views (inventory paperdoll 0x100001d5, the
 * chargen appearance / summary views, the examine portrait) draw the
 * (x, z, y)-built models the way retail does: through the SAME mirror as
 * the world camera (WorldMirror.mirrorCameraX), with the retail
 * CreatureMode frames placed through the world's mapping.
 *
 * Ground truth (reference/client-eol/decomp):
 *  - gmPaperDollUI::PostInit @ 004a5360 — camera (0.12, −2.4, 0.88),
 *    direction (0,0,0); RedressCreature @ 004a3bc0 — set_heading(191.3679).
 *  - Frame::set_heading @ 00535e40 — forward = (sin h, cos h, 0), h degrees.
 *  - CreatureMode::SetCameraDirection @ 00453730 — direction (0,0,0) looks
 *    along the frame's +y, level; CreatureMode ctor @ 00454390 — π/4
 *    vertical FOV.
 *  - BasicCreatureExamineUI::Init @ 004ab9c0 — set_heading(191.3679),
 *    bbox fit ×1.2071068 (0x3f9a827a) + depth/2, looking +y.
 *
 * The "retail" projections below are computed independently in AC axes (a
 * z-up pinhole looking +y whose screen-right is +x), so every assertion
 * compares our three.js camera against what the retail client draws. For a
 * front-facing figure its RIGHT hand lands on screen-LEFT.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { isMirroredCamera } from '../packages/renderer/src/scene/WorldMirror.js';
import {
  applyRetailLighting, setCellLighting, retailLightingKindOf, currentObjectAmbientScale,
} from '../packages/renderer/src/models/RetailLighting.js';
import {
  PAPERDOLL_LIGHT_DIRECTION, PAPERDOLL_AMBIENT, PAPERDOLL_DISTANT_LIGHT,
  buildPaperdollCamera, paperdollFigureRotationY, projectPaperdollPoint, PAPERDOLL_CAMERA_DEFAULT,
  PAPERDOLL_HEADING_DEG, resolvePaperdollCamera,
} from '../packages/renderer/src/ui/PaperdollFraming.js';
import {
  acToThree, headingToModelYaw, buildCreatureModeCamera, distantLightPosition, examineCameraPosition, threeBoxToAc,
  EXAMINE_FIT_FACTOR, EXAMINE_HEADING_DEG, type AcVec3,
} from '../packages/renderer/src/ui/CreatureViewCamera.js';
import { appearanceZoomedInCamera, APPEARANCE_INITIAL_HEADING } from '../packages/renderer/src/ui/ChargenAppearanceView.js';
import { summaryViewCamera } from '../packages/renderer/src/ui/ChargenSummary.js';

const W = 224, H = 214; // layout 0x21000024 viewport 0x100001d5

/** A body mesh with the retail `object` lighting patch, as MaterialFactory builds parts. */
function litBody(): THREE.Mesh {
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.8, 0.3), applyRetailLighting(new THREE.MeshLambertMaterial(), 'object'));
  body.position.set(0, 0.9, 0);
  return body;
}

/** Marker points in the MODEL's AC frame (x right, y forward, z up). */
const MARKERS: Record<string, AcVec3> = {
  rightHand: [0.3, 0.05, 1.0],
  leftHand: [-0.3, 0.05, 1.0],
  nose: [0, 0.12, 1.7],
  backOfHead: [0, -0.1, 1.7],
  chest: [0, 0, 1.0],
};

/** A figure built the way SetupModelRenderer builds parts: AC (x,y,z) → three (x,z,y). */
function syntheticFigure(): THREE.Group {
  const g = new THREE.Group();
  for (const [name, p] of Object.entries(MARKERS)) {
    const m = new THREE.Object3D();
    m.name = name;
    m.position.set(...acToThree(p));
    g.add(m);
  }
  return g;
}

/** Frame::set_heading: the model's AC local point in the world, at heading h. */
function acHeaded(p: AcVec3, headingDeg: number): AcVec3 {
  const h = headingDeg * Math.PI / 180;
  const c = Math.cos(h), s = Math.sin(h);
  // local +y → (sin h, cos h); local +x → (cos h, −sin h)
  return [p[0] * c + p[1] * s, -p[0] * s + p[1] * c, p[2]];
}

/** Retail's pinhole: camera at `cam` (AC), looking +y, level, screen-right = +x, vertical FOV. */
function retailProject(p: AcVec3, cam: AcVec3, w: number, h: number, fovRad = Math.PI / 4): { x: number; y: number; depth: number } {
  const depth = p[1] - cam[1];
  const f = (h / 2) / Math.tan(fovRad / 2);
  return { x: w / 2 + (p[0] - cam[0]) / depth * f, y: h / 2 - (p[2] - cam[2]) / depth * f, depth };
}

function markerWorld(root: THREE.Object3D, name: string): THREE.Vector3 {
  root.updateMatrixWorld(true);
  const o = root.getObjectByName(name);
  if (!o) throw new Error(`marker ${name} missing`);
  return o.getWorldPosition(new THREE.Vector3());
}

describe('CORE.18.f — paperdoll camera carries the world mirror and matches retail', () => {
  it('the paperdoll camera is flagged acMirrorX and its projection negates clip x (and keeps it after an update)', () => {
    const cam = buildPaperdollCamera(1, W, H);
    expect(isMirroredCamera(cam)).toBe(true);
    expect(cam.projectionMatrix.elements[0]).toBeLessThan(0);
    cam.aspect = 2; cam.updateProjectionMatrix();
    expect(cam.projectionMatrix.elements[0]).toBeLessThan(0);
  });

  it('every marker of a figure headed 191.3679 lands on the retail pixel (default + every heritage override)', () => {
    for (const heritage of [1, 6, 7, 8, 9, 12, 13]) {
      const cam = buildPaperdollCamera(heritage, W, H);
      const ac = resolvePaperdollCamera(heritage);
      const fig = syntheticFigure();
      fig.rotation.set(0, paperdollFigureRotationY(), 0);
      for (const [name, p] of Object.entries(MARKERS)) {
        const ours = projectPaperdollPoint(cam, markerWorld(fig, name), W, H);
        const retail = retailProject(acHeaded(p, PAPERDOLL_HEADING_DEG), [ac.x, ac.y, ac.z], W, H);
        expect(Math.abs(ours.x - retail.x)).toBeLessThan(1e-3);
        expect(Math.abs(ours.y - retail.y)).toBeLessThan(1e-3);
      }
    }
  });

  it('retail frame: the figure faces the camera, its RIGHT hand is on screen-LEFT, and it stands left of centre', () => {
    const cam = buildPaperdollCamera(1, W, H);
    const fig = syntheticFigure();
    fig.rotation.set(0, paperdollFigureRotationY(), 0);
    const right = projectPaperdollPoint(cam, markerWorld(fig, 'rightHand'), W, H);
    const left = projectPaperdollPoint(cam, markerWorld(fig, 'leftHand'), W, H);
    expect(right.x).toBeLessThan(left.x);
    const chest = projectPaperdollPoint(cam, markerWorld(fig, 'chest'), W, H);
    expect(chest.x).toBeLessThan(W / 2); // the 0.12 m offset camera (drag band 0x100001d6 centred at x=101)
    const d = (n: string): number => markerWorld(fig, n).distanceTo(cam.position);
    expect(d('nose')).toBeLessThan(d('backOfHead')); // the face, not the back
    // Turned 11.37° toward AC −x: the nose sits left of the head's centre line.
    const nose = projectPaperdollPoint(cam, markerWorld(fig, 'nose'), W, H);
    const head = projectPaperdollPoint(cam, markerWorld(fig, 'backOfHead'), W, H);
    expect(nose.x).toBeLessThan(head.x);
  });

  it('regression witness: the pre-CORE.18.f arrangement (plain camera on +z looking −z, yaw π+11.37°) showed the figure\'s BACK', () => {
    const old = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
    old.position.set(PAPERDOLL_CAMERA_DEFAULT.x, PAPERDOLL_CAMERA_DEFAULT.z, -PAPERDOLL_CAMERA_DEFAULT.y);
    old.lookAt(PAPERDOLL_CAMERA_DEFAULT.x, PAPERDOLL_CAMERA_DEFAULT.z, 0);
    old.updateMatrixWorld(true);
    const fig = syntheticFigure();
    fig.rotation.set(0, Math.PI + THREE.MathUtils.degToRad(PAPERDOLL_HEADING_DEG - 180), 0);
    const d = (n: string): number => markerWorld(fig, n).distanceTo(old.position);
    expect(d('nose')).toBeGreaterThan(d('backOfHead'));
  });
});

describe('CORE.18.f — chargen views and the examine portrait', () => {
  it('heading → yaw is Frame::set_heading: the model (facing three +z) turns to (sin h, cos h) in (east, north)', () => {
    for (const h of [0, 90, 180, 191.3679, 270]) {
      const fig = syntheticFigure();
      fig.rotation.set(0, headingToModelYaw(h), 0);
      const fwd = markerWorld(fig, 'nose').sub(markerWorld(fig, 'backOfHead')).normalize();
      const r = h * Math.PI / 180;
      expect(fwd.x).toBeCloseTo(Math.sin(r), 6); // three x = AC east
      expect(fwd.z).toBeCloseTo(Math.cos(r), 6); // three z = AC north
    }
  });

  it('the appearance face camera and the summary camera, mirrored, put every marker on the retail pixel', () => {
    const views: AcVec3[] = [appearanceZoomedInCamera(1), appearanceZoomedInCamera(12)];
    for (const hh of [1, 12, 13]) { const s = summaryViewCamera(hh); views.push([0, s.y, s.z]); }
    const w = 265, h = 450;
    for (const camAc of views) {
      const cam = buildCreatureModeCamera(camAc, w, h);
      expect(isMirroredCamera(cam)).toBe(true);
      const fig = syntheticFigure();
      fig.rotation.set(0, headingToModelYaw(APPEARANCE_INITIAL_HEADING), 0);
      for (const [name, p] of Object.entries(MARKERS)) {
        const world = acHeaded(p, APPEARANCE_INITIAL_HEADING);
        const retail = retailProject(world, camAc, w, h);
        if (retail.depth <= 0.1) continue; // behind the near plane
        const ours = projectPaperdollPoint(cam, markerWorld(fig, name), w, h);
        expect(Math.abs(ours.x - retail.x)).toBeLessThan(1e-3);
        expect(Math.abs(ours.y - retail.y)).toBeLessThan(1e-3);
      }
    }
  });

  it('BasicCreatureExamineUI::Init framing: the box\'s front face fills the vertical FOV exactly, camera at the box centre', () => {
    const min: AcVec3 = [-0.3, -0.2, 0], max: AcVec3 = [0.3, 0.2, 1.8];
    const w = 120, h = 140;
    const pos = examineCameraPosition(min, max, w, h);
    expect(pos[0]).toBeCloseTo(0, 9);
    expect(pos[2]).toBeCloseTo(0.9, 9);
    expect(pos[1]).toBeCloseTo(-(1.8 * EXAMINE_FIT_FACTOR + 0.2), 9);
    const cam = buildCreatureModeCamera(pos, w, h);
    const top = projectPaperdollPoint(cam, new THREE.Vector3(...acToThree([0, -0.2, 1.8])), w, h);
    const bottom = projectPaperdollPoint(cam, new THREE.Vector3(...acToThree([0, -0.2, 0])), w, h);
    expect(top.y).toBeCloseTo(0, 2);
    expect(bottom.y).toBeCloseTo(h, 2);
    // A wide, squat box is fitted by its width scaled to the viewport aspect.
    const wide = examineCameraPosition([-1, -0.5, 0], [1, 0.5, 0.5], w, h);
    expect(wide[1]).toBeCloseTo(-(2 * (h / w) * EXAMINE_FIT_FACTOR + 0.5), 9);
  });

  it('threeBoxToAc undoes the (x, z, y) mapping', () => {
    const box = new THREE.Box3(new THREE.Vector3(1, 2, 3), new THREE.Vector3(4, 5, 6));
    expect(threeBoxToAc(box)).toEqual({ min: [1, 3, 2], max: [4, 6, 5] });
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('CORE.18.f — GameUI\'s real render paths hand the renderer a mirrored camera (happy-dom, fake renderer)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // The figure is captured AT render time: renderPaperdollToElement removes its clone afterwards.
  const renders: {
    figure: THREE.Object3D | undefined; camera: THREE.PerspectiveCamera;
    kinds: (string | undefined)[]; ambient: number; dirPos: THREE.Vector3 | null; dirTarget: THREE.Vector3 | null; dirIntensity: number;
  }[] = [];
  let savedGetContext: unknown;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const proto = domWindow.HTMLCanvasElement.prototype;
    savedGetContext = proto.getContext;
    proto.getContext = () => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    });
    const renderer = {
      getRenderTarget: () => null, setRenderTarget: () => {}, getClearAlpha: () => 1, setClearAlpha: () => {},
      clear: () => {}, readRenderTargetPixels: () => {},
      render: (scene: THREE.Scene, camera: THREE.PerspectiveCamera) => {
        const figure = scene.children.find((c) => c.getObjectByName('rightHand'));
        const kinds: (string | undefined)[] = [];
        figure?.traverse((o) => { if ((o as THREE.Mesh).isMesh) kinds.push(retailLightingKindOf((o as THREE.Mesh).material as THREE.Material)); });
        const amb = scene.children.find((c) => (c as THREE.AmbientLight).isAmbientLight) as THREE.AmbientLight | undefined;
        const dir = scene.children.find((c) => (c as THREE.DirectionalLight).isDirectionalLight) as THREE.DirectionalLight | undefined;
        renders.push({
          figure, camera, kinds, ambient: amb?.intensity ?? -1,
          dirPos: dir ? dir.position.clone() : null, dirTarget: dir ? dir.target.position.clone() : null, dirIntensity: dir?.intensity ?? -1,
        });
      },
    };
    // The player figure carries a retail-lit body (the world's `object` pass).
    const player = syntheticFigure();
    player.add(litBody());
    domWindow.__ac = {
      playerModel: player,
      sceneManager: { renderer },
      characterModelBuilder: { buildCharacterModel: () => syntheticFigure() },
    };
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container);
    // DEBT.main-ts-extractions — GameUI reaches the renderer / player model /
    // model builder through its injected UIHost, not window.__ac.
    ui.setUIHost({
      renderer: renderer as never,
      playerModel: domWindow.__ac.playerModel,
      characterModelBuilder: domWindow.__ac.characterModelBuilder as never,
    } as never);
    ui.syncChargenViewAnimation = () => {}; // the idle sequence needs the portal DAT; not under test
  });

  afterAll(() => {
    domWindow.HTMLCanvasElement.prototype.getContext = savedGetContext;
    delete domWindow.__ac;
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const figureIn = (f: THREE.Object3D | undefined): THREE.Object3D => {
    if (!f) throw new Error('figure not in scene');
    return f;
  };

  it('renderPaperdollToElement: mirrored camera, right hand on screen-left, face toward the camera', () => {
    renders.length = 0;
    ui.renderPaperdollToElement(domWindow.document.createElement('div'), W, H);
    expect(renders.length).toBe(1);
    const { figure, camera } = renders[0];
    expect(isMirroredCamera(camera)).toBe(true);
    const fig = figureIn(figure);
    const right = projectPaperdollPoint(camera, markerWorld(fig, 'rightHand'), W, H);
    const left = projectPaperdollPoint(camera, markerWorld(fig, 'leftHand'), W, H);
    expect(right.x).toBeLessThan(left.x);
    expect(markerWorld(fig, 'nose').distanceTo(camera.position))
      .toBeLessThan(markerWorld(fig, 'backOfHead').distanceTo(camera.position));
  });

  it('renderChargenModelInto (appearance face camera + summary camera): mirrored, right hand on screen-left, face toward the camera', () => {
    const canvas = domWindow.document.createElement('canvas');
    canvas.width = 265; canvas.height = 450;
    for (const camAc of [appearanceZoomedInCamera(1), [0, summaryViewCamera(1).y, summaryViewCamera(1).z] as AcVec3]) {
      renders.length = 0;
      ui.chargenPreviewScene = null;
      const pos = acToThree(camAc);
      ui.renderChargenModelInto(canvas, true, {
        position: pos, target: [pos[0], pos[1], pos[2] + 1], fov: 45, yaw: headingToModelYaw(APPEARANCE_INITIAL_HEADING),
      }, { view: 'summary', idle: true, key: 'summary' });
      expect(renders.length).toBe(1);
      const { figure, camera } = renders[0];
      expect(isMirroredCamera(camera)).toBe(true);
      const fig = figureIn(figure);
      const right = projectPaperdollPoint(camera, markerWorld(fig, 'rightHand'), 265, 450);
      const left = projectPaperdollPoint(camera, markerWorld(fig, 'leftHand'), 265, 450);
      expect(right.x).toBeLessThan(left.x);
      expect(markerWorld(fig, 'nose').distanceTo(camera.position))
        .toBeLessThan(markerWorld(fig, 'backOfHead').distanceTo(camera.position));
    }
  });

  it('renderExaminePreview: heading 191.3679, mirrored bbox-framed camera, right hand on screen-left', () => {
    renders.length = 0;
    const canvas = domWindow.document.createElement('canvas');
    canvas.width = 120; canvas.height = 140;
    // A body with real extent, so the bounding-box fit has something to frame.
    const fig = syntheticFigure();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.8, 0.3));
    body.position.set(0, 0.9, 0);
    fig.add(body);
    ui.renderExaminePreview(canvas, fig);
    expect(renders.length).toBe(1);
    const { camera } = renders[0];
    expect(isMirroredCamera(camera)).toBe(true);
    expect(fig.rotation.y).toBeCloseTo(headingToModelYaw(EXAMINE_HEADING_DEG), 9);
    const right = projectPaperdollPoint(camera, markerWorld(fig, 'rightHand'), 120, 140);
    const left = projectPaperdollPoint(camera, markerWorld(fig, 'leftHand'), 120, 140);
    expect(right.x).toBeLessThan(left.x);
    expect(markerWorld(fig, 'nose').distanceTo(camera.position))
      .toBeLessThan(markerWorld(fig, 'backOfHead').distanceTo(camera.position));
  });

  it('the paperdoll lights its figure with CreatureMode\'s own light even when the player stands inside an env cell (the near-black indoor doll)', () => {
    const pm = domWindow.__ac.playerModel as THREE.Group;
    setCellLighting(pm, true, true);
    const worldKinds: (string | undefined)[] = [];
    pm.traverse((o) => { if ((o as THREE.Mesh).isMesh) worldKinds.push(retailLightingKindOf((o as THREE.Mesh).material as THREE.Material)); });
    expect(worldKinds).toEqual(['cellobject']); // the world pass: sun compiled out
    try {
      renders.length = 0;
      ui.renderPaperdollToElement(domWindow.document.createElement('div'), W, H);
      expect(renders.length).toBe(1);
      // The clone drew with the landscape-pass (`object`) material, which has the DISTANT_LIGHT term …
      expect(renders[0].kinds).toEqual(['object']);
      // … and the live model kept its cell pass.
      const after: (string | undefined)[] = [];
      pm.traverse((o) => { if ((o as THREE.Mesh).isMesh) after.push(retailLightingKindOf((o as THREE.Mesh).material as THREE.Material)); });
      expect(after).toEqual(['cellobject']);
    } finally {
      setCellLighting(pm, false, true);
    }
  });

  it('gmPaperDollUI::PostInit light: DISTANT 2.0 travelling along AC (0.3, 1.9, 0.65) from the camera side; ambient exactly 0.3 after the object ambient scale', () => {
    renders.length = 0;
    ui.renderPaperdollToElement(domWindow.document.createElement('div'), W, H);
    const r = renders[0];
    expect(PAPERDOLL_LIGHT_DIRECTION).toEqual([0.3, 1.9, 0.65]);
    expect(r.dirIntensity).toBe(PAPERDOLL_DISTANT_LIGHT);
    const want = distantLightPosition(PAPERDOLL_LIGHT_DIRECTION);
    const travel = r.dirTarget!.clone().sub(r.dirPos!).normalize();
    expect(travel.x).toBeCloseTo(-want[0], 6);
    expect(travel.y).toBeCloseTo(-want[1], 6);
    expect(travel.z).toBeCloseTo(-want[2], 6);
    expect(r.dirPos!.z).toBeLessThan(0); // the camera's side (three z = AC y; the camera is at −2.4)
    expect(r.ambient * currentObjectAmbientScale()).toBeCloseTo(PAPERDOLL_AMBIENT, 9);
    // The front of the figure (toward its nose) is what the light hits.
    const fig = figureIn(r.figure);
    const front = markerWorld(fig, 'nose').sub(markerWorld(fig, 'backOfHead')).normalize();
    expect(front.dot(travel)).toBeLessThan(0);
  });

  it('the examine portrait switches an indoor creature\'s clone to the landscape pass too', () => {
    renders.length = 0;
    const canvas = domWindow.document.createElement('canvas');
    canvas.width = 120; canvas.height = 140;
    const fig = syntheticFigure();
    fig.add(litBody());
    setCellLighting(fig, true, true);
    ui.renderExaminePreview(canvas, fig);
    expect(renders[0].kinds).toEqual(['object']);
  });
});
