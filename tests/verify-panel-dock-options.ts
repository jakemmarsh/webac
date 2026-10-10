/**
 * FAITHFUL.477/478 + CORE.5 — behavioral coverage of the renderPanel options
 * every floating/docked panel passes: persistKey (position persistence,
 * versioned on coordinate-space changes) and the CORE.5 native-pixel dock
 * geometry (panels-window panels open at panelsWindowPlacement; bottom-band
 * panels compute y from the logical viewport height instead of the old
 * 800x600 design space).
 *
 * Replaces the source-text persistKey pins that used to live in
 * verify-panel-position-persistence.ts / verify-trade-vendor-draggable.ts /
 * verify-options-map-frame-migration.ts (pin-conversion rule): this drives
 * the REAL GameUI render methods in happy-dom with a stub LayoutRenderer
 * that records each renderPanel call, so a renamed key or broken dock
 * anchor fails on behavior, not on source text.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { panelsWindowPlacement } from '../packages/renderer/src/ui/PanelsWindow.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent',
  'requestAnimationFrame', 'cancelAnimationFrame'] as const;

interface RecordedCall { layoutId: number; options: Record<string, unknown>; }

describe('CORE.5/FAITHFUL.477 — panel renderPanel options (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const calls: RecordedCall[] = [];

  // elements map that auto-creates an element for any id the panel code asks
  // for, so every render method runs to completion against the stub.
  class AutoElements extends Map<number, HTMLElement> {
    private host: HTMLElement;
    constructor(host: HTMLElement) { super(); this.host = host; }
    override get(id: number): HTMLElement {
      let el = super.get(id);
      if (!el) {
        el = domWindow.document.createElement('div');
        this.host.appendChild(el!);
        super.set(id, el!);
      }
      return el!;
    }
  }

  function makeHandle(parent: HTMLElement) {
    const wrapper = domWindow.document.createElement('div');
    parent.appendChild(wrapper);
    const root = domWindow.document.createElement('div');
    wrapper.appendChild(root);
    const scrollStub = () => ({
      contentEl: domWindow.document.createElement('div'),
      setPosition: () => {}, scrollToBottom: () => {}, appendContent: () => {},
    });
    return {
      root,
      layout: { elements: [] },
      elements: new AutoElements(root),
      descs: new Map(),
      setText: () => {}, setFill: () => {}, setVisible: () => {},
      setState: () => {}, setPalette: () => {}, setInteractive: () => {},
      setScrollable: scrollStub, setDraggable: () => {}, setDropTarget: () => {},
      setTexture: () => {}, onClick: () => {}, destroy: () => { wrapper.remove(); },
      moveTo: () => {}, close: () => { wrapper.remove(); }, bringToFront: () => {},
    };
  }

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // rAF must stay bound to the happy-dom window object.
    g.requestAnimationFrame = (cb: FrameRequestCallback) => domWindow.requestAnimationFrame(cb);
    g.cancelAnimationFrame = (id: number) => domWindow.cancelAnimationFrame(id);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      render: (_layoutId: number, parent: HTMLElement) => makeHandle(parent),
      renderPanel: (layoutId: number, parent: HTMLElement, options: Record<string, unknown> = {}) => {
        calls.push({ layoutId, options });
        return makeHandle(parent);
      },
    };
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function lastCallFor(layoutId: number): RecordedCall {
    const call = [...calls].reverse().find((c) => c.layoutId === layoutId);
    if (!call) throw new Error(`no renderPanel call recorded for layout 0x${layoutId.toString(16)}`);
    return call;
  }

  // VISUAL.char-panel-body-too-bright.a.a — the spellbook is the panels
  // window's slot 0x10000190 (based on 0x21000034:0x100002a8): it opens at
  // the window's rect, no dock / tab-drag / persistKey of its own.
  it('magic (spellbook) panel: opens at the panels-window rect, no persistKey or tab drag', () => {
    const at = panelsWindowPlacement({}, ui.hudLogicalWidth(), ui.hudLogicalHeight());
    ui.renderMagicPanel();
    const { options } = lastCallFor(0x21000034);
    expect([options.x, options.y]).toEqual([at.x, at.y]);
    expect(options.subtreeElementId).toBe(0x100002a8);
    expect(options.closeButtonId).toBe(0x100002ab);
    expect(options.persistKey).toBeUndefined();
    expect(options.dragHandleId).toBeUndefined();
  });

  // VISUAL.char-panel-body-too-bright.a — the character panel is the EoL
  // panels window's slot 0x1000018e: it opens at the window's rect (right-
  // flush, riding the toolbar), exactly where the inventory opens, with no
  // dock persistKey of its own (the window's rect persists under WindowID 9).
  it('character panel: opens at the panels-window rect, like the inventory', () => {
    const at = panelsWindowPlacement({}, ui.hudLogicalWidth(), ui.hudLogicalHeight());
    ui.renderCharPanel();
    const { options } = lastCallFor(0x2100002e);
    expect(options.x).toBe(at.x);
    expect(options.y).toBe(at.y);
    expect(options.subtreeElementId).toBe(0x10000227);
    expect(options.persistKey).toBeUndefined();
    ui.renderInventoryPanel();
    const inv = lastCallFor(0x21000023).options;
    expect([inv.x, inv.y]).toEqual([options.x, options.y]);
  });

  // gmPanelUI::RecvNotice_SetPanelVisibility @ 004bc6f0 — one panel at a time.
  it('inventory, character and character info share the window one at a time', () => {
    // No report source: the info panel renders nothing, only the slot state moves.
    ui.characterInfoSource = null;
    ui.toggleInventory();
    expect(ui.inventoryVisible).toBe(true);
    ui.toggleCharPanel();
    expect(ui.charPanelVisible).toBe(true);
    expect(ui.inventoryVisible).toBe(false);
    // Character info carries 0x10000049: it hands the slot back on hide.
    ui.toggleCharacterInfoTextPanel();
    expect(ui.charInfoTextPanelVisible).toBe(true);
    expect(ui.charPanelVisible).toBe(false);
    ui.toggleCharacterInfoTextPanel();
    expect(ui.charInfoTextPanelVisible).toBe(false);
    expect(ui.charPanelVisible).toBe(true);
    // The character panel lacks it: hiding it leaves the window empty.
    ui.toggleCharPanel();
    expect(ui.charPanelVisible).toBe(false);
    expect(ui.inventoryVisible).toBe(false);
  });

  it('social panel: opens at the panels-window rect (slot 0x1000018f), no persistKey or tab drag', () => {
    const at = panelsWindowPlacement({}, ui.hudLogicalWidth(), ui.hudLogicalHeight());
    ui.renderSocialPanel();
    const { options } = lastCallFor(0x21000031);
    expect([options.x, options.y]).toEqual([at.x, at.y]);
    expect(options.persistKey).toBeUndefined();
    expect(options.dragHandleId).toBeUndefined();
  });

  // VISUAL.options-panel-eol-window — the options panel is the panels
  // window's slot 0x1000018d (based on 0x2100002b:0x10000208, no
  // 0x10000049): it opens at the window's rect like the inventory, no dock
  // persistKey of its own, and showing it displaces the current panel.
  it('options panel: opens at the panels-window rect and takes the slot from the inventory', () => {
    const at = panelsWindowPlacement({}, ui.hudLogicalWidth(), ui.hudLogicalHeight());
    if (!ui.inventoryVisible) ui.toggleInventory();
    expect(ui.inventoryVisible).toBe(true);
    ui.toggleOptionsPanel();
    expect(ui.optionsPanelVisible).toBe(true);
    expect(ui.inventoryVisible).toBe(false);
    const { options } = lastCallFor(0x2100002b);
    expect([options.x, options.y]).toEqual([at.x, at.y]);
    expect(options.subtreeElementId).toBe(0x10000208);
    expect(options.persistKey).toBeUndefined();
    // Neither carries 0x10000049: hiding options leaves the window empty.
    ui.toggleOptionsPanel();
    expect(ui.optionsPanelVisible).toBe(false);
    expect(ui.inventoryVisible).toBe(false);
  });

  // CORE.5.d / VISUAL.char-panel-body-too-bright.a.a — the world panel is
  // the panels window's slot 0x1000018c (based on 0x21000027:0x100001f2):
  // it opens at the window's rect like the inventory.
  it('map panel: opens at the panels-window rect as a subtree of 0x100001f2, no persistKey', () => {
    const at = panelsWindowPlacement({}, ui.hudLogicalWidth(), ui.hudLogicalHeight());
    ui.renderMapPanel();
    const { options } = lastCallFor(0x21000027);
    expect([options.x, options.y]).toEqual([at.x, at.y]);
    expect(options.subtreeElementId).toBe(0x100001f2);
    expect(options.closeButtonId).toBe(0x100001f5);
    expect(options.dragHandleId).toBeUndefined();
    expect(options.persistKey).toBeUndefined();
  });

  it('contracts panel: opens at the panels-window rect (slot 0x10000559), no persistKey', () => {
    const at = panelsWindowPlacement({}, ui.hudLogicalWidth(), ui.hudLogicalHeight());
    ui.contractVisible = true;
    ui.renderContractPanel();
    ui.contractVisible = false;
    const { options } = lastCallFor(0x21000063);
    expect([options.x, options.y]).toEqual([at.x, at.y]);
    expect(options.subtreeElementId).toBe(0x1000055f);
    expect(options.persistKey).toBeUndefined();
    expect(options.dragHandleId).toBeUndefined();
  });

  // gmPanelUI::RecvNotice_SetPanelVisibility @ 004bc6f0 — the spellbook,
  // world, social and contracts panels share the one body with the rest:
  // each open hides the current panel, none carries 0x10000049.
  it('spellbook, world, social and contracts take the slot one at a time', () => {
    ui.characterInfoSource = null;
    const vis = () => ({
      inventory: ui.inventoryVisible, magic: ui.magicVisible, map: ui.mapPanelVisible,
      social: ui.socialPanelVisible, contracts: ui.contractVisible,
    });
    if (!ui.inventoryVisible) ui.toggleInventory();
    ui.toggleMagicPanel();
    expect(vis()).toEqual({ inventory: false, magic: true, map: false, social: false, contracts: false });
    ui.toggleMapPanel();
    expect(vis()).toEqual({ inventory: false, magic: false, map: true, social: false, contracts: false });
    ui.toggleSocialPanel();
    expect(vis()).toEqual({ inventory: false, magic: false, map: false, social: true, contracts: false });
    ui.toggleContractPanel();
    expect(vis()).toEqual({ inventory: false, magic: false, map: false, social: false, contracts: true });
    // Only one panel is in the DOM: the displaced ones closed their handles.
    expect([ui.magicPanelHandle, ui.mapPanelHandle, ui.socialPanelHandle]).toEqual([null, null, null]);
    // No 0x10000049: hiding contracts leaves the window empty.
    ui.hideContractPanel();
    expect(vis()).toEqual({ inventory: false, magic: false, map: false, social: false, contracts: false });
  });

  // GAP.indicator-bar-interactive — the improvised "Enchantments" panel on
  // the Character Info layout 0x2100001a is gone: gmEffectsUI's two windows
  // are the derived elements 0x1000011f / 0x10000121 of 0x2100001b, slots
  // 0x10000184 / 0x10000185 of the EoL panels window body (0x2100006e), so
  // they open at that body's rect (PanelsWindow.ts: right-flush, 100 px
  // above the bottom — (719,401) on this 1024x768 HUD) with their own
  // persisted positions.
  it('effects windows: 0x2100001b subtrees AS the panels window (WindowID 9 frame), no drag handle / persistKey of their own', () => {
    for (const [toggle, element] of [
      ['togglePositiveEffectsPanel', 0x1000011f],
      ['toggleNegativeEffectsPanel', 0x10000121],
    ] as const) {
      ui[toggle]();
      const { options } = lastCallFor(0x2100001b);
      expect(options.subtreeElementId).toBe(element);
      expect(options.persistKey).toBeUndefined();
      expect(options.closeButtonId).toBe(0x100000fc);
      expect(options.dragHandleId).toBeUndefined();
      expect(options.anchorLeft).toBe(true);
      expect([options.x, options.y]).toEqual([1024 - 310, 768 - 100 - 372]);
      ui[toggle]();
    }
  });

  // CORE.17.k.b.b.c.c.a.a.c.a — the vendor / container / salvage / trade
  // panels are NOT floating renderPanel panels: the EoL client hosts each in
  // its slot of the HUD's bottom transaction dock (HUD 0x21000005 slot
  // 0x100005fd (0,400) 610x120, L3 T2 R3 B1 → 0x2100006d:0x100005fb) — a
  // fixed 610x120 host centred 80 px above the bottom, no drag handle, no
  // persisted position. (FAITHFUL.478's "trade was draggable" premise was
  // the generic 0x2100001a frame, which no EoL layout puts it in.)
  const dockHost = (el: HTMLElement): string[] => {
    const s = el.style;
    return [s.left, s.marginLeft, s.bottom, s.width, s.height, el.dataset.dock ?? ''];
  };
  const DOCK_HOST = ['50%', '-305px', '80px', '610px', '120px', '0x2100006d'];

  it('trade panel: the dock trade slot — no renderPanel call (no drag / persist key)', () => {
    const before = calls.length;
    ui.showTradeWindow('Partner');
    expect(calls.length).toBe(before);
    expect(dockHost(ui.tradePanel)).toEqual(DOCK_HOST);
    expect(ui.tradePanel.dataset.dockPanel).toBe('trade');
    ui.hideTradeWindow();
  });

  it('vendor bar: the dock vendor slot — no renderPanel call', () => {
    const before = calls.length;
    ui.vendorVisible = true;
    ui.renderVendorPanel();
    expect(calls.length).toBe(before); // no renderPanel (no drag/persist key)
    expect(ui.vendorWrapper).not.toBeNull();
    expect(dockHost(ui.vendorWrapper)).toEqual(DOCK_HOST);
  });

  it('external-container strip: the dock container slot — no renderPanel call', () => {
    const before = calls.length;
    ui.showContainerPanel(0x80001234, [], -1);
    expect(calls.length).toBe(before);
    expect(dockHost(ui.containerPanel)).toEqual(DOCK_HOST);
    ui.hideContainerPanel();
  });

  it('salvage panel: the dock salvage slot', () => {
    ui.showSalvagePanel(0x80005555);
    expect(dockHost(ui.salvagePanel)).toEqual(DOCK_HOST);
    ui.hideSalvagePanel();
  });

  /* ── CORE.5 — native-pixel HUD container ── */

  it('hudContainer is native-pixel (scale 1, logical size == viewport) at ≥800x600', () => {
    domWindow.innerWidth = 1024; domWindow.innerHeight = 768;
    domWindow.dispatchEvent(new domWindow.Event('resize'));
    const hud = ui.hudContainer as HTMLElement;
    expect(hud.style.transform).toBe('');
    expect(parseFloat(hud.style.width)).toBeCloseTo(1024, 3);
    expect(parseFloat(hud.style.height)).toBeCloseTo(768, 3);
  });

  it('hudContainer downscales uniformly only below the 800x600 design minimum', () => {
    domWindow.innerWidth = 640; domWindow.innerHeight = 480;
    domWindow.dispatchEvent(new domWindow.Event('resize'));
    const hud = ui.hudContainer as HTMLElement;
    // s = min(1, 640/800, 480/600) = 0.8 → logical space is exactly 800x600.
    expect(hud.style.transform).toBe('scale(0.8)');
    expect(parseFloat(hud.style.width)).toBeCloseTo(800, 3);
    expect(parseFloat(hud.style.height)).toBeCloseTo(600, 3);
    // restore for any later suites
    domWindow.innerWidth = 1024; domWindow.innerHeight = 768;
    domWindow.dispatchEvent(new domWindow.Event('resize'));
  });
});
