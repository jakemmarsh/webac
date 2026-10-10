/**
 * CORE.5.b.c — floaty vitals/indicator/radar windows: draggable + resizable
 * per DAT, geometry persisted via PlayerModule chat-window options.
 *
 * Ground truth (decompiled EoL client + client_local_English.dat):
 *  - WindowIDs are DAT attribute 0x1000007e on the HUD 0x21000005 authoring
 *    elements: stacked vitals 0x100005fa → 11, indicator strip 0x10000611 →
 *    12, radar 0x100006d2 → 14, side-by-side vitals 0x100006d5 → 17
 *    (gmFloatyVitalsUI::PostInit @ 004cedb0 etc. read it via
 *    GetAttribute_Enum).
 *  - Geometry persists through options 0x10000086-89 under the WindowID
 *    (gmRadarUI::MoveTo @ 004d81a0 writes x/y, gmFloatySideVitalsUI::
 *    ResizeTo @ 004d0a50 writes w/h; gmFloatyVitalsUI::
 *    UpdateFromPlayerModule @ 004cf140 restores both pairs).
 *  - Resize limits are the window roots' own p63/p62 (min) and p61/p60
 *    (max) props (UIElement::MouseResizeElement @ 00461130): stacked
 *    160-610 wide at fixed 58 tall, side-by-side 360-3000 wide at fixed 26
 *    tall, indicators fixed 150x30 (movable only).
 *  - Border chrome: type-2 UIElement_Dragbar borders drag, type-9
 *    UIElement_Resizebar handles resize (direction props p43/p44); LockUI
 *    swaps them for the plain locked border art (gmFloatyPanelUI::
 *    UpdateLockedStatus @ 004d0280).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatDatabase, DatReader, parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes } from '@ac/dat-parser';
import {
  parseGameplayOptions, serializeGameplayOptions, BinaryReader,
} from '@ac/network';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const LANG_DAT = resolve(REPO, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// ─── Codec round-trip (unit — runs everywhere) ──────────────────────────


/** GAP.ui-cursor-global — the DAT Cursor media DID an element plays (its own cursor). */
function datCursorDid(desc: { media: { type: number; file?: number }[]; states: Map<number, { media: { type: number; file?: number }[] }> } | undefined): number {
  if (!desc) return 0;
  for (const m of [...desc.media, ...[...desc.states.values()].flatMap((s) => s.media)]) if (m.type === 4 /* MediaType.Cursor */) return m.file ?? 0;
  return 0;
}

describe('CORE.5.b.c: floaty-window geometry round-trips the GameplayOptions codec', () => {
  it('windows 11/12/14/17 serialize and parse back', () => {
    const windows = new Map<number, { x?: number; y?: number; w?: number; h?: number }>([
      [11, { x: 200, y: 40, w: 550, h: 58 }],
      [12, { x: 10, y: 700 }],
      [14, { x: 0, y: 300 }],
      [17, { x: 5, y: 0, w: 1800, h: 26 }],
    ]);
    const blob = serializeGameplayOptions({ chatWindows: windows });
    const parsed = parseGameplayOptions(new BinaryReader(blob));
    expect(parsed).not.toBeNull();
    expect(parsed!.chatWindows.get(11)).toMatchObject({ x: 200, y: 40, w: 550, h: 58 });
    expect(parsed!.chatWindows.get(12)).toMatchObject({ x: 10, y: 700 });
    expect(parsed!.chatWindows.get(14)).toMatchObject({ x: 0, y: 300 });
    expect(parsed!.chatWindows.get(17)).toMatchObject({ x: 5, y: 0, w: 1800, h: 26 });
    // Windows never touched stay absent.
    expect(parsed!.chatWindows.has(13)).toBe(false);
  });
});

// ─── DAT ground truth ───────────────────────────────────────────────────

