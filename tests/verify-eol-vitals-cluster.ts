/**
 * CORE.5.b — the EoL default vitals surface is the compact top-center
 * floaty cluster, not the classic full-width statusbar row.
 *
 * Decompiled-client ground truth (reference/client-eol):
 *   - gmGamePlayUI::SetupChildren @ 004e9ec0 builds the in-game screen from
 *     layout 0x21000005 and grabs m_pStackedVitals = child 0x100005fa and
 *     m_pSideBySideVitals = child 0x100006d5. No classic statusbar element
 *     (0x100000e2 / layout 0x21000013) exists anywhere in that layout.
 *   - gmFloatyVitalsUI (element class 0x1000004d, Register @ 004ced90)
 *     shows the stacked window when PlayerModule::SideBySideVitals
 *     (options_ bit 0x200000) is OFF (UpdateFromPlayerModule @ 004cf140);
 *     gmFloatySideVitalsUI (class 0x10000056) shows the side-by-side one
 *     when ON (@ 004d0810).
 *   - PlayerModule::PlayerModule @ 005d51f0 defaults options_ = 0x50c4a54a
 *     — bit-identical to ACE CharacterOptions1.Default (1355064650) — with
 *     the SideBySideVitals bit CLEAR: a fresh character sees the STACKED
 *     cluster.
 *   - Indicators live in their own 150x30 window (root-HUD child
 *     0x10000611, base layout 0x21000071, authored top-left).
 *
 * This suite asserts the DAT half of that ground truth against the real
 * language DAT, then drives the real GameUI + LayoutRenderer in happy-dom
 * and asserts the shipped DOM: stacked cluster by default (160x58,
 * top-center), side-by-side (460x26) when the option is on, no classic
 * statusbar, indicator strip at top-left.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import {
  parseLayoutDesc,
  parseMasterProperty,
  setMasterPropertyTypes,
  type ElementDesc,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { openDat } from './_harness/dat.js';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const LANG_DAT = resolve(ROOT, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);

function findElement(map: Map<number, ElementDesc>, id: number): ElementDesc | undefined {
  for (const el of map.values()) {
    if (el.elementId === id) return el;
    const found = findElement(el.children, id);
    if (found) return found;
  }
  return undefined;
}

describe.skipIf(!hasDats)('CORE.5.b: DAT ground truth — EoL gameplay HUD 0x21000005 vitals family', () => {
  let langDb: DatDatabase;
  let hudElements: Map<number, ElementDesc>;

  beforeAll(() => {
    const portalDb = openDat(PORTAL_DAT);
    langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    hudElements = parseLayoutDesc(langDb.getReader(0x21000005)).elements;
  });

  it('authors the stacked cluster 0x100005fa (base 0x2100006c, 160x58, centered top)', () => {
    const el = findElement(hudElements, 0x100005fa)!;
    expect(el).toBeDefined();
    expect(el.baseLayout).toBe(0x2100006c);
    expect(el.width).toBe(160);
    expect(el.height).toBe(58);
    // L3/T1/R3/B2 — UpdateForParentSizeChange mode 3 = centered on the
    // parent's horizontal midline, top-pinned.
    expect(el.leftEdge).toBe(3);
    expect(el.rightEdge).toBe(3);
    expect(el.topEdge).toBe(1);
  });

  it('authors the side-by-side cluster 0x100006d5 (base 0x21000075, 460x26, centered top)', () => {
    const el = findElement(hudElements, 0x100006d5)!;
    expect(el).toBeDefined();
    expect(el.baseLayout).toBe(0x21000075);
    expect(el.width).toBe(460);
    expect(el.height).toBe(26);
    expect(el.leftEdge).toBe(3);
    expect(el.rightEdge).toBe(3);
    expect(el.topEdge).toBe(1);
  });

  it('authors the indicator strip 0x10000611 (base 0x21000071, 150x30, top-left)', () => {
    const el = findElement(hudElements, 0x10000611)!;
    expect(el).toBeDefined();
    expect(el.baseLayout).toBe(0x21000071);
    expect(el.width).toBe(150);
    expect(el.height).toBe(30);
    expect(el.x).toBe(0);
    expect(el.y).toBe(0);
  });

  it('contains NO classic statusbar element (0x100000e2)', () => {
    expect(findElement(hudElements, 0x100000e2)).toBeUndefined();
  });

  // CORE.17.a/.b (2026-09-07): the gestalt audit re-filed the classic
  // full-width statusbar as retail. The check above only looks at
  // 0x21000005's OWN elements; every HUD child inherits a base layout
  // (baseElement/baseLayout), so the statusbar could in principle ride in
  // through a base — e.g. the smartbox child 0x1000049a → 0x2100000f. Walk
  // the whole inheritance closure and pin that it never does.
  function collectBaseLayouts(map: Map<number, ElementDesc>, out: Set<number>): void {
    for (const el of map.values()) {
      if (el.baseLayout) out.add(el.baseLayout);
      collectBaseLayouts(el.children, out);
    }
  }

  it('no layout reachable from 0x21000005 via base-layout inheritance carries the classic statusbar', () => {
    const visited = new Set<number>();
    const carriers: number[] = [];
    const queue = [0x21000005];
    while (queue.length) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const els = parseLayoutDesc(langDb.getReader(id)).elements;
      if (findElement(els, 0x100000e2)) carriers.push(id);
      const bases = new Set<number>();
      collectBaseLayouts(els, bases);
      for (const b of bases) if (!visited.has(b)) queue.push(b);
    }
    // Sanity: the walk really does descend through bases — the smartbox
    // (3D view) and both vitals clusters must be reached.
    expect(visited.has(0x2100000f)).toBe(true);
    expect(visited.has(0x2100006c)).toBe(true);
    expect(visited.has(0x21000075)).toBe(true);
    expect(visited.has(0x21000071)).toBe(true);
    // classic_statusbar 0x21000013 is not in the closure and no reachable
    // layout embeds its background element.
    expect(visited.has(0x21000013)).toBe(false);
    expect(carriers.map((c) => '0x' + c.toString(16))).toEqual([]);
  });

  it('smartbox base 0x2100000f is the 3D-view element with drag borders, not a statusbar host', () => {
    const els = parseLayoutDesc(langDb.getReader(0x2100000f)).elements;
    const smartbox = findElement(els, 0x10000037)!;
    expect(smartbox).toBeDefined();
    expect(smartbox.width).toBe(800);
    expect(smartbox.height).toBe(600);
    // The eight 5px border/corner pieces (0x100006ca..0x100006d1) are its
    // only textured children; no 28px top row exists.
    const tall28 = Array.from(smartbox.children.values()).filter((c) => c.height === 28);
    expect(tall28).toEqual([]);
    expect(findElement(els, 0x100000e2)).toBeUndefined();
  });

  it('both cluster layouts carry the same bar element IDs as classic vitals', () => {
    for (const layoutId of [0x2100006c, 0x21000075]) {
      const els = parseLayoutDesc(langDb.getReader(layoutId)).elements;
      for (const barId of [0x100000e6, 0x100000ec, 0x100000ee]) {
        const bar = findElement(els, barId)!;
        expect(bar, `bar 0x${barId.toString(16)} in 0x${layoutId.toString(16)}`).toBeDefined();
        // Depleted-overlay layer inside each bar
        expect(findElement(bar.children, 0x100000e7)).toBeDefined();
      }
      // Numeric label elements
      for (const textId of [0x100000eb, 0x100000ed, 0x100000ef]) {
        expect(findElement(els, textId), `text 0x${textId.toString(16)}`).toBeDefined();
      }
    }
  });

  it('strip layout 0x21000071 hosts the 7 indicator buttons but not combat-toggle/vitae', () => {
    const els = parseLayoutDesc(langDb.getReader(0x21000071)).elements;
    for (const id of [0x100000f3, 0x100000f4, 0x100000f5, 0x100000f6, 0x100000f7, 0x100000f8, 0x100000fa]) {
      expect(findElement(els, id), `indicator 0x${id.toString(16)}`).toBeDefined();
    }
    expect(findElement(els, 0x100000f1)).toBeUndefined(); // classic combat toggle
    expect(findElement(els, 0x100000f9)).toBeUndefined(); // classic vitae button
  });
});

// ── Behavioral: renderHUD vitals cluster wiring (happy-dom + DATs) ───────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe.skipIf(!hasDats)('CORE.5.b: renderHUD vitals cluster (behavioral, requires happy-dom + DATs)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));

    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');

    // TextureManager backs the LayoutRenderer only: happy-dom has no 2D
    // canvas context, so GameUI must not get a textureManager of its own.
    const texMgr = new TextureManager(portalDb);
    const layoutRenderer = new LayoutRenderer(langDb, new UITextureLoader(texMgr));
    layoutRenderer.getTextureDataURLWithAlpha = () => null;

    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container, {}, portalDb, undefined, undefined, undefined, null, layoutRenderer);
    ui.showGame();
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('default (SideBySideVitals off): stacked cluster 160x58, top-center', () => {
    expect(ui.optionsSettings.sideBySideVitals).toBe(false);
    const cluster = ui.hudContainer.querySelector('#hud-vitals') as HTMLElement;
    expect(cluster).toBeTruthy();
    expect(cluster.style.width).toBe('160px');
    expect(cluster.style.height).toBe('58px');
    expect(cluster.style.top).toBe('0px');
    // Horizontal centering (mode-3 edges), resolved to design px so a drag
    // can take over the coordinate (CORE.5.b.c): (1568 - 160) / 2 = 704.
    expect(cluster.style.left).toBe('704px');
  });

  it('wires all three bars + depleted overlays + numeric labels from the cluster', () => {
    expect(ui.vitalsHandle.elements.get(0x100000e6)).toBeTruthy();
    expect(ui.vitalsHandle.elements.get(0x100000ec)).toBeTruthy();
    expect(ui.vitalsHandle.elements.get(0x100000ee)).toBeTruthy();
    expect(ui.healthFillEl).toBeTruthy();
    expect(ui.staminaFillEl).toBeTruthy();
    expect(ui.manaFillEl).toBeTruthy();
    expect(ui.healthTextEl).toBeTruthy();
    expect(ui.staminaTextEl).toBeTruthy();
    expect(ui.manaTextEl).toBeTruthy();
  });

  it('renders NO classic statusbar row', () => {
    expect(ui.hudContainer.querySelector('#hud-statusbar')).toBeNull();
    // The classic statusbar background element must not exist in the DOM.
    expect(ui.hudContainer.querySelector('[data-element-id="0x100000e2"]')).toBeNull();
  });

  it('renders the indicator strip window at top-left with the DAT buttons', () => {
    const strip = ui.hudContainer.querySelector('#hud-indicators') as HTMLElement;
    expect(strip).toBeTruthy();
    expect(strip.style.top).toBe('0px');
    expect(strip.style.left).toBe('0px');
    // The 6 role-corrected indicators registered; wrong-premise classic
    // ids absent; the vitae + logout elements exist.
    expect(ui.indicatorTexById.size).toBe(6);
    expect(ui.indicatorTexById.has('vitae')).toBe(true);
    expect(ui.indicatorTexById.has('combat-toggle')).toBe(false);
    expect(ui.indicatorTexById.has('pk-status')).toBe(false);
    expect(domWindow.document.getElementById('hud-indicator-vitae')).toBeTruthy();
    expect(domWindow.document.getElementById('hud-indicator-logout')).toBeTruthy();
  });

  it('toggling SideBySideVitals re-renders the 460x26 side-by-side cluster', () => {
    ui.optionsSettings.sideBySideVitals = true;
    ui.refreshVitalsCluster();
    const cluster = ui.hudContainer.querySelector('#hud-vitals') as HTMLElement;
    expect(cluster.style.width).toBe('460px');
    expect(cluster.style.height).toBe('26px');
    // Centered in design px (CORE.5.b.c): (1568 - 460) / 2 = 554.
    expect(cluster.style.left).toBe('554px');
    // Only ONE cluster window exists (the stacked one was torn down).
    expect(ui.hudContainer.querySelectorAll('#hud-vitals').length).toBe(1);
    // Bars re-wired from the new layout.
    expect(ui.healthFillEl).toBeTruthy();
    expect(ui.vitalsHandle.elements.get(0x100000e6)).toBeTruthy();
  });

  it('toggling back restores the stacked cluster', () => {
    ui.optionsSettings.sideBySideVitals = false;
    ui.refreshVitalsCluster();
    const cluster = ui.hudContainer.querySelector('#hud-vitals') as HTMLElement;
    expect(cluster.style.width).toBe('160px');
    expect(cluster.style.height).toBe('58px');
    expect(ui.hudContainer.querySelectorAll('#hud-vitals').length).toBe(1);
  });

  it('sideBySideVitals maps to CharacterOption 0x13 for server persistence', async () => {
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    expect(GameUI.OPTIONS_TO_CHARACTER_OPTION.sideBySideVitals).toBe(0x13);
  });

  it('restoreCharacterOptions applies a server-side SideBySideVitals=ON bit', () => {
    // ACE CharacterOptions1.Default (1355064650) with the SideBySideVitals
    // bit (0x200000) OR'd in — as PlayerDescription would deliver it.
    const changed = ui.restoreCharacterOptions(1355064650 | 0x200000, -1);
    expect(changed).toContain('sideBySideVitals');
    expect(ui.optionsSettings.sideBySideVitals).toBe(true);
    // and the plain default clears it again
    const changedBack = ui.restoreCharacterOptions(1355064650, -1);
    expect(changedBack).toContain('sideBySideVitals');
    expect(ui.optionsSettings.sideBySideVitals).toBe(false);
  });

  // CORE.17.a — retail UIElement::UpdateForParentSizeChange re-anchors every
  // window on a display-size change: the cluster's L3/R3 edges re-center it
  // on the NEW width; a player-dragged window (edges zeroed) keeps its saved
  // position. The live harness caught the cluster parked at x=704 after a
  // 1568 -> 1920 resize because CORE.5.b.c baked the centering to px.
  it('CORE.17.a: a display-size change re-centers the undragged cluster and keeps a dragged one', async () => {
    const g = globalThis as Record<string, unknown>;
    const savedRaf = g.requestAnimationFrame;
    g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(0), 0);
    const settle = () => new Promise((r) => setTimeout(r, 20));
    try {
      const cluster = ui.hudContainer.querySelector('#hud-vitals') as HTMLElement;
      expect(cluster.style.left).toBe('704px');
      domWindow.happyDOM.setViewport({ width: 1920, height: 1080 });
      domWindow.dispatchEvent(new domWindow.Event('resize'));
      await settle();
      // (1920 - 160) / 2 — same element, re-centered, still top-pinned.
      expect(ui.hudContainer.querySelector('#hud-vitals')).toBe(cluster);
      expect(cluster.style.left).toBe('880px');
      expect(cluster.style.top).toBe('0px');

      // A drag persists x/y under the stacked cluster's WindowID (11); the
      // next resize must keep that position (re-clamped), not re-center.
      ui.persistFloatyWindowGeometry(11, { x: 300, y: 40 });
      domWindow.happyDOM.setViewport({ width: 1568, height: 775 });
      domWindow.dispatchEvent(new domWindow.Event('resize'));
      await settle();
      expect(cluster.style.left).toBe('300px');
      expect(cluster.style.top).toBe('40px');
    } finally {
      if (savedRaf === undefined) delete g.requestAnimationFrame; else g.requestAnimationFrame = savedRaf;
    }
  });
});
