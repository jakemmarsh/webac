/**
 * BUG.chargen-preview-blank: a player on Seedsow (Classic Dereth 1.0,
 * playwebac.com, 2026-10-13) saw the chargen Appearance page's 3D view
 * completely black while the rest of the page drew.
 *
 * The offscreen views (chargen appearance / summary, barber, paperdoll,
 * examine) are one-shot renders through the shared WebGL renderer into 2D
 * canvases. They are redrawn only when their page changes, so:
 *  - a render while the context is lost must not overwrite the canvas with
 *    the zeros a lost context reads back;
 *  - when the context is restored, the open views must redraw (the world loop
 *    redraws itself; these views stayed blank until the next click).
 *
 * The streamed-DAT half: on a streamed set the chargen figure's files arrive
 * over several miss → arrival → repaint rounds (Setup, then GfxObjs, then
 * surfaces, textures, palettes). The real GameUI page must converge to the
 * whole-DAT figure through that chain. The chargen closure is the same in the
 * classic and end-of-retail sets, so one portal covers every era here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { renderSceneToCanvas, rendererContextLost } from '../packages/renderer/src/ui/CreatureViewRender.js';
import { installMirrorAwareCulling, mirrorCameraX, type MirrorCullingRenderer } from '../packages/renderer/src/scene/WorldMirror.js';
import { noteDatMiss } from '../packages/dat-parser/src/streaming/DatMiss.js';
import { scriptedRandomSource } from '../packages/renderer/src/ui/ChargenRandomize.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';

/** A WebGLRenderer double: records each draw's mesh count; `lost` drives isContextLost. */
function fakeRenderer(state: { lost: boolean; draws: number[] }, domElement: unknown = null) {
  return {
    domElement,
    getContext: () => ({ isContextLost: () => state.lost }),
    getRenderTarget: () => null, getClearAlpha: () => 1, setClearAlpha() {}, setRenderTarget() {}, clear() {},
    readRenderTargetPixels(_t: unknown, _x: number, _y: number, w: number, h: number, out: Uint8Array) {
      // A live context: an opaque white frame.
      if (!state.lost) out.fill(255, 0, w * h * 4);
    },
    render(scene: THREE.Object3D) {
      let n = 0;
      scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) n++; });
      state.draws.push(n);
    },
  };
}

/** A 2D canvas double that keeps what was put into it. */
function fakeCanvas(w = 4, h = 4) {
  const put: Uint8ClampedArray[] = [];
  return {
    width: w, height: h, put,
    getContext: () => ({
      createImageData: (iw: number, ih: number) => ({ data: new Uint8ClampedArray(iw * ih * 4) }),
      putImageData: (img: { data: Uint8ClampedArray }) => { put.push(img.data); },
    }),
  };
}

describe('renderSceneToCanvas and a lost WebGL context', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  const camera = new THREE.PerspectiveCamera();

  it('a live context draws and copies the frame into the canvas', () => {
    const state = { lost: false, draws: [] as number[] };
    const canvas = fakeCanvas();
    const drawn = renderSceneToCanvas(fakeRenderer(state) as never, scene, camera, canvas as never);
    expect(drawn).toBe(true);
    expect(state.draws).toEqual([1]);
    expect(canvas.put).toHaveLength(1);
    expect(canvas.put[0][3]).toBe(255);
  });

  it('a lost context neither draws nor overwrites the canvas', () => {
    const state = { lost: true, draws: [] as number[] };
    const canvas = fakeCanvas();
    expect(renderSceneToCanvas(fakeRenderer(state) as never, scene, camera, canvas as never)).toBe(false);
    expect(state.draws).toEqual([]);
    expect(canvas.put).toHaveLength(0);
  });

  it('rendererContextLost is false for a renderer without a context query', () => {
    expect(rendererContextLost({ getContext: () => ({}) } as never)).toBe(false);
    expect(rendererContextLost({ getContext: () => { throw new Error('gone'); } } as never)).toBe(false);
  });
});

describe('mirror-aware culling survives a WebGL context restore', () => {
  it('the new WebGLState initGLContext makes is patched too, so mirrored draws keep their front faces', () => {
    const seen: Array<[string, boolean]> = [];
    const makeState = (name: string) => ({ setMaterial: (_m: THREE.Material, cw: boolean) => { seen.push([name, cw]); } });
    // three: renderBufferDirect → state.setMaterial(material, determinant < 0); a restore replaces renderer.state.
    const fake: MirrorCullingRenderer = {
      state: makeState('before'),
      renderBufferDirect(_c, _s, _g, material, object) {
        this.state.setMaterial(material, object.matrixWorld.determinant() < 0);
      },
    };
    installMirrorAwareCulling(fake);
    const mirrored = mirrorCameraX(new THREE.PerspectiveCamera());
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    const m = mesh.material as THREE.Material;
    fake.renderBufferDirect(mirrored, null, mesh.geometry, m, mesh, null);
    fake.state = makeState('after'); // WebGLRenderer.onContextRestore → initGLContext
    fake.renderBufferDirect(mirrored, null, mesh.geometry, m, mesh, null);
    fake.renderBufferDirect(new THREE.PerspectiveCamera(), null, mesh.geometry, m, mesh, null);
    expect(seen).toEqual([['before', true], ['after', true], ['after', false]]);
  });
});

