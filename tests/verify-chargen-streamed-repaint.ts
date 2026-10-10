/**
 * Character creation repaints when streamed DAT files it missed arrive
 * (GameUI.onStreamedFilesArrived). A classic era's own chargen models and
 * palettes aren't in the world packs (planned from end of retail's access),
 * so the Appearance preview built with nothing — Doctide showed an
 * untextured / missing head (2026-10-06). The real GameUI wrapper, flag and
 * repaint path run here with the real DatMiss module; only the page body
 * (renderCharacterCreatePage, which needs the DATs) is replaced.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { noteDatMiss } from '../packages/dat-parser/src/streaming/DatMiss.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

describe('chargen repaints after streamed files arrive', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (typeof g.requestAnimationFrame !== 'function') { g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {}; }
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  /** A GameUI whose chargen page draws a #chargen-root and misses a file while `missing` is set. */
  function makeUI() {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    const state = { paints: 0, missing: true };
    ui.renderCharacterCreatePage = () => {
      state.paints++;
      if (!domWindow.document.getElementById('chargen-root')) {
        const root = domWindow.document.createElement('div');
        root.id = 'chargen-root';
        domWindow.document.body.appendChild(root);
      }
      if (state.missing) noteDatMiss();
    };
    return { ui, state };
  }

  it('a render that missed is redone once the files land; one that didn\'t miss isn\'t', () => {
    const { ui, state } = makeUI();
    ui.renderCharacterCreate();
    expect(state.paints).toBe(1);
    state.missing = false; // the streamed files are resident now
    ui.onStreamedFilesArrived();
    expect(state.paints).toBe(2);
    ui.onStreamedFilesArrived(); // nothing missed since: no further repaint
    expect(state.paints).toBe(2);
  });

  it('a render that still misses stays pending for the next arrival', () => {
    const { ui, state } = makeUI();
    ui.renderCharacterCreate();
    ui.onStreamedFilesArrived(); // still missing: repaints and stays pending
    expect(state.paints).toBe(2);
    state.missing = false;
    ui.onStreamedFilesArrived();
    expect(state.paints).toBe(3);
  });

  it('the 3D preview\'s misses count too, and nothing repaints once chargen is closed', () => {
    const { ui, state } = makeUI();
    state.missing = false;
    ui.renderCharacterCreate();
    ui.renderChargenModelIntoCanvas = () => { noteDatMiss(); };
    ui.renderChargenModelInto(domWindow.document.createElement('canvas'), true, { position: [0, 0, 0], target: [0, 0, 1], fov: 30, yaw: 0 }, { view: 'appearance', idle: 0, key: 'k' });
    ui.onStreamedFilesArrived();
    expect(state.paints).toBe(2);
    ui.renderChargenModelInto(domWindow.document.createElement('canvas'), true, { position: [0, 0, 0], target: [0, 0, 1], fov: 30, yaw: 0 }, { view: 'appearance', idle: 0, key: 'k' });
    domWindow.document.getElementById('chargen-root').remove();
    ui.onStreamedFilesArrived();
    expect(state.paints).toBe(2);
  });
});
