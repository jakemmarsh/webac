/**
 * Loaders that cache by DAT id must not keep a "missing" result built from a
 * streamed file that wasn't resident yet (the stream-miss sweep, 2026-10-06):
 * the next use reads again and finds it. A file that is genuinely absent
 * (no miss recorded) is still cached as absent.
 *   - PaperdollPoser: else the paperdoll shows the live pose all session;
 *   - ExamineFigurePoser: else every examine of that creature shows its live pose;
 *   - GameUI.paperdollClickMap: else drops onto the paperdoll do nothing all session.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { noteDatMiss } from '../packages/dat-parser/src/streaming/DatMiss.js';
import { PaperdollPoser } from '../packages/renderer/src/ui/ChargenViewAnimation.js';
import { ExamineFigurePoser } from '../packages/renderer/src/ui/ExamineFigurePose.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';

/** A DatDatabase stand-in: every read is absent; `streamingMiss` makes it a streamed miss (noteDatMiss), as DatStore does. */
function fakeDb(state: { streamingMiss: boolean; reads: number[] }) {
  return {
    masterMapId: 0,
    getFileData(id: number) { state.reads.push(id); if (state.streamingMiss) noteDatMiss(); return null; },
    hasFile() { return true; },
  } as never;
}

describe('posers don\'t cache a streamed miss', () => {
  it('PaperdollPoser reads the doll animation again after a miss; a real absence is cached', () => {
    const state = { streamingMiss: true, reads: [] as number[] };
    const poser = new PaperdollPoser(fakeDb(state));
    const did = poser.animationDid(1);
    expect(did).not.toBe(0);
    poser.pose(new THREE.Group(), 1);
    poser.pose(new THREE.Group(), 1);
    expect(state.reads.filter((r) => r === did)).toHaveLength(2); // retried
    state.streamingMiss = false;
    poser.pose(new THREE.Group(), 1);
    poser.pose(new THREE.Group(), 1);
    expect(state.reads.filter((r) => r === did)).toHaveLength(3); // absent for real: cached after one read
  });

  it('ExamineFigurePoser reads the motion table again after a miss; a real absence is cached', () => {
    const state = { streamingMiss: true, reads: [] as number[] };
    const poser = new ExamineFigurePoser(fakeDb(state));
    poser.pose(new THREE.Group(), 0x09000001);
    poser.pose(new THREE.Group(), 0x09000001);
    expect(state.reads.filter((r) => r === 0x09000001)).toHaveLength(2);
    state.streamingMiss = false;
    poser.pose(new THREE.Group(), 0x09000001);
    poser.pose(new THREE.Group(), 0x09000001);
    expect(state.reads.filter((r) => r === 0x09000001)).toHaveLength(3);
  });
});

const hasPortal = existsSync(DAT_PATHS.portal);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

describe.skipIf(!hasPortal)('GameUI.paperdollClickMap retries after a streamed miss', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any; let portal: unknown;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (typeof g.requestAnimationFrame !== 'function') { g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {}; }
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
    portal = openDat(DAT_PATHS.portal);
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('a missed hit-test texture is fetched again on the next use, then kept', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    ui.portalDb = portal;
    const img = { width: 1, height: 1, data: new Uint8Array(4) };
    let calls = 0; let resident = false;
    ui.textureManager = { getIconRGBA: () => { calls++; if (!resident) { noteDatMiss(); return null; } return img; } };
    expect(ui.paperdollClickMap()).toBeNull();
    expect(ui.paperdollClickMap()).toBeNull();
    expect(calls).toBe(2); // retried, not cached as missing
    resident = true;
    expect(ui.paperdollClickMap()).toBe(img);
    expect(ui.paperdollClickMap()).toBe(img);
    expect(calls).toBe(3); // kept once it loaded
  });
});

describe('barber preview rebuilds once a missed file lands', () => {
  it('a model built across a streamed miss is rebuilt and redrawn on arrival; a clean build is reused', async () => {
    const { barberPreviewRenderer } = await import('../packages/renderer/src/ui/BarberPanel.js');
    const { noteDatMissResolved, DAT_ARRIVAL_COALESCE_MS } = await import('../packages/dat-parser/src/streaming/DatMiss.js');
    let builds = 0; let missing = true; let renders = 0;
    const host = {
      characterModelBuilder: { buildCharacterModel: () => { builds++; if (missing) noteDatMiss(); return new THREE.Group(); } },
      renderer: {
        getRenderTarget: () => null, getClearAlpha: () => 1, setClearAlpha() {}, setRenderTarget() {}, clear() {},
        render() { renders++; }, readRenderTargetPixels() {},
      },
    } as never;
    const canvas = { width: 2, height: 2, isConnected: true, getContext: () => null } as unknown as HTMLCanvasElement;
    const model = { viewRevision: 1, view: { heading: 0 }, heritage: 1, gender: 1, appearanceInfo: () => ({}), previewSetupId: 0, camera: [0, -0.65, 1.7] } as never;
    const draw = barberPreviewRenderer(host);
    draw(canvas, model);
    expect(builds).toBe(1);
    missing = false;
    noteDatMissResolved();
    await new Promise((r) => setTimeout(r, DAT_ARRIVAL_COALESCE_MS + 30));
    expect(builds).toBe(2); // rebuilt on arrival
    expect(renders).toBe(2); // and redrawn without the panel asking
    draw(canvas, model);
    expect(builds).toBe(2); // clean build reused
  });
});