describe('GameUI redraws its offscreen views when the context is restored', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H?.teardown());

  it('the appearance preview, the summary view and the examine figure redraw on webglcontextrestored', () => {
    const ui = H.ui;
    const glCanvas = H.win.document.createElement('canvas');
    const state = { lost: false, draws: [] as number[] };
    const figure = new THREE.Group();
    figure.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    const builds: number[] = [];
    ui.setUIHost({
      renderer: fakeRenderer(state, glCanvas),
      characterModelBuilder: { buildCharacterModel: () => { builds.push(1); return figure.clone(); }, getChargenClothingColors: () => null },
      appearanceManager: { loadPaletteColors: () => null, loadPaletteSet: () => null },
    });
    ui.chargenRandomSource = scriptedRandomSource([0], [0]);
    ui.showCharacterCreate();
    ui.wizard.currentStep = 3; // Appearance
    // The page opens while the context is lost: nothing is drawn.
    state.lost = true;
    ui.renderCharacterCreate();
    expect(H.container.querySelector('.chargen-preview-canvas')).not.toBeNull();
    expect(state.draws).toEqual([]);
    // THREE restores the context: the open preview draws without a click.
    state.lost = false;
    glCanvas.dispatchEvent(new H.win.Event('webglcontextrestored'));
    expect(state.draws).toHaveLength(1);
    expect(state.draws[0]).toBeGreaterThan(0);

    // The summary page's view does the same.
    ui.wizard.currentStep = 5;
    ui.renderCharacterCreate();
    if (H.container.querySelector('.chargen-summary-canvas')) {
      const before = state.draws.length;
      glCanvas.dispatchEvent(new H.win.Event('webglcontextrestored'));
      expect(state.draws.length).toBe(before + 1);
    }

    // The examine viewport's figure, drawn while the context was lost, redraws too.
    const examineCanvas = H.win.document.createElement('canvas');
    examineCanvas.width = 8; examineCanvas.height = 8;
    H.container.appendChild(examineCanvas);
    state.lost = true;
    ui.renderExaminePreview(examineCanvas, figure);
    state.lost = false;
    const before = state.draws.length;
    glCanvas.dispatchEvent(new H.win.Event('webglcontextrestored'));
    expect(state.draws.length).toBeGreaterThan(before);
  });

  it('a new renderer canvas moves the listener (the old canvas no longer redraws)', () => {
    const ui = H.ui;
    const a = H.win.document.createElement('canvas');
    const b = H.win.document.createElement('canvas');
    const state = { lost: false, draws: [] as number[] };
    let redraws = 0;
    const real = ui.redrawRendererViews.bind(ui);
    ui.redrawRendererViews = () => { redraws++; real(); };
    ui.setUIHost({ renderer: fakeRenderer(state, a) });
    ui.setUIHost({ renderer: fakeRenderer(state, b) });
    a.dispatchEvent(new H.win.Event('webglcontextrestored'));
    expect(redraws).toBe(0);
    b.dispatchEvent(new H.win.Event('webglcontextrestored'));
    expect(redraws).toBe(1);
    delete ui.redrawRendererViews;
  });
});

const hasPortal = existsSync(DAT_PATHS.portal);

describe.skipIf(!hasPortal)('GameUI chargen preview converges through streamed misses (real builders)', () => {
  let H: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let real: any;
  beforeAll(async () => {
    H = await mountGameUI();
    real = openDat(DAT_PATHS.portal);
  });
  afterAll(() => H?.teardown());

  it('each arrival repaints the open preview until the whole figure draws, textured', async () => {
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { ClothingRenderer } = await import('../packages/renderer/src/models/ClothingRenderer.js');
    const { AppearanceManager } = await import('../packages/renderer/src/models/AppearanceManager.js');
    const { CharacterModelBuilder } = await import('../packages/renderer/src/models/CharacterModelBuilder.js');
    // A streamed portal: a file not resident yet reads null and records a miss (DatStore.noteMiss).
    const resident = new Set<number>([0x0e000002]);
    const missed = new Set<number>();
    const db = new Proxy(real, {
      get(t, k) {
        if (k === 'getFileData') {
          return (id: number) => {
            id >>>= 0;
            if (!resident.has(id) && t.hasFile(id)) { missed.add(id); noteDatMiss(); return null; }
            return t.getFileData(id);
          };
        }
        const v = t[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const tm = new TextureManager(db); const mf = new MaterialFactory(db, tm); const mr = new ModelRenderer(db, mf);
    const smr = new SetupModelRenderer(db, mr); const cr = new ClothingRenderer(db, smr, mr, mf); const am = new AppearanceManager(db);
    const builder = new CharacterModelBuilder(db, smr, cr, am);
    const textured: number[] = [];
    const state = { lost: false, draws: [] as number[] };
    const renderer = fakeRenderer(state);
    const baseRender = renderer.render;
    renderer.render = (scene: THREE.Object3D) => {
      baseRender(scene);
      let n = 0;
      scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
        if ((o as THREE.Mesh).isMesh && m?.map) n++;
      });
      textured.push(n);
    };
    const ui = H.ui;
    ui.portalDb = db;
    ui.loadCharGenAsset();
    ui.setUIHost({ renderer, characterModelBuilder: builder, appearanceManager: am });
    ui.chargenRandomSource = scriptedRandomSource([0], [0]);
    ui.showCharacterCreate();
    ui.wizard.heritage = 1; ui.wizard.gender = 1;
    ui.wizard.currentStep = 3;
    missed.clear();
    ui.renderCharacterCreate();
    let rounds = 0;
    while (missed.size > 0 && rounds < 15) {
      expect(ui.chargenMissedDats).toBe(true);
      for (const id of missed) resident.add(id);
      missed.clear();
      // The DatMiss arrival listener (GameUI's onDatMissResolved hook).
      ui.onStreamedFilesArrived();
      rounds++;
    }
    expect(missed.size).toBe(0);
    expect(rounds).toBeGreaterThan(1);
    const meshes = state.draws[state.draws.length - 1];
    expect(meshes).toBeGreaterThan(20);
    expect(textured[textured.length - 1]).toBe(meshes);
  }, 60_000);
});