describe.skipIf(!hasDats)('CORE.5.b.c: DAT ground truth — WindowIDs, size limits, border classes', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let langDb: DatDatabase;

  beforeAll(() => {
    const portalDb = openDat(PORTAL_DAT);
    langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
  });

  const layout = (id: number) => parseLayoutDesc(new DatReader(langDb.getFileData(id)!));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const findEl = (ld: any, id: number): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (el: any): any => {
      if ((el.elementId >>> 0) === id) return el;
      for (const [, c] of el.children) { const hit = walk(c); if (hit) return hit; }
      return null;
    };
    for (const [, el] of ld.elements) { const hit = walk(el); if (hit) return hit; }
    return null;
  };

  it('HUD 0x21000005 authors WindowIDs 11/12/14/17 via attribute 0x1000007e', () => {
    const hud = layout(0x21000005);
    expect(findEl(hud, 0x100005fa).properties.get(0x1000007E)?.valueEnum).toBe(11);
    expect(findEl(hud, 0x10000611).properties.get(0x1000007E)?.valueEnum).toBe(12);
    expect(findEl(hud, 0x100006d2).properties.get(0x1000007E)?.valueEnum).toBe(14);
    expect(findEl(hud, 0x100006d5).properties.get(0x1000007E)?.valueEnum).toBe(17);
  });

  it('stacked root 0x100005f9: width 160-610, fixed height 58 (p63/p61/p62/p60)', () => {
    const root = findEl(layout(0x2100006c), 0x100005f9);
    expect(root.properties.get(63)?.valueInt).toBe(160);
    expect(root.properties.get(61)?.valueInt).toBe(610);
    expect(root.properties.get(62)?.valueInt).toBe(58);
    expect(root.properties.get(60)?.valueInt).toBe(58);
  });

  it('side-by-side root 0x100006d4: width 360-3000, fixed height 26', () => {
    const root = findEl(layout(0x21000075), 0x100006d4);
    expect(root.properties.get(63)?.valueInt).toBe(360);
    expect(root.properties.get(61)?.valueInt).toBe(3000);
    expect(root.properties.get(62)?.valueInt).toBe(26);
    expect(root.properties.get(60)?.valueInt).toBe(26);
  });

  it('indicators root 0x10000610: min = max = 150x30 (movable only)', () => {
    const root = findEl(layout(0x21000071), 0x10000610);
    expect(root.properties.get(63)?.valueInt).toBe(150);
    expect(root.properties.get(61)?.valueInt).toBe(150);
    expect(root.properties.get(62)?.valueInt).toBe(30);
    expect(root.properties.get(60)?.valueInt).toBe(30);
  });

  it('stacked cluster borders: type-2 drag strips + type-9 resize handles (left/right only)', () => {
    const ld = layout(0x2100006c);
    // Drag strips (UIElement_Dragbar, move cursor 0x6006119).
    for (const id of [0x1000063c, 0x10000640]) {
      expect(findEl(ld, id).type, `0x${id.toString(16)}`).toBe(2);
    }
    // Resize handles: p43=left / p44=right, and no top/bottom flags
    // anywhere (fixed height).
    let sawLeft = 0, sawRight = 0;
    for (const id of [0x1000063b, 0x1000063d, 0x1000063e, 0x1000063f, 0x10000641, 0x10000642]) {
      const el = findEl(ld, id);
      expect(el.type, `0x${id.toString(16)}`).toBe(9);
      if (el.properties.get(43)?.valueBool) sawLeft++;
      if (el.properties.get(44)?.valueBool) sawRight++;
      expect(el.properties.get(45)?.valueBool ?? false).toBe(false);
      expect(el.properties.get(42)?.valueBool ?? false).toBe(false);
    }
    expect(sawLeft).toBe(3);
    expect(sawRight).toBe(3);
  });

  it('indicator strip borders are ALL type-2 drag bars — no resize handles', () => {
    const ld = layout(0x21000071);
    const types: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (el: any): void => {
      types.push(el.type);
      for (const [, c] of el.children) walk(c);
    };
    for (const [, el] of ld.elements) walk(el);
    expect(types.filter((t) => t === 2).length).toBe(8);
    expect(types.filter((t) => t === 9).length).toBe(0);
  });

  it('side-by-side bars use proportional (mode 4) horizontal edges', () => {
    const ld = layout(0x21000075);
    const health = findEl(ld, 0x100000e6);
    const stamina = findEl(ld, 0x100000ec);
    const mana = findEl(ld, 0x100000ee);
    expect(health.rightEdge).toBe(4);
    expect(stamina.leftEdge).toBe(4);
    expect(stamina.rightEdge).toBe(4);
    expect(mana.leftEdge).toBe(4);
    expect(mana.rightEdge).toBe(1);
  });
});

