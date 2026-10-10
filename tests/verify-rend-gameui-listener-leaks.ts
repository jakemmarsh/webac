/**
 * REND.gameui-listener-observer-leaks — GameUI runtime hygiene.
 *
 *  - bindDatScrollbarWidget (the retail UIElement_Scrollbar widget) used to
 *    create a MutationObserver + ResizeObserver per call and never
 *    disconnect them; the inventory binds two bars and rebuilt on every
 *    burden message / trade change and once a second during a cooldown.
 *    Re-binding a column now disposes its previous binding, and bindings
 *    whose column was live and has been detached are disposed on the next
 *    bind (or when the inventory closes).
 *  - setBurden re-fills the strip's % text + meter in place
 *    (gmBackpackUI::SetLoadLevel), and the 1 s cooldown heartbeat advances
 *    the decile overlays in place (UIElement_UIItem::UpdateCooldownDisplay)
 *    instead of rebuilding the panel.
 *  - the context menus' deferred click-elsewhere listener can no longer be
 *    installed after the menu was already hidden (it then leaked forever).
 *
 * Drives the real GameUI in happy-dom.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

const HAPPY_DOM_PKG = ['happy', 'dom'].join('-');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let domWindow: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ HAPPY_DOM_PKG);
  domWindow = new mod.Window({ innerWidth: 1024, innerHeight: 768 });
} catch { /* skip */ }

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const INVENTORY_ELEMENT_IDS = [0x100001d0, 0x100001cd, 0x100001ce, 0x100001cf];
const COOLDOWN_OVERLAY_TEXTURE_BASE = 0x060067cf;

/** Observer fakes that track which instances are still observing. */
class FakeMutationObserver {
  static live = new Set<FakeMutationObserver>();
  constructor(_cb: unknown) {}
  observe(): void { FakeMutationObserver.live.add(this); }
  disconnect(): void { FakeMutationObserver.live.delete(this); }
  takeRecords(): unknown[] { return []; }
}
class FakeResizeObserver {
  static live = new Set<FakeResizeObserver>();
  constructor(_cb: unknown) {}
  observe(): void { FakeResizeObserver.live.add(this); }
  unobserve(): void {}
  disconnect(): void { FakeResizeObserver.live.delete(this); }
}

