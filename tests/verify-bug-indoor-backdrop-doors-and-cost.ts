/**
 * BUG.indoor-backdrop-doors-and-cost — player report 2026-10-21 (Firefox,
 * Windows): "Walking into buildings now, you get some really hitchy/loading
 * lag as you move until you get back outside. When inside, you can't see
 * outside either. Doorways turn into white blocks."
 *
 * The indoor view (scene/IndoorView.ts, a1a5eb85d) draws PView::DrawCells'
 * order: the landscape backdrop, Clear(4) = D3DCLEAR_ZBUFFER (depth only),
 * then the viewer's cells. Two three.js behaviours broke it:
 *  (a)(b) a THREE.Color scene.background makes WebGLBackground.render force
 *     a full colour + depth + stencil clear on EVERY render() call, autoClear
 *     or not, so the cell pass wiped the backdrop: through a doorway the sky
 *     colour (pale by day, navy at night) instead of the landscape and the
 *     door;
 *  (c) each pass hid the other pass's subtrees, and with them the DAT pool
 *     lights under them (env cell stabs inside, lamp posts outside): the two
 *     passes saw different numPointLights, so three bumped its lights state
 *     twice a frame and re-resolved (and, for each new count, compiled) every
 *     lit material's program in both passes.
 *
 * Driven through a real THREE.WebGLRenderer on a recording stub context
 * (tests/_harness/stubGl.ts): three's own clear / program logic decides.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { indoorPassOf, renderIndoorView, type IndoorViewContext } from '../packages/renderer/src/scene/IndoorView.js';
import { DatLightBudget } from '../packages/renderer/src/effects/DatLightBudget.js';
import { createStubRenderer, GL_COLOR_BUFFER_BIT, GL_DEPTH_BUFFER_BIT } from './_harness/stubGl.js';

/** Yaraq, Nuya bint Mulud the Grocer's shop (about 21.5S 1.6W): a 0x7D64 building cell and its PVS. */
const SHOP = 0x7d640105;
const ctx = (over: Partial<IndoorViewContext> = {}): IndoorViewContext => ({
  blockKey: 0x7d64,
  cells: new Set([0x105, 0x106]),
  playerCellId: SHOP,
  cellAt: () => 0,
  ...over,
});

/** A lit material that counts how often three re-resolves its program (getProgramCacheKey). */
function countingMaterial(): { material: THREE.MeshLambertMaterial; resolves: () => number } {
  const material = new THREE.MeshLambertMaterial();
  let n = 0;
  material.customProgramCacheKey = () => { n++; return 'counted'; };
  return { material, resolves: () => n };
}

function datLight(): THREE.PointLight {
  const pl = new THREE.PointLight(0xffc080, 1, 6, 1);
  pl.userData.datLight = true;
  return pl;
}

/**
 * The Yaraq shop scene: sky-coloured background (SkyboxRenderer rewrites the
 * linked Color), terrain, the building shell, the door (a server object in an
 * outdoor cell), a lamp post with a DAT light outside, the shop's cell with a
 * sconce light inside, and the sun / ambient / viewer light at the top level.
 */
function shopScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.85, 0.88, 0.95);
  const geo = new THREE.PlaneGeometry(1, 1);
  const terrainMat = countingMaterial();
  const doorMat = countingMaterial();
  const cellMat = countingMaterial();
  const terrain = new THREE.Mesh(geo, terrainMat.material);
  terrain.name = '';
  const door = new THREE.Mesh(geo, doorMat.material);
  door.name = 'server_7d64a001_Door';
  door.userData.objCellId = 0x7d640021; // the outdoor land cell in front of the shop
  const lampPost = new THREE.Group();
  lampPost.name = 'setup_02000a3e';
  lampPost.add(new THREE.Mesh(geo, terrainMat.material), datLight(), datLight());
  const cell = new THREE.Group();
  cell.name = 'envcell_7d640105';
  cell.userData.envCellId = SHOP;
  const sconce = new THREE.Group();
  sconce.add(new THREE.Mesh(geo, cellMat.material), datLight());
  cell.add(new THREE.Mesh(geo, cellMat.material), sconce);
  const sun = new THREE.DirectionalLight();
  const ambient = new THREE.AmbientLight();
  const viewer = new THREE.PointLight();
  scene.add(terrain, door, lampPost, cell, sun, ambient, viewer);
  for (const o of [terrain, door, cell]) o.position.set(0, 0, -5);
  return { scene, terrainMat, doorMat, cellMat, door, cell, lampPost };
}

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  cam.updateMatrixWorld();
  return cam;
}

