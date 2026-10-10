/**
 * CORE.17.k.c.a.a.a — the spew strip (gmSpewBoxUI, layout 0x21000011) draws
 * BEHIND the floaty vitals plate, in retail as in ours.
 *
 * Ground truth (decompiled EoL client + acclient.exe + client_local_English.dat):
 *  - gmGamePlayUI::SetupChildren @ 004e9ec0 fetches the SmartBox UI (the 3D
 *    view) as child 0x1000049a of the gameplay screen 0x21000005 and the
 *    stacked / side-by-side vitals windows as its SIBLINGS 0x100005fa /
 *    0x100006d5 under the root 0x10000495.
 *  - 0x1000049a carries no zLevel of its own (incorporation flags 0x1e) and
 *    inherits 9999 from its base 0x2100000f:0x10000037 (flags 0x3e —
 *    StateDesc::Incorporate @ 0069cca0 copies zLevel only when the DERIVED
 *    desc's flag is set); the vitals roots 0x2100006c:0x100005f9 /
 *    0x21000075:0x100006d4 carry 0. The spew pane 0x10000046 sits inside the
 *    3D view at (0,20) 450x72, centred (edges L3/R3); the stacked plate is
 *    160x58 at the top centre — they overlap in y 20..58.
 *  - UIRegion::AddChild @ 006a0760 walks the sibling list from the tail and
 *    inserts the new child after the first node whose comparator returns
 *    >= 0; the comparator is vtable slot +0x38 of UIRegion (vftable @
 *    0x801718: slot 14 = 0069f000 = UIRegion::CompareZLevel, which returns
 *    -1 / 0 / 1 for this.z <, ==, > other.z) — the list is sorted
 *    DESCENDING by z, head = highest. UIRegion::DrawChildren @ 0069fca0
 *    walks head → tail calling slot +0x34 GetSurfaceBox then slot +0x3c
 *    DrawHere, so the highest-z child paints FIRST (furthest back).
 *    UIRegion::BringToFront @ 006a07f0 re-inserts a child only where its z
 *    still fits (a 9999 child can never pass a 0 sibling), so clicking the
 *    3D view never lifts it.
 *  → The 3D view and everything inside it — the spew rows included — paints
 *    under every floaty window; retail's vitals plate covers the strip rows
 *    it overlaps, exactly as the CORE.17.k.c.a.a frame showed ours doing.
 *
 * Ours: #hud-spew-box at ZLayer.HUD_SMARTBOX_STRIP (1) and #hud-vitals at
 * ZLayer.HUD_FLOATY_VITALS (10), siblings inside #game-hud.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZLayer } from '@ac/renderer/ui/ZIndexRegistry.js';
import {
  SPEW_BOX_TOP, SPEW_BOX_HEIGHT, SPEW_BOX_WIDTH, spewBoxLeft, SPEW_HOST_LAYOUT, SPEW_HOST_PANE,
} from '@ac/renderer/ui/SpewBoxModel.js';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import {
  parseLayoutDesc, resolveLayoutDesc, parseMasterProperty, setMasterPropertyTypes, IncorporationFlags,
} from '@ac/dat-parser/file-types/LayoutDesc.js';
import { openDat } from './_harness/dat.js';

const PORTAL_DAT = resolve('dat/client_portal.dat');
const LANG_DAT = resolve('dat/client_local_English.dat');
const HAS_DAT = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);

const GAMEPLAY_LAYOUT = 0x21000005;
const GAMEPLAY_ROOT = 0x10000495;
const SMARTBOX_UI = 0x1000049a;     // gmGamePlayUI::m_pSmartBoxUI
const SMARTBOX_BASE = 0x10000037;   // 0x2100000f's root, zLevel 9999
const STACKED_VITALS = 0x100005fa;  // gmGamePlayUI::m_pStackedVitals
const SIDE_VITALS = 0x100006d5;     // gmGamePlayUI::m_pSideBySideVitals

describe('CORE.17.k.c.a.a.a — z tiers: the 3D-view strip is the back-most HUD tier, the vitals plate above it', () => {
  it('HUD_SMARTBOX_STRIP sits above the canvas and below every other HUD tier', () => {
    expect(ZLayer.HUD_SMARTBOX_STRIP).toBeGreaterThan(ZLayer.GAME_CANVAS);
    expect(ZLayer.HUD_SMARTBOX_STRIP).toBeLessThan(ZLayer.HUD_FLOATY_VITALS);
    expect(ZLayer.HUD_SMARTBOX_STRIP).toBeLessThan(ZLayer.HUD_CHAT_BAND);
    expect(ZLayer.HUD_SMARTBOX_STRIP).toBeLessThan(ZLayer.HUD_COMBAT_BAR);
    expect(ZLayer.HUD_SMARTBOX_STRIP).toBeLessThan(ZLayer.HUD_TOOLBAR);
    expect(ZLayer.HUD_SMARTBOX_STRIP).toBeLessThan(ZLayer.PANEL_BASE);
  });

  it('HUD_FLOATY_VITALS stays below the panels and the tooltips', () => {
    expect(ZLayer.HUD_FLOATY_VITALS).toBeLessThan(ZLayer.PANEL_BASE);
    expect(ZLayer.HUD_FLOATY_VITALS).toBeLessThan(ZLayer.TOOLTIP);
  });
});

describe.skipIf(!HAS_DAT)('CORE.17.k.c.a.a.a — DAT premise: the 3D view inherits z 9999, the vitals carry 0, the strip and the plate overlap', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolved: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let view: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let langDb: any;

  beforeAll(() => {
    const portalDb = openDat(PORTAL_DAT);
    langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    const load = (id: number) => {
      const data = langDb.getFileData(id);
      return data ? parseLayoutDesc(new DatReader(data)) : null;
    };
    raw = load(GAMEPLAY_LAYOUT);
    resolved = resolveLayoutDesc(raw, load);
    view = load(SPEW_HOST_LAYOUT);
  });

  it('the SmartBox UI and both vitals windows are siblings under the gameplay root', () => {
    const root = raw.elements.get(GAMEPLAY_ROOT);
    expect(root).toBeTruthy();
    for (const id of [SMARTBOX_UI, STACKED_VITALS, SIDE_VITALS]) expect(root.children.has(id)).toBe(true);
  });

  it('raw: 0x1000049a carries no zLevel flag of its own; its base 0x2100000f:0x10000037 authors 9999', () => {
    const smart = raw.elements.get(GAMEPLAY_ROOT).children.get(SMARTBOX_UI);
    expect(smart.baseLayout).toBe(SPEW_HOST_LAYOUT);
    expect(smart.baseElement).toBe(SMARTBOX_BASE);
    expect(smart.incorporationFlags & IncorporationFlags.ZLevel).toBe(0);
    const base = view.elements.get(SMARTBOX_BASE);
    expect(base.incorporationFlags & IncorporationFlags.ZLevel).not.toBe(0);
    expect(base.zLevel).toBe(9999);
  });

  it('resolved: the 3D view is z 9999 — the unique maximum among the root\'s children; the vitals are z 0', () => {
    const root = resolved.elements.get(GAMEPLAY_ROOT);
    const z = (id: number) => root.children.get(id).zLevel;
    expect(z(SMARTBOX_UI)).toBe(9999);
    expect(z(STACKED_VITALS)).toBe(0);
    expect(z(SIDE_VITALS)).toBe(0);
    for (const [id, child] of root.children) {
      if (id !== SMARTBOX_UI) expect(child.zLevel, `0x${id.toString(16)}`).toBeLessThan(9999);
    }
  });

  it('the spew pane inside the 3D view overlaps the stacked plate: y 20..92 vs y 0..58, both centred', () => {
    const pane = view.elements.get(SMARTBOX_BASE).children.get(SPEW_HOST_PANE);
    expect([pane.x, pane.y, pane.width, pane.height]).toEqual([0, SPEW_BOX_TOP, SPEW_BOX_WIDTH, SPEW_BOX_HEIGHT]);
    expect([pane.leftEdge, pane.rightEdge]).toEqual([3, 3]);
    const root = resolved.elements.get(GAMEPLAY_ROOT);
    const plate = root.children.get(STACKED_VITALS);
    expect([plate.x, plate.y, plate.width, plate.height]).toEqual([0, 0, 160, 58]);
    expect([plate.leftEdge, plate.rightEdge]).toEqual([3, 3]);
    // Centred on the same 800-wide screen: the plate's x-span lies inside the pane's.
    const paneL = (800 - SPEW_BOX_WIDTH) / 2, plateL = (800 - 160) / 2;
    expect(plateL).toBeGreaterThan(paneL);
    expect(plateL + 160).toBeLessThan(paneL + SPEW_BOX_WIDTH);
    expect(plate.y + plate.height).toBeGreaterThan(pane.y); // 58 > 20: the first two rows are under the plate
  });
});

// ── Behavioural: GameUI's DOM stacking matches the retail paint order ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('CORE.17.k.c.a.a.a — GameUI: #hud-spew-box paints under #hud-vitals (happy-dom, real renderHUD)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stubLayoutRenderer(ui: any): void {
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div') as HTMLElement;
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const getOrCreate = (id: number): HTMLElement => {
        let el = elements.get(id);
        if (!el) { el = domWindow.document.createElement('div') as HTMLElement; root.appendChild(el); elements.set(id, el); }
        return el;
      };
      return {
        root,
        elements: { get: (id: number) => getOrCreate(id), set: () => {} },
        setText: () => {}, setInteractive: () => {}, setState: () => {},
        setVisible: () => {}, setFill: () => {}, setPalette: () => {},
        setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
        close: () => { root.remove(); }, destroy: () => { root.remove(); },
      };
    };
    ui.getTexURL = () => null;
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: () => null,
    };
  }

  function makeUI() {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    stubLayoutRenderer(ui);
    ui.showGame();
    const strip = container.querySelector('#hud-spew-box') as HTMLElement;
    const vitals = container.querySelector('#hud-vitals') as HTMLElement;
    return { ui, container, strip, vitals };
  }

  it('both are children of #game-hud (one stacking context) with the strip below the plate', () => {
    const { strip, vitals } = makeUI();
    expect(strip).toBeTruthy();
    expect(vitals).toBeTruthy();
    expect(strip.parentElement?.id).toBe('game-hud');
    expect(vitals.parentElement?.id).toBe('game-hud');
    expect(strip.style.zIndex).toBe(String(ZLayer.HUD_SMARTBOX_STRIP));
    expect(vitals.style.zIndex).toBe(String(ZLayer.HUD_FLOATY_VITALS));
    expect(Number(strip.style.zIndex)).toBeLessThan(Number(vitals.style.zIndex));
  });

  it('the DAT overlap is reproduced: strip (centred, 20, 450x72) under the plate (centred, 0, 160x58)', () => {
    const { ui, strip, vitals } = makeUI();
    const w = ui.hudLogicalWidth();
    expect(strip.style.top).toBe('20px');
    expect(strip.style.left).toBe(`${spewBoxLeft(w)}px`);
    expect(vitals.style.top).toMatch(/^0(px)?$/);
    expect(vitals.style.left).toBe(`${Math.round((w - 160) / 2)}px`);
    const stripL = spewBoxLeft(w), plateL = Math.round((w - 160) / 2);
    expect(plateL).toBeGreaterThan(stripL);
    expect(plateL + 160).toBeLessThan(stripL + SPEW_BOX_WIDTH);
    expect(58).toBeGreaterThan(20);
  });

  it('a notice does not lift the strip: the row lands in the same back-most box', () => {
    const { ui, strip, container } = makeUI();
    ui.displayErrorText('You can only move or use one item at a time');
    const row = container.querySelector('#hud-spew-box .spew-item') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.closest('#hud-spew-box')).toBe(strip);
    expect(strip.style.zIndex).toBe(String(ZLayer.HUD_SMARTBOX_STRIP));
    expect(row.style.zIndex ?? '').toBe('');
  });
});