// ─── Behavioral (GameUI + real DATs + happy-dom) ────────────────────────

describe.skipIf(!hasDats)('CORE.5.b.c: drag/resize/persist behavior', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let LayoutRendererClass: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));

    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    LayoutRendererClass = LayoutRenderer;

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

  function mouse(type: string, x: number, y: number): MouseEvent {
    return new domWindow.MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = () => domWindow.document as any;

  it('default: stacked cluster top-center at authored 160x58 (no persisted geometry)', () => {
    const cluster = ui.hudContainer.querySelector('#hud-vitals') as HTMLElement;
    expect(cluster).toBeTruthy();
    expect(cluster.style.width).toBe('160px');
    expect(cluster.style.height).toBe('58px');
    expect(cluster.style.top).toBe('0px');
    // Centered: (1024 - 160) / 2 = 432 design px.
    expect(cluster.style.left).toBe('432px');
  });

  it('drag strip 0x1000063c moves the cluster and persists WindowID 11 x/y', () => {
    const bar = ui.vitalsHandle.elements.get(0x1000063c) as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.style.cursor).toBe('move');
    bar.dispatchEvent(mouse('mousedown', 500, 10));
    doc().dispatchEvent(mouse('mousemove', 460, 110));
    doc().dispatchEvent(mouse('mouseup', 460, 110));
    const cluster = ui.hudContainer.querySelector('#hud-vitals') as HTMLElement;
    expect(cluster.style.left).toBe('392px'); // 432 - 40
    expect(cluster.style.top).toBe('100px');
    // Persisted (localStorage stand-in) + staged for the options blob.
    const data = ui.buildChatWindowOptionsData();
    expect(data.chatWindows.get(11)).toMatchObject({ x: 392, y: 100 });
  });

  it('right resize handle 0x10000642 widens the cluster, clamped to maxW 610', () => {
    const handleEl = ui.vitalsHandle.elements.get(0x10000642) as HTMLElement;
    expect(handleEl).toBeTruthy();
    // GAP.ui-cursor-global — the edge's arrow is its DAT Cursor media (E–W 0x06006128), not a CSS keyword.
    expect(handleEl.style.cursor).toBe('');
    expect(datCursorDid(ui.vitalsHandle.descs.get(0x10000642))).toBe(0x06006128);
    handleEl.dispatchEvent(mouse('mousedown', 600, 120));
    doc().dispatchEvent(mouse('mousemove', 800, 120)); // +200 → 360 wide
    doc().dispatchEvent(mouse('mouseup', 800, 120));
    const cluster = ui.hudContainer.querySelector('#hud-vitals') as HTMLElement;
    expect(cluster.style.width).toBe('360px');
    expect(cluster.style.height).toBe('58px'); // fixed height
    // The bars reflow with the window (stretch edges R1).
    const healthBar = ui.vitalsHandle.elements.get(0x100000e6) as HTMLElement;
    expect(healthBar.style.width).toBe('350px'); // 150 + 200
    // ...including the duplicate-id INNER art of every bar (ids 0x100000e8/
    // e9/ea repeat across all three bars — reflow pairs desc children to
    // DOM instances by document order, not the last-instance elements map):
    // middle piece L1R1 stretches to 330 (=130+200), right cap L2 follows
    // the far edge to x=340, ornament L3/R3 re-centers.
    for (const barId of [0x100000e6, 0x100000ec, 0x100000ee]) {
      const bar = ui.vitalsHandle.elements.get(barId) as HTMLElement;
      const mids = bar.querySelectorAll('[data-element-id="0x100000e9"]');
      expect(mids.length, `bar 0x${barId.toString(16)} mid pieces`).toBe(2); // bright + depleted layers
      for (const mid of Array.from(mids) as HTMLElement[]) {
        expect(mid.style.width, `bar 0x${barId.toString(16)} middle`).toBe('330px');
      }
      for (const cap of Array.from(bar.querySelectorAll('[data-element-id="0x100000ea"]')) as HTMLElement[]) {
        expect(cap.style.left, `bar 0x${barId.toString(16)} right cap`).toBe('340px');
      }
    }
    const data = ui.buildChatWindowOptionsData();
    expect(data.chatWindows.get(11)).toMatchObject({ w: 360, h: 58 });

    // Clamp: drag far beyond maxW.
    handleEl.dispatchEvent(mouse('mousedown', 800, 120));
    doc().dispatchEvent(mouse('mousemove', 8000, 120));
    doc().dispatchEvent(mouse('mouseup', 8000, 120));
    expect(cluster.style.width).toBe('610px');
    expect(ui.buildChatWindowOptionsData().chatWindows.get(11)).toMatchObject({ w: 610 });
  });

  it('server-persisted geometry restores position + size on re-render', () => {
    ui.setServerChatWindowOptions({
      chatWindows: new Map([[11, { x: 200, y: 60, w: 400, h: 58 }]]),
    });
    const cluster = ui.hudContainer.querySelector('#hud-vitals') as HTMLElement;
    expect(cluster.style.left).toBe('200px');
    expect(cluster.style.top).toBe('60px');
    expect(cluster.style.width).toBe('400px');
    // Bars re-wired after the restore re-render.
    expect(ui.healthFillEl).toBeTruthy();
  });

  it('restore clamps out-of-range width to the DAT maxW', () => {
    ui.setServerChatWindowOptions({
      chatWindows: new Map([[11, { x: 0, y: 0, w: 9999, h: 58 }]]),
    });
    const cluster = ui.hudContainer.querySelector('#hud-vitals') as HTMLElement;
    expect(cluster.style.width).toBe('610px');
  });

  it('indicator strip drags via its type-2 border ring and persists WindowID 12', () => {
    // Reset chat/server options so the strip starts at its default (0,0).
    ui.setServerChatWindowOptions({ chatWindows: new Map() });
    const bar = ui.indicatorsHandle.elements.get(0x10000650) as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.style.cursor).toBe('move');
    bar.dispatchEvent(mouse('mousedown', 70, 27));
    doc().dispatchEvent(mouse('mousemove', 100, 227));
    doc().dispatchEvent(mouse('mouseup', 100, 227));
    const strip = ui.hudContainer.querySelector('#hud-indicators') as HTMLElement;
    expect(strip.style.left).toBe('30px');
    expect(strip.style.top).toBe('200px');
    const data = ui.buildChatWindowOptionsData();
    expect(data.chatWindows.get(12)).toMatchObject({ x: 30, y: 200 });
    // Fixed-size window: no w/h persisted.
    expect(data.chatWindows.get(12)?.w).toBeUndefined();
  });

  it('a click on the radar drag button that never moves saves nothing (no snap to 0,0)', () => {
    const btn = ui.hudContainer.querySelector('#radar-drag-button') as HTMLElement;
    const radar = ui.hudContainer.querySelector('#hud-radar') as HTMLElement;
    expect(radar.style.left).toBe('');
    btn.dispatchEvent(mouse('mousedown', 950, 20));
    doc().dispatchEvent(mouse('mouseup', 950, 20));
    expect(radar.style.left).toBe('');
    expect(ui.buildChatWindowOptionsData().chatWindows.get(14)).toBeUndefined();
  });

  it('a click on a radar blip selects it (gmRadarUI::ListenToElementMessage @ 004d75b0)', () => {
    const canvas = ui.hudContainer.querySelector('#radar-canvas') as HTMLCanvasElement;
    expect(canvas).toBeTruthy();
    const picked: number[] = [];
    ui.callbacks.onRadarObjectClick = (g: number) => picked.push(g);
    ui.radarBlipHits = [{ x: 40, y: 30, guid: 0x81000001, name: 'Drudge Slinker' }];
    const r = canvas.getBoundingClientRect();
    const sx = r.width > 0 ? r.width / canvas.width : 1;
    const sy = r.height > 0 ? r.height / canvas.height : 1;
    canvas.dispatchEvent(mouse('mouseup', r.left + 41 * sx, r.top + 31 * sy));
    expect(picked).toEqual([0x81000001]);
    canvas.dispatchEvent(mouse('mouseup', r.left + 100 * sx, r.top + 100 * sy));
    expect(picked).toEqual([0x81000001]);
  });

  it('radar drag button moves the radar and persists WindowID 14', () => {
    const btn = ui.hudContainer.querySelector('#radar-drag-button') as HTMLElement;
    expect(btn).toBeTruthy();
    expect(btn.style.pointerEvents).toBe('auto');
    btn.dispatchEvent(mouse('mousedown', 950, 20));
    doc().dispatchEvent(mouse('mousemove', 850, 120));
    doc().dispatchEvent(mouse('mouseup', 850, 120));
    const radar = ui.hudContainer.querySelector('#hud-radar') as HTMLElement;
    // Default anchor right:0 → left = 1024 - 120 = 904; moved -100/+100.
    expect(radar.style.left).toBe('804px');
    expect(radar.style.top).toBe('100px');
    expect(radar.style.right).toBe('');
    const data = ui.buildChatWindowOptionsData();
    expect(data.chatWindows.get(14)).toMatchObject({ x: 804, y: 100 });
  });

  it('radar position restores from server options', () => {
    ui.setServerChatWindowOptions({ chatWindows: new Map([[14, { x: 10, y: 250 }]]) });
    const radar = ui.hudContainer.querySelector('#hud-radar') as HTMLElement;
    expect(radar.style.left).toBe('10px');
    expect(radar.style.top).toBe('250px');
  });

  it('LockUI swaps interactive borders for the locked border art', () => {
    ui.optionsSettings.lockUI = true;
    LayoutRendererClass.setUILocked(true);
    ui.updateRadarLockedStatus();
    // Interactive drag strip hidden, locked art (0x10000634 top border,
    // tex 0x60074bf) shown.
    expect((ui.vitalsHandle.elements.get(0x1000063c) as HTMLElement).style.display).toBe('none');
    expect((ui.vitalsHandle.elements.get(0x10000642) as HTMLElement).style.display).toBe('none');
    expect((ui.vitalsHandle.elements.get(0x10000634) as HTMLElement).style.display).toBe('');
    expect((ui.indicatorsHandle.elements.get(0x10000650) as HTMLElement).style.display).toBe('none');
    expect((ui.indicatorsHandle.elements.get(0x10000644) as HTMLElement).style.display).toBe('');

    // Locked: dragging does nothing.
    const cluster = ui.hudContainer.querySelector('#hud-vitals') as HTMLElement;
    const before = cluster.style.left;
    const bar = ui.vitalsHandle.elements.get(0x1000063c) as HTMLElement;
    bar.dispatchEvent(mouse('mousedown', 500, 10));
    doc().dispatchEvent(mouse('mousemove', 300, 10));
    doc().dispatchEvent(mouse('mouseup', 300, 10));
    expect(cluster.style.left).toBe(before);

    ui.optionsSettings.lockUI = false;
    LayoutRendererClass.setUILocked(false);
    ui.updateRadarLockedStatus();
    expect((ui.vitalsHandle.elements.get(0x1000063c) as HTMLElement).style.display).toBe('');
    expect((ui.vitalsHandle.elements.get(0x10000634) as HTMLElement).style.display).toBe('none');
  });

  it('side-by-side cluster restores its own WindowID 17 geometry with proportional bar reflow', () => {
    ui.optionsSettings.sideBySideVitals = true;
    ui.setServerChatWindowOptions({ chatWindows: new Map([[17, { x: 0, y: 0, w: 920, h: 26 }]]) });
    const cluster = ui.hudContainer.querySelector('#hud-vitals') as HTMLElement;
    expect(cluster.style.width).toBe('920px');
    expect(cluster.style.height).toBe('26px');
    // Mode-4 proportional columns at 2x width: stamina (155..304 → L4/R4)
    // lands at 310 with a 300px span.
    const stamina = ui.vitalsHandle.elements.get(0x100000ec) as HTMLElement;
    expect(stamina.style.left).toBe('310px');
    expect(stamina.style.width).toBe('300px');
    ui.optionsSettings.sideBySideVitals = false;
    ui.setServerChatWindowOptions({ chatWindows: new Map() });
    ui.refreshVitalsCluster();
  });
});