describe('BUG.indoor-backdrop-doors-and-cost — the cell pass keeps the backdrop (real three.js renderer)', () => {
  it('an ordinary frame clears colour once (the baseline the indoor frame must match)', () => {
    const { renderer, stub } = createStubRenderer();
    const { scene } = shopScene();
    renderer.render(scene, camera());
    expect(stub.log.clears.filter((m) => (m & GL_COLOR_BUFFER_BIT) !== 0)).toHaveLength(1);
  });

  it('one indoor frame clears colour exactly once, before the backdrop; the cell pass clears depth only', () => {
    const { renderer, stub } = createStubRenderer();
    const { scene } = shopScene();
    const background = scene.background;
    renderIndoorView(renderer, scene, camera(), ctx());
    const colour = stub.log.clears.filter((m) => (m & GL_COLOR_BUFFER_BIT) !== 0);
    expect(colour).toHaveLength(1);
    expect(stub.log.clears[0] & GL_COLOR_BUFFER_BIT).not.toBe(0); // the backdrop pass's own clear
    // Clear(4): D3DCLEAR_ZBUFFER, nothing else after the backdrop.
    expect(stub.log.clears.slice(1)).toEqual([GL_DEPTH_BUFFER_BIT]);
    // The sky colour is the scene's again for the next frame (SkyboxRenderer keeps writing it).
    expect(scene.background).toBe(background);
    expect(renderer.autoClear).toBe(true);
  });

  it('the door (an outdoor object) draws in the backdrop with its own material, never wiped after', () => {
    const { renderer, stub } = createStubRenderer();
    const { scene, door, doorMat } = shopScene();
    const drawn: string[] = [];
    door.onBeforeRender = () => { drawn.push(stub.log.clears.length === 1 ? 'backdrop' : 'after-clear'); };
    renderIndoorView(renderer, scene, camera(), ctx());
    expect(drawn).toEqual(['backdrop']);
    expect(door.material).toBe(doorMat.material);
    // Nothing that clears colour runs after the door drew.
    expect(stub.log.clears.slice(1).some((m) => (m & GL_COLOR_BUFFER_BIT) !== 0)).toBe(false);
  });
});

describe('BUG.indoor-backdrop-doors-and-cost — frame counters cover both passes (WorldReporter draws)', () => {
  it('renderer.info counts the backdrop and the cell pass, and autoReset is back on after', () => {
    const { renderer, stub } = createStubRenderer();
    const { scene } = shopScene();
    renderIndoorView(renderer, scene, camera(), ctx());
    expect(renderer.info.render.calls).toBe(stub.log.draws);
    expect(stub.log.draws).toBeGreaterThanOrEqual(3); // terrain + door + lamp post, then the cell + sconce
    expect(renderer.info.autoReset).toBe(true);
  });
});

describe('BUG.indoor-backdrop-doors-and-cost — indoor frames re-resolve no programs (real three.js renderer)', () => {
  it('after the first frame no lit material re-resolves its program and no program is created or switched more than outdoors', () => {
    const outdoors = createStubRenderer();
    const o = shopScene();
    outdoors.renderer.render(o.scene, camera());
    outdoors.stub.reset();
    for (let i = 0; i < 5; i++) outdoors.renderer.render(o.scene, camera());
    const outdoorSwitchesPerFrame = outdoors.stub.log.programSwitches / 5;

    const indoors = createStubRenderer();
    const s = shopScene();
    renderIndoorView(indoors.renderer, s.scene, camera(), ctx());
    const firstFrame = [s.terrainMat.resolves(), s.doorMat.resolves(), s.cellMat.resolves()];
    indoors.stub.reset();
    for (let i = 0; i < 5; i++) renderIndoorView(indoors.renderer, s.scene, camera(), ctx());
    expect([s.terrainMat.resolves(), s.doorMat.resolves(), s.cellMat.resolves()]).toEqual(firstFrame);
    expect(indoors.stub.log.programsCreated).toBe(0);
    // Two passes bind at most one program more each than the single pass (the pass boundary).
    expect(indoors.stub.log.programSwitches / 5).toBeLessThanOrEqual(outdoorSwitchesPerFrame + 1);
  });

  it('both passes see the same point-light count as an ordinary frame (programs are the outdoor variants)', () => {
    const { renderer } = createStubRenderer();
    const s = shopScene();
    const counts: number[] = [];
    const count = () => {
      let n = 0;
      s.scene.traverseVisible((x) => { if ((x as THREE.PointLight).isPointLight) n++; });
      return n;
    };
    const single = count();
    const realRender = renderer.render.bind(renderer);
    renderer.render = (scene: THREE.Object3D, cam: THREE.Camera) => { counts.push(count()); realRender(scene, cam); };
    renderIndoorView(renderer, s.scene, camera(), ctx());
    expect(counts).toEqual([single, single]);
    // The padding lights are hidden again between frames (DatLightBudget counts what stays visible).
    expect(count()).toBe(single);
  });

  it('padding lights add nothing: zero intensity, never pooled by DatLightBudget, hidden between frames and reused', () => {
    const { renderer } = createStubRenderer();
    const s = shopScene();
    renderIndoorView(renderer, s.scene, camera(), ctx());
    const pads = s.scene.children.filter((c) => c.userData.indoorViewPad);
    expect(pads.length).toBeGreaterThan(0);
    for (const p of pads) {
      expect((p as THREE.PointLight).intensity).toBe(0);
      expect(p.userData.datLightFiller).toBe(true);
      expect(p.visible).toBe(false);
    }
    // A second frame reuses them.
    renderIndoorView(renderer, s.scene, camera(), ctx());
    expect(s.scene.children.filter((c) => c.userData.indoorViewPad)).toHaveLength(pads.length);
  });

  it('DatLightBudget (fixed count) neither pools the pads nor counts them as external lights', () => {
    const { renderer } = createStubRenderer();
    const s = shopScene();
    const budget = new DatLightBudget(s.scene, { fixedLightCount: true });
    budget.update(new THREE.Vector3(0, 0, 0), 0);
    const before = { pooled: budget.lightCount, external: budget.externalCount, fillers: budget.fillerCount };
    renderIndoorView(renderer, s.scene, camera(), ctx());
    budget.update(new THREE.Vector3(0, 0, 0), DatLightBudget.REFRESH_MS + 1); // re-gathers the scene
    expect({ pooled: budget.lightCount, external: budget.externalCount, fillers: budget.fillerCount }).toEqual(before);
  });
});

