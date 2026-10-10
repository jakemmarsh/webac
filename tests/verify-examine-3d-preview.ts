/**
 * GAP.24 — the examine window shows a 3D model of a person/monster; items
 * don't get one.
 *
 * Era ground truth (ToD-era patch note, quoted on the AC wiki /
 * Drunkapedia User_Interface page): "You now see a 3D model of any
 * person or monster, instead of a small icon, when you view them in the
 * Examine Target Panel."
 *
 * Now drives the REAL GameUI.showExaminationWindow in happy-dom with a stub
 * layoutRenderer. In the EoL window (layout 0x2100006b) the model is drawn
 * into the creature/character page's UIElement_Viewport 0x10000148
 * (BasicCreatureExamineUI::Init @ 004ab9c0), which shares the stat list's
 * 300x265 rect; the canvas takes the viewport element's DAT size. The item
 * page 0x1000012e has no viewport, so an item examine never gets a canvas.
 * The GL render itself no-ops without the shared WebGL renderer; the DOM
 * contract (canvas inside the viewport, sized to it) is what's pinned.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as THREE from 'three';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { EXAMINATION_WINDOW, type ExaminationView } from '../packages/renderer/src/ui/examine/ExaminationWindow.js';
import { buildCreaturePage, CREATURE_EXAMINE_ELEMENTS } from '../packages/renderer/src/ui/examine/CreatureAppraisalText.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';

class NoopObserver { observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; } }

/** Viewport 0x10000148's rect in layout 0x2100006b (same as the stat list 0x10000149). */
const VIEWPORT = { width: 300, height: 265 };
const PAGE_ELEMENTS = [
  EXAMINATION_WINDOW.pages.item, EXAMINATION_WINDOW.pages.creature, EXAMINATION_WINDOW.pages.spell,
  EXAMINATION_WINDOW.item.body, EXAMINATION_WINDOW.item.scrollbar, EXAMINATION_WINDOW.item.inscription, EXAMINATION_WINDOW.item.signature,
  CREATURE_EXAMINE_ELEMENTS.statList, CREATURE_EXAMINE_ELEMENTS.miscInfoList,
];

describe('GAP.24 — examine window 3D model viewport (real showExaminationWindow)', () => {
  let H: GameUIFixture;
  const g = globalThis as Record<string, unknown>;
  const savedObs: Record<string, unknown> = {};

  beforeAll(async () => {
    for (const k of ['MutationObserver', 'ResizeObserver']) { savedObs[k] = g[k]; g[k] ??= NoopObserver; }
    H = await mountGameUI({ size: { innerWidth: 1600, innerHeight: 900 } });
    const doc = H.win.document;
    const handleFor = (_layout: number, parent: HTMLElement) => {
      const wrapper = doc.createElement('div');
      const root = doc.createElement('div');
      wrapper.appendChild(root); parent.appendChild(wrapper);
      const elements = new Map<number, HTMLElement>();
      const ids = [...PAGE_ELEMENTS, CREATURE_EXAMINE_ELEMENTS.paperDoll];
      for (const id of ids) { const d = doc.createElement('div'); d.dataset.el = id.toString(16); root.appendChild(d); elements.set(id, d); }
      return {
        root, layout: {}, elements,
        descs: new Map<number, { width: number; height: number }>([[CREATURE_EXAMINE_ELEMENTS.paperDoll, VIEWPORT], [EXAMINATION_WINDOW.item.body, { width: 280, height: 286 }]]),
        setText() {}, setVisible() {}, setFill() {}, setState() {}, setPalette() {}, setInteractive() {},
        setScrollable() { return {}; }, setDraggable() {}, setDropTarget() {},
        close: () => { wrapper.remove(); },
      };
    };
    H.ui.layoutRenderer = { renderPanel: handleFor, render: handleFor };
  }, 60_000);
  afterAll(() => {
    H?.teardown();
    for (const k of ['MutationObserver', 'ResizeObserver']) { if (savedObs[k] === undefined) delete g[k]; else g[k] = savedObs[k]; }
  });
  beforeEach(() => { H.ui.hideExaminePanel(); });

  const drudge: IdentifyResponseData = {
    guid: 0x8000abcd, flags: 0,
    propertiesInt: new Map([[25, 8], [2, 3]]),
    creatureProfile: { profileFlags: 0, health: 40, healthMax: 40 },
  };
  const creatureView = (previewMesh: THREE.Group | null | undefined): ExaminationView => ({
    guid: drudge.guid, title: 'Drudge Prowler', page: 'creature', creature: buildCreaturePage(drudge, { success: true }),
    ...(previewMesh !== undefined ? { previewMesh } : {}),
  });
  const viewportEl = (): HTMLElement | null => H.ui.examinePanelHandle?.elements.get(CREATURE_EXAMINE_ELEMENTS.paperDoll) ?? null;

  it('creature examine with a model draws a canvas into viewport 0x10000148, sized to its DAT rect', () => {
    H.ui.showExaminationWindow(creatureView(new THREE.Group()));
    const canvases = (H.ui.examinePanel as HTMLElement).querySelectorAll('canvas.ac-examine-preview');
    expect(canvases.length).toBe(1);
    const canvas = canvases[0] as HTMLCanvasElement;
    expect(canvas.parentElement).toBe(viewportEl());
    expect([canvas.width, canvas.height]).toEqual([VIEWPORT.width, VIEWPORT.height]);
    expect(canvas.style.width).toBe(`${VIEWPORT.width}px`);
    expect(canvas.style.height).toBe(`${VIEWPORT.height}px`);
    expect((H.ui.examinePanel as HTMLElement).querySelector('img')).toBeNull();
  });

  it('item examine never draws a model canvas', () => {
    const item = buildItemAppraisalText({ guid: 0x8000abce, flags: 0, propertiesInt: new Map([[19, 250], [5, 10]]) });
    H.ui.showExaminationWindow({ guid: 0x8000abce, title: 'Rusted Dirk', page: 'item', item, previewMesh: new THREE.Group() });
    expect((H.ui.examinePanel as HTMLElement).querySelector('canvas.ac-examine-preview')).toBeNull();
    expect((H.ui.examinePanel as HTMLElement).querySelector('[data-examine-body]')!.textContent).toContain('Value: 250');
  });

  it('previewMesh null or omitted draws no canvas', () => {
    H.ui.showExaminationWindow(creatureView(null));
    expect((H.ui.examinePanel as HTMLElement).querySelector('canvas.ac-examine-preview')).toBeNull();
    H.ui.showExaminationWindow(creatureView(undefined));
    expect((H.ui.examinePanel as HTMLElement).querySelector('canvas.ac-examine-preview')).toBeNull();
  });

  it('a re-examine replaces the window, leaving exactly one canvas', () => {
    H.ui.showExaminationWindow(creatureView(new THREE.Group()));
    H.ui.showExaminationWindow(creatureView(new THREE.Group()));
    expect(H.win.document.querySelectorAll('canvas.ac-examine-preview').length).toBe(1);
  });
});
