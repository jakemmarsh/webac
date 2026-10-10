/**
 * CORE.18.e — the inventory panel opens in the EoL panels window at retail's
 * default rect, not stretched from the radar to the toolbar.
 *
 * Retail ground truth:
 *  - Root HUD 0x21000005 slot 0x100005ff: (490,128) 310x372, edges L2 T2 R1
 *    B1, WindowID (0x1000007e) 9, based on 0x2100006e:0x100005fe
 *    (gmFloatyPanelUI) whose body 0x10000180 at (5,5) 300x362 stacks every
 *    panel (inventory = 0x1000018b → 0x21000023:0x100001cc). Height limits
 *    p62 372 / p60 1000, width fixed p63 = p61 = 310.
 *  - gmFloatyPanelUI::UpdateFromPlayerModule @ 004d1d20 applies a rect
 *    persisted under WindowID 9 (MoveTo @ 004d20b0 clamps to the screen);
 *    with none the slot edges pin it right-flush, 100 px above the bottom.
 *  - Retail capture at 1600x900 (verification/retail-client/ab/
 *    retail-inventory-vendor.png): the panel spans y 432–795, three pack
 *    rows under a scrollbar, titled "Inventory of +Perf Tester".
 *  - Title: L"Inventory of %s" (acclient.exe 0x7aca50, pushed at 004a6bee in
 *    gmInventoryUI::RecvNotice_PlayerDescReceived @ 004a6bc0).
 *  - Sigil slots 0x10000595-97 hidden until AetheriaBitfield (PropertyInt
 *    322) sets their bit (gmPaperDollUI::UpdateAetheria @ 004a3e50).
 *
 * Drives the shipped code: the pure placement helper, the real GameUI in
 * happy-dom at 1600x900 and 1920x1080 (stubbed LayoutRenderer — no DATs),
 * and — when the DATs are present — the constants against the real layouts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { PANELS_WINDOW, panelsWindowPlacement } from '../packages/renderer/src/ui/PanelsWindow.js';
import { EquipMask } from '../packages/shared/src/index.js';

describe('CORE.18.e — panelsWindowPlacement (pure)', () => {
  it('a fresh profile at 1600x900: window (1290,428) 310x372, body (1295,433) 300x362 — retail y 432–795', () => {
    const at = panelsWindowPlacement({}, 1600, 900);
    expect(at).toEqual({ x: 1290, y: 428, w: 310, h: 372, body: { x: 1295, y: 433, w: 300, h: 362 } });
    expect(at.body.y + at.body.h).toBe(795);
  });

  it('rides the toolbar top at any resolution (800x600 authored → the DAT slot rect itself; 1920x1080)', () => {
    expect(panelsWindowPlacement({}, 800, 600)).toMatchObject({ x: 490, y: 128, w: 310, h: 372 });
    expect(panelsWindowPlacement({}, 1920, 1080)).toMatchObject({ x: 1610, y: 608, w: 310, h: 372 });
  });

  it('a persisted rect wins (UpdateFromPlayerModule → MoveTo / ResizeTo), clamped to the screen and p62..p60', () => {
    expect(panelsWindowPlacement({ x: 100, y: 50, h: 600 }, 1600, 900))
      .toEqual({ x: 100, y: 50, w: 310, h: 600, body: { x: 105, y: 55, w: 300, h: 590 } });
    // height below p62 / above p60 clamps; off-screen position clamps.
    expect(panelsWindowPlacement({ h: 100 }, 1600, 900).h).toBe(372);
    expect(panelsWindowPlacement({ x: 5000, y: -40, h: 5000 }, 1600, 1200)).toMatchObject({ x: 1290, y: 0, h: 1000 });
    // a persisted width is ignored — the root fixes it at 310 (p63 = p61).
    expect(panelsWindowPlacement({ w: 500 }, 1600, 900).w).toBe(310);
  });
});

const PLAYER_GUID = 0x50000001;

function item(id: number, name: string, containerId: number, itemType = 0) {
  return { id, weenieClassId: id & 0xffff, name, value: 1, burden: 10, stackSize: 1, maxStackSize: 1, stackable: false, containerId, itemType };
}

interface StubCalls {
  panelOptions: Record<string, unknown>;
  frames: Array<{ layoutId: number; options: Record<string, unknown> }>;
  titles: Map<number, string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubLayoutRenderer(win: any, calls: StubCalls) {
  const doc = win.document;
  return {
    renderPanel: (_layoutId: number, container: HTMLElement, options: Record<string, unknown> = {}) => {
      calls.panelOptions = options;
      const wrapper = doc.createElement('div');
      Object.assign(wrapper.style, { position: 'absolute', left: `${options.x}px`, top: `${options.y}px` });
      container.appendChild(wrapper);
      const root = doc.createElement('div');
      wrapper.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      for (const id of [0x100001cc, 0x100001cd, 0x100001ce, 0x100001cf, 0x100001d0, 0x100001d1]) {
        const el = doc.createElement('div');
        root.appendChild(el);
        elements.set(id, el);
      }
      return {
        root, elements,
        setText: (id: number, text: string) => { calls.titles.set(id, text); },
        resizeSubtree: (w: number, h: number) => { root.style.width = `${w}px`; root.style.height = `${h}px`; },
        close: () => { wrapper.remove(); },
      };
    },
    render: (layoutId: number, host: HTMLElement, options: Record<string, unknown> = {}) => {
      calls.frames.push({ layoutId, options });
      const root = doc.createElement('div');
      host.appendChild(root);
      return { root, elements: new Map(), descs: new Map(), resizeSubtree: () => {}, close: () => root.remove() };
    },
  };
}

async function mountAt(innerWidth: number, innerHeight: number): Promise<{ H: GameUIFixture; calls: StubCalls }> {
  const H = await mountGameUI({ size: { innerWidth, innerHeight } });
  const calls: StubCalls = { panelOptions: {}, frames: [], titles: new Map() };
  H.ui.layoutRenderer = stubLayoutRenderer(H.win, calls);
  H.ui.setSidePackGuids([PLAYER_GUID]);
  H.ui.setInventoryData([item(0x8000aaaa, 'Pyreal', PLAYER_GUID), item(0x8000aaab, 'Leather Basinet', PLAYER_GUID)], [], 30, 15000);
  H.ui.setInventoryOwner('+Perf Tester', 0);
  H.ui.toggleInventory();
  return { H, calls };
}

const px = (v: string): number => parseFloat(v);

describe('CORE.18.e — GameUI opens the inventory in the panels window (1600x900, happy-dom)', () => {
  let H: GameUIFixture;
  let calls: StubCalls;
  beforeAll(async () => { ({ H, calls } = await mountAt(1600, 900)); });
  afterAll(() => H.teardown());

  const gridArea = (): HTMLElement => H.ui.inventoryPanelHandle.elements.get(0x100001cf);

  it('the window wrapper sits at retail\'s default rect and the panel body at (5,5) inside it', () => {
    const wrapper = H.ui.inventoryPanel as HTMLElement;
    expect(px(wrapper.style.left)).toBe(1290);
    expect(px(wrapper.style.top)).toBe(428);
    expect(wrapper.style.width).toBe('310px');
    expect(wrapper.style.height).toBe('372px');
    const root = H.ui.inventoryPanelHandle.root as HTMLElement;
    expect(root.style.left).toBe('5px');
    expect(root.style.top).toBe('5px');
    expect(root.style.height).toBe('362px');
    // screen span of the panel body: 433..795 (retail 432–795).
    expect(px(wrapper.style.top) + px(root.style.top) + px(root.style.height)).toBe(795);
    expect(calls.panelOptions.anchorLeft).toBe(true);
  });

  it('the pack grid shows three 32px rows (96px viewport) of the fixed 102-cell main pack, with its scrollbar', () => {
    const vp = gridArea().querySelector('.layout-scroll-content') as HTMLElement;
    expect(vp.style.height).toBe('96px');
    expect(Math.floor(px(vp.style.height) / 32)).toBe(3);
    const grid = vp.querySelector('div[style*="grid"]') as HTMLElement;
    expect(grid.children.length).toBe(102);
    const bar = gridArea().querySelector('[data-dat-scrollbar]') as HTMLElement;
    expect(bar.style.height).toBe('96px');
  });

  it('the frame 0x2100006e:0x100005fe is drawn round it with the body slot omitted', () => {
    const f = calls.frames.find(c => c.layoutId === PANELS_WINDOW.windowLayout);
    expect(f).toBeTruthy();
    expect(f!.options.subtreeElementId).toBe(0x100005fe);
    expect(f!.options.omitChildIds).toEqual([0x10000180]);
    const host = (H.ui.inventoryPanel as HTMLElement).querySelector('[data-panels-window-frame]') as HTMLElement;
    expect(host.style.width).toBe('310px');
    expect(host.style.height).toBe('372px');
  });

  it('title reads "Inventory of <name>" and the contents label "Contents of Backpack" is centred (p20 = 1)', () => {
    expect(calls.titles.get(0x100001d3)).toBe('Inventory of +Perf Tester');
    const label = gridArea().querySelector('[data-element-id="0x100001c5"]') as HTMLElement;
    expect(label.textContent).toContain('Contents of Backpack');
    expect(label.style.justifyContent).toBe('center');
  });

  it('no aetheria sigil slots without AetheriaBitfield; each unlocked bit shows its slot', () => {
    const sigils = (): string[] => [...(H.ui.inventoryPanelHandle.elements.get(0x100001cd) as HTMLElement).querySelectorAll('[data-equip-slot]')]
      .map(el => (el as HTMLElement).dataset.equipSlot!).filter(l => l.endsWith('Aetheria'));
    expect(sigils()).toEqual([]);
    H.ui.setAetheriaBitfield(0x1);
    expect(sigils()).toEqual(['Blue Aetheria']);
    H.ui.setAetheriaBitfield(0x7);
    expect(sigils()).toEqual(['Blue Aetheria', 'Yellow Aetheria', 'Red Aetheria']);
    H.ui.setAetheriaBitfield(0);
    expect(sigils()).toEqual([]);
  });

  it('a rect persisted under WindowID 9 is applied (moved + grown), the grid reflowing with the body', () => {
    H.ui.persistFloatyWindowGeometry(PANELS_WINDOW.windowId, { x: 100, y: 50, w: 310, h: 600 });
    H.ui.renderInventoryPanel();
    const wrapper = H.ui.inventoryPanel as HTMLElement;
    expect(px(wrapper.style.left)).toBe(100);
    expect(px(wrapper.style.top)).toBe(50);
    expect(wrapper.style.height).toBe('600px');
    expect((H.ui.inventoryPanelHandle.root as HTMLElement).style.height).toBe('590px');
    const vp = gridArea().querySelector('.layout-scroll-content') as HTMLElement;
    expect(vp.style.height).toBe(`${96 + (590 - 362)}px`);
  });
});

describe('CORE.18.e — at 1920x1080 the same 310x372 window rides the toolbar top', () => {
  let H: GameUIFixture;
  beforeAll(async () => { ({ H } = await mountAt(1920, 1080)); });
  afterAll(() => H.teardown());

  it('window (1610,608) 310x372; body 300x362 with the three-row grid', () => {
    const wrapper = H.ui.inventoryPanel as HTMLElement;
    expect(px(wrapper.style.left)).toBe(1610);
    expect(px(wrapper.style.top)).toBe(608);
    expect(wrapper.style.height).toBe('372px');
    const vp = (H.ui.inventoryPanelHandle.elements.get(0x100001cf) as HTMLElement).querySelector('.layout-scroll-content') as HTMLElement;
    expect(vp.style.height).toBe('96px');
  });
});

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');

describe.skipIf(!fs.existsSync(LANG_PATH) || !fs.existsSync(PORTAL_PATH))('CORE.18.e — PANELS_WINDOW matches the DAT layouts', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hud: any; let win: any;
  beforeAll(async () => {
    const dat = await import('@ac/dat-parser');
    const open = (p: string) => {
      const b = fs.readFileSync(p);
      return new dat.DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    };
    const portal = open(PORTAL_PATH);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(new dat.DatReader(portal.getFileData(0x39000001)!)));
    const lang = open(LANG_PATH);
    hud = dat.parseLayoutDesc(new dat.DatReader(lang.getFileData(PANELS_WINDOW.hudLayout)!));
    win = dat.parseLayoutDesc(new dat.DatReader(lang.getFileData(PANELS_WINDOW.windowLayout)!));
    langDb = lang;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let langDb: any;

  it('the real LayoutRenderer draws the frame GameUI mounts: the eight locked + eight interactive border pieces, no body', async () => {
    const domWindow = await loadDomWindow({ innerWidth: 1600, innerHeight: 900 });
    const keys = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
    const saved: Record<string, unknown> = {};
    installDomGlobals(domWindow, keys, saved);
    try {
      const lrMod = await import('../packages/renderer/src/ui/LayoutRenderer.js');
      const tex = { getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`, getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}` };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const renderer = new lrMod.LayoutRenderer(langDb, tex as any, null);
      const host = domWindow.document.createElement('div');
      domWindow.document.body.appendChild(host);
      const frame = renderer.render(PANELS_WINDOW.windowLayout, host, { subtreeElementId: PANELS_WINDOW.window, omitChildIds: [PANELS_WINDOW.body] })!;
      expect(frame).toBeTruthy();
      expect(frame.elements.has(PANELS_WINDOW.body)).toBe(false);
      expect(frame.elements.has(PANELS_WINDOW.inventorySlot)).toBe(false);
      for (let id = 0x10000653; id <= 0x10000662; id++) expect(frame.elements.has(id)).toBe(true);
      // resize to a taller persisted window: the bottom border rides the bottom.
      frame.resizeSubtree!(310, 600);
      expect(parseFloat(frame.elements.get(0x10000658)!.style.top)).toBe(600 - 5);
    } finally {
      restoreDomGlobals(keys, saved);
    }
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const find = (layout: any, id: number): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (el: any): any => {
      if (el.elementId === id) return el;
      for (const [, c] of el.children) { const hit = walk(c); if (hit) return hit; }
      return null;
    };
    for (const [, el] of layout.elements) { const hit = walk(el); if (hit) return hit; }
    return null;
  };

  it('HUD slot 0x100005ff: (490,128) 310x372, L2/T2/R1/B1, WindowID 9 — right-flush, 100 px above the bottom', () => {
    const slot = find(hud, PANELS_WINDOW.hudSlot);
    expect([slot.x, slot.y, slot.width, slot.height]).toEqual([490, 128, PANELS_WINDOW.width, PANELS_WINDOW.height]);
    expect([slot.leftEdge, slot.topEdge, slot.rightEdge, slot.bottomEdge]).toEqual([2, 2, 1, 1]);
    expect(800 - slot.x - slot.width).toBe(PANELS_WINDOW.right);
    expect(600 - slot.y - slot.height).toBe(PANELS_WINDOW.bottom);
    expect(slot.properties.get(0x1000007e)?.valueEnum).toBe(PANELS_WINDOW.windowId);
    expect(slot.baseLayout).toBe(PANELS_WINDOW.windowLayout);
  });

  it('window 0x100005fe: body 0x10000180 at (5,5) 300x362 holding the inventory slot; height limits p62/p60 = 372/1000, width p63 = p61 = 310', () => {
    const root = find(win, PANELS_WINDOW.window);
    expect(root.properties.get(62)?.valueInt).toBe(PANELS_WINDOW.minHeight);
    expect(root.properties.get(60)?.valueInt).toBe(PANELS_WINDOW.maxHeight);
    expect(root.properties.get(63)?.valueInt).toBe(PANELS_WINDOW.width);
    expect(root.properties.get(61)?.valueInt).toBe(PANELS_WINDOW.width);
    const body = find(win, PANELS_WINDOW.body);
    const B = PANELS_WINDOW.bodyRect;
    expect([body.x, body.y, body.width, body.height]).toEqual([B.x, B.y, B.w, B.h]);
    const inv = find(win, PANELS_WINDOW.inventorySlot);
    expect([inv.baseLayout, inv.baseElement, inv.width, inv.height]).toEqual([0x21000023, 0x100001cc, 300, 362]);
  });

  // VISUAL.char-panel-body-too-bright — the character panel is the body's
  // slot 0x1000018e (based on 0x2100002e:0x10000227), drawn over the window
  // root's own image media: PANELS_WINDOW.fill, which GameUI paints behind it.
  it('window root 0x100005fe\'s image media is PANELS_WINDOW.fill; the character slot 0x1000018e is 0x2100002e:0x10000227 at 300x362', () => {
    const root = find(win, PANELS_WINDOW.window);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const images = root.media.filter((m: any) => m.type === 5).map((m: any) => m.file);
    expect(images).toEqual([PANELS_WINDOW.fill]);
    const charSlot = find(win, 0x1000018e);
    expect([charSlot.baseLayout, charSlot.baseElement, charSlot.width, charSlot.height]).toEqual([0x2100002e, 0x10000227, 300, 362]);
  });
});

describe('CORE.18.e — aetheriaSigilVisible (the UpdateAetheria bit map)', () => {
  it('maps SigilOne/Two/Three to AetheriaBitfield 0x1/0x2/0x4 and leaves other slots alone', async () => {
    const H = await mountGameUI();
    try {
      const f = H.mod.aetheriaSigilVisible;
      expect(f(EquipMask.SigilOne, 0)).toBe(false);
      expect(f(EquipMask.SigilOne, 1)).toBe(true);
      expect(f(EquipMask.SigilTwo, 1)).toBe(false);
      expect(f(EquipMask.SigilTwo, 2)).toBe(true);
      expect(f(EquipMask.SigilThree, 3)).toBe(false);
      expect(f(EquipMask.SigilThree, 4)).toBe(true);
      expect(f(EquipMask.NeckWear, 0)).toBe(true);
      expect(H.mod.inventoryPanelTitle('')).toBe('Inventory');
    } finally {
      H.teardown();
    }
  });
});