describe('BUG.indoor-backdrop-doors-and-cost — a cell group sorts by its tagged id', () => {
  it('EnvCellRenderer.createCellMesh\'s userData.envCellId decides the pass; the name is the fallback', () => {
    const g = new THREE.Group();
    g.name = 'envcell_7d640105';
    g.userData.envCellId = 0x7d640110; // another building's cell in the same block
    expect(indoorPassOf(g, ctx())).toBe('outside');
    g.userData.envCellId = SHOP;
    expect(indoorPassOf(g, ctx())).toBe('inside');
    delete g.userData.envCellId;
    expect(indoorPassOf(g, ctx())).toBe('inside');
  });
});

describe('BUG.indoor-backdrop-doors-and-cost — all three eras share the path', () => {
  // End of retail: Yaraq's grocer (0x7D64, above). Dark Majesty: the Holtburg
  // portal hut's room under the landscape (0xA9B4 0x185-0x189, building
  // 0x010011C0). AC1999: a Holtburg cottage cell (same 0xA9B4 block, its
  // 1999 cell.dat). The pass structure depends only on the viewer's cell, so
  // each era's cell must keep the backdrop and the outdoor program variants.
  const eras: { era: string; c: IndoorViewContext; cellName: string }[] = [
    { era: 'end of retail (Yaraq grocer)', c: ctx(), cellName: 'envcell_7d640105' },
    {
      era: 'Dark Majesty (Holtburg portal bunker)',
      c: { blockKey: 0xa9b4, cells: new Set([0x185, 0x186, 0x187, 0x188, 0x189]), playerCellId: 0xa9b40187, cellAt: () => 0 },
      cellName: 'envcell_a9b40185',
    },
    {
      era: 'AC1999 (Holtburg cottage)',
      c: { blockKey: 0xa9b4, cells: new Set([0x120, 0x121]), playerCellId: 0xa9b40120, cellAt: () => 0 },
      cellName: 'envcell_a9b40120',
    },
  ];
  for (const { era, c, cellName } of eras) {
    it(`${era}: one colour clear per frame, the cell drawn after the depth clear, no program churn`, () => {
      const { renderer, stub } = createStubRenderer();
      const s = shopScene();
      s.cell.name = cellName;
      s.cell.userData.envCellId = parseInt(cellName.slice('envcell_'.length), 16) >>> 0;
      const cellDrawn: number[] = [];
      (s.cell.children[0] as THREE.Mesh).onBeforeRender = () => { cellDrawn.push(stub.log.clears.length); };
      renderIndoorView(renderer, s.scene, camera(), c);
      expect(stub.log.clears.filter((m) => (m & GL_COLOR_BUFFER_BIT) !== 0)).toHaveLength(1);
      expect(cellDrawn).toEqual([2]); // after the backdrop's clear and the depth clear
      const before = s.cellMat.resolves() + s.terrainMat.resolves();
      stub.reset();
      renderIndoorView(renderer, s.scene, camera(), c);
      expect(s.cellMat.resolves() + s.terrainMat.resolves()).toBe(before);
      expect(stub.log.programsCreated).toBe(0);
    });
  }
});