describe.skipIf(!domWindow)('REND.gameui-listener-observer-leaks (real GameUI in happy-dom)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    saved.MutationObserver = g.MutationObserver;
    saved.ResizeObserver = g.ResizeObserver;
    g.MutationObserver = FakeMutationObserver;
    g.ResizeObserver = FakeResizeObserver;
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of INVENTORY_ELEMENT_IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return { root, elements, setText: () => {}, close: () => { root.remove(); } };
      },
    };
    ui.itemIconCache.set(0x06000501, 'data:image/png;base64,GEM');
    for (let d = 0; d < 10; d++) ui.itemIconCache.set(COOLDOWN_OVERLAY_TEXTURE_BASE + d, `data:image/png;base64,CD${(d + 1) * 10}`);
  });
  afterAll(() => {
    if (ui?.cooldownMeterTimer) { clearInterval(ui.cooldownMeterTimer); ui.cooldownMeterTimer = null; }
    const g = globalThis as Record<string, unknown>;
    for (const key of [...DOM_GLOBALS, 'MutationObserver', 'ResizeObserver']) {
      if (saved[key] === undefined) delete g[key]; else g[key] = saved[key];
    }
  });
  afterEach(() => { vi.useRealTimers(); });

  const dagger = { id: 7, weenieClassId: 900, name: 'Plain Dagger', value: 0, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 };
  function openInventory(items: unknown[] = [dagger], burden = 30, max = 15000): void {
    if (!ui.inventoryVisible) ui.toggleInventory();
    ui.setInventoryData(items, [], burden, max);
  }
  const liveObservers = () => FakeMutationObserver.live.size + FakeResizeObserver.live.size;

  /* ── observers ── */

  it('inventory rebuilds do not accumulate scrollbar observers (two bars → one MO + one RO each, however many rebuilds)', () => {
    openInventory();
    const baseMO = FakeMutationObserver.live.size;
    const baseRO = FakeResizeObserver.live.size;
    expect(baseMO).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < 10; i++) ui.renderInventoryPanel();
    expect(FakeMutationObserver.live.size).toBe(baseMO);
    expect(FakeResizeObserver.live.size).toBe(baseRO);
    // Every live observer belongs to a bar that is still in the document.
    for (const col of ui.datScrollbarBindings.keys()) expect((col as HTMLElement).isConnected).toBe(true);
  });

  it('closing the inventory disposes its two bars', () => {
    openInventory();
    const before = liveObservers();
    ui.toggleInventory(); // close
    expect(ui.inventoryVisible).toBe(false);
    expect(liveObservers()).toBe(before - 4); // 2 bars × (MO + RO)
  });

  it('re-binding the same column replaces its binding — no stacked scroll / wheel / mousedown listeners', () => {
    const col = domWindow.document.createElement('div');
    const vp = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(col);
    domWindow.document.body.appendChild(vp);
    const net = new Map<string, number>();
    const track = (el: HTMLElement, tag: string) => {
      const add = el.addEventListener.bind(el);
      const rem = el.removeEventListener.bind(el);
      el.addEventListener = ((type: string, ...rest: unknown[]) => { net.set(`${tag}:${type}`, (net.get(`${tag}:${type}`) ?? 0) + 1); return (add as (...a: unknown[]) => void)(type, ...rest); }) as never;
      el.removeEventListener = ((type: string, ...rest: unknown[]) => { net.set(`${tag}:${type}`, (net.get(`${tag}:${type}`) ?? 0) - 1); return (rem as (...a: unknown[]) => void)(type, ...rest); }) as never;
    };
    track(col, 'col');
    track(vp, 'vp');
    const before = liveObservers();
    for (let i = 0; i < 5; i++) ui.bindDatScrollbarWidget(col, vp, 16, true);
    expect(net.get('vp:scroll')).toBe(1);
    expect(net.get('col:wheel')).toBe(1);
    expect(net.get('col:mousedown')).toBe(1);
    expect(liveObservers()).toBe(before + 2);
    col.remove(); vp.remove();
    ui.sweepDatScrollbarBindings();
    expect(liveObservers()).toBe(before);
    expect(net.get('vp:scroll')).toBe(0);
    expect(net.get('col:wheel')).toBe(0);
  });

  it('a bar built while its window is still detached (floaty chat) survives sweeps until it has been live and is removed', () => {
    const win = domWindow.document.createElement('div');
    const col = domWindow.document.createElement('div');
    const vp = domWindow.document.createElement('div');
    win.appendChild(col); win.appendChild(vp);
    const before = liveObservers();
    ui.bindDatScrollbarWidget(col, vp, 16);
    ui.sweepDatScrollbarBindings();
    expect(liveObservers()).toBe(before + 2); // never connected yet — kept
    domWindow.document.body.appendChild(win);
    ui.sweepDatScrollbarBindings();
    expect(liveObservers()).toBe(before + 2); // live — kept
    win.remove();
    ui.sweepDatScrollbarBindings();
    expect(liveObservers()).toBe(before); // was live, now gone — disposed
  });

  /* ── burden in place ── */

  it('setBurden updates the strip % text + meter in place, matching a full rebuild', () => {
    openInventory([dagger], 30, 15000);
    const panel = ui.inventoryPanel;
    const { text, cover } = ui.inventoryBurdenReadout;
    const obsBefore = liveObservers();
    ui.setBurden(15000, 15000); // load 1.0 → 100 %
    expect(ui.inventoryPanel).toBe(panel);
    expect(text.isConnected).toBe(true);
    expect(liveObservers()).toBe(obsBefore);
    const inPlaceText = text.innerHTML;
    const inPlaceCover = cover.style.height;
    expect(inPlaceCover).toBe(`${Math.round((1 - 1 / 3) * 58)}px`);
    // A from-scratch build at the same burden paints the same readout.
    ui.renderInventoryPanel();
    expect(ui.inventoryBurdenReadout.text.innerHTML).toBe(inPlaceText);
    expect(ui.inventoryBurdenReadout.cover.style.height).toBe(inPlaceCover);
    // 3x+ capacity caps at 300 % / an empty meter cover.
    ui.setBurden(60000, 15000);
    expect(ui.inventoryBurdenReadout.cover.style.height).toBe('0px');
  });

  /* ── cooldown heartbeat in place ── */

  it('the 1 s cooldown heartbeat advances the decile overlay in place (no rebuild, grid keeps its scroll)', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    ui.cooldownMeterTimer = null;
    const gem = { ...dagger, id: 8, name: 'Gem', iconDid: 0x06000501, cooldownId: 27, cooldownDuration: 100 };
    ui.addEnchantment({
      spellId: 0x8000 + 27, layer: 1, name: 'Cooldown', iconId: 0,
      isBeneficial: false, isVitae: false, isCooldown: true, duration: 100, startTime: 0, casterGuid: 0,
    });
    openInventory([gem]);
    const panel = ui.inventoryPanel;
    const cell = panel.querySelector('[data-inv-slot]') as HTMLElement;
    const overlay = () => [...cell.children].find(c => (c as HTMLElement).dataset.cooldownDecile !== undefined) as HTMLElement | undefined;
    expect(overlay()!.style.backgroundImage).toContain('CD100');
    vi.advanceTimersByTime(15_000); // 85 s left → decile 9
    expect(ui.inventoryPanel).toBe(panel);
    expect(cell.isConnected).toBe(true);
    expect(overlay()!.style.backgroundImage).toContain('CD90');
    expect(overlay()!.dataset.cooldownDecile).toBe('9');
    vi.advanceTimersByTime(90_000); // recharged → overlay dropped, ticker stops
    expect(ui.inventoryPanel).toBe(panel);
    expect(overlay()).toBeUndefined();
    expect(ui.cooldownMeterTimer).toBeNull();
    ui.removeEnchantment(0x8000 + 27, 1);
  });

  it('a cooldown that starts while the heartbeat runs gets its overlay (the tick rebuilds when a cell is missing one)', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    ui.cooldownMeterTimer = null;
    const a = { ...dagger, id: 8, name: 'Gem A', iconDid: 0x06000501, cooldownId: 27, cooldownDuration: 100 };
    const b = { ...dagger, id: 9, name: 'Gem B', iconDid: 0x06000501, cooldownId: 28, cooldownDuration: 100 };
    ui.addEnchantment({
      spellId: 0x8000 + 27, layer: 1, name: 'Cooldown', iconId: 0,
      isBeneficial: false, isVitae: false, isCooldown: true, duration: 100, startTime: 0, casterGuid: 0,
    });
    openInventory([a, b]);
    ui.addEnchantment({
      spellId: 0x8000 + 28, layer: 1, name: 'Cooldown', iconId: 0,
      isBeneficial: false, isVitae: false, isCooldown: true, duration: 100, startTime: 0, casterGuid: 0,
    });
    vi.advanceTimersByTime(1_000);
    const cells = [...ui.inventoryPanel.querySelectorAll('[data-inv-slot]')] as HTMLElement[];
    const withOverlay = cells.filter(c => [...c.children].some(x => (x as HTMLElement).dataset.cooldownDecile !== undefined));
    expect(withOverlay).toHaveLength(2);
    ui.removeEnchantment(0x8000 + 27, 1);
    ui.removeEnchantment(0x8000 + 28, 1);
    vi.advanceTimersByTime(2_000);
  });


});
