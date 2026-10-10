/**
 * RECON.inventory-grid-dat-cells — the pack grid's cells draw what the
 * retail UIItem (template 0x21000037:0x1000033a, overlays 0x10000346) draws
 * and nothing else:
 *
 *  - the ShortcutNum tag 0x1000034a: UIItem_Update @ 004e21d0 hands the
 *    object's ACCWeenieObject::shortcutNum (its toolbar slot,
 *    gmToolbarUI::AddShortcut @ 004bd9a0) to SetShortcutNum @ 004e1590, which
 *    shows p0x10000042[n] (0x0600109e+n, then the blank 0x060074d3) or the
 *    ghosted p0x10000043[n] (0x06001acc+n, then 0x060074d2);
 *  - no quantity number: UpdateQuantityDisplay @ 004e1da0 shows the text only
 *    for m_quantity >= 0, which only VendorItemsUI::UpdateQuantityOverlay sets;
 *  - no dim: the trade state is the Icon_TradeState overlay alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  itemOverlayShortcutNumMedia, ITEM_OVERLAY_SHORTCUT_NUM_BASE, ITEM_OVERLAY_SHORTCUT_NUM_BLANK,
  ITEM_OVERLAY_SHORTCUT_NUM_GHOSTED_BLANK, SHORTCUT_NUM_GHOSTED_BASE,
} from '../packages/renderer/src/ui/SpellShortcutBar.js';

describe('itemOverlayShortcutNumMedia — overlays 0x10000346 child 0x1000034a tables', () => {
  it('slots 1-9 take the pack tag 0x0600109e+n; ghosted, 0x06001acc+n', () => {
    expect(ITEM_OVERLAY_SHORTCUT_NUM_BASE).toBe(0x0600109e);
    expect(itemOverlayShortcutNumMedia(0)).toBe(0x0600109e);
    expect(itemOverlayShortcutNumMedia(8)).toBe(0x060010a6);
    expect(itemOverlayShortcutNumMedia(0, true)).toBe(SHORTCUT_NUM_GHOSTED_BASE);
    expect(itemOverlayShortcutNumMedia(8, true)).toBe(0x06001ad4);
  });
  it('slots 10-18 take the blank tag 0x060074d3 (ghosted 0x060074d2)', () => {
    expect(itemOverlayShortcutNumMedia(9)).toBe(ITEM_OVERLAY_SHORTCUT_NUM_BLANK);
    expect(itemOverlayShortcutNumMedia(17)).toBe(0x060074d3);
    expect(itemOverlayShortcutNumMedia(17, true)).toBe(ITEM_OVERLAY_SHORTCUT_NUM_GHOSTED_BLANK);
  });
  it('no shortcut (−1) or out of range hides the tag', () => {
    expect(itemOverlayShortcutNumMedia(-1)).toBeNull();
    expect(itemOverlayShortcutNumMedia(18)).toBeNull();
  });
});

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

describe.skipIf(!domWindow)('RECON.inventory-grid-dat-cells — pack grid UIItem overlays (real GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let CombatMode: any;
  const shortcuts = new Array<number>(18).fill(0);

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    CombatMode = (await import('@ac/shared')).CombatMode;
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
    ui.itemShortcutObjectAt = (i: number) => shortcuts[i] ?? 0;
    for (const t of [0x0600109e, 0x060010a0, 0x060074d3, 0x06001ace]) ui.uiTextures.set(t, `data:image/png;base64,T${t.toString(16)}`);
  });
  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
  });

  const dagger = { id: 7, weenieClassId: 900, name: 'Plain Dagger', value: 0, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 };
  const pyreals = { id: 8, weenieClassId: 273, name: 'Pyreal', pluralName: 'Pyreals', value: 5000, burden: 1, stackSize: 5000, maxStackSize: 25000, stackable: true, containerId: 0 };
  const potion = { id: 9, weenieClassId: 901, name: 'Health Potion', value: 0, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 };

  function cells(): HTMLElement[] {
    if (!ui.inventoryPanelHandle) ui.toggleInventory();
    const grid = ui.inventoryPanelHandle.elements.get(0x100001cf).querySelector('div[style*="grid"]') as HTMLElement;
    return [...grid.children] as HTMLElement[];
  }
  const cellFor = (guid: number) => cells().find(c => c.dataset.acSelGuid === String(guid))!;
  const tagOf = (cell: HTMLElement) => cell.querySelector('[data-shortcut-tag]') as HTMLElement | null;

  it('an item on toolbar slot 3 carries the 0x060010a0 tag; one on slot 12 the blank tag; one with no shortcut none', () => {
    shortcuts.fill(0);
    shortcuts[2] = 7;
    shortcuts[11] = 9;
    ui.hud.combatMode = CombatMode.NonCombat;
    ui.setInventoryData([dagger, pyreals, potion], [], 1, 100);
    const d = tagOf(cellFor(7));
    expect(d?.dataset.shortcutTag).toBe((0x060010a0).toString(16));
    expect(d?.style.backgroundImage).toContain('T60010a0');
    expect(tagOf(cellFor(9))?.dataset.shortcutTag).toBe((0x060074d3).toString(16));
    expect(tagOf(cellFor(8))).toBeNull();
  });

  it('magic mode ghosts the tag (p0x10000043) along with the toolbar numerals', () => {
    ui.hud.combatMode = CombatMode.Magic;
    ui.setInventoryData([dagger, pyreals, potion], [], 1, 100);
    expect(tagOf(cellFor(7))?.dataset.shortcutTag).toBe((0x06001ace).toString(16));
    ui.hud.combatMode = CombatMode.NonCombat;
  });

  it('a shortcut added or removed re-tags the open grid in place (no rebuild)', () => {
    shortcuts.fill(0);
    ui.setInventoryData([dagger, pyreals, potion], [], 1, 100);
    const cell = cellFor(8);
    expect(tagOf(cell)).toBeNull();
    shortcuts[0] = 8;
    ui.setItemShortcutIcon(0, 0x06001234, 'Pyreal');
    expect(cell.isConnected).toBe(true);
    expect(tagOf(cell)?.dataset.shortcutTag).toBe((0x0600109e).toString(16));
    shortcuts[0] = 0;
    ui.setItemShortcutIcon(0, undefined, '');
    expect(tagOf(cell)).toBeNull();
  });

  it('a stack draws no count on its icon; the count lives in the tooltip', () => {
    shortcuts.fill(0);
    ui.setInventoryData([pyreals], [], 1, 100);
    const cell = cellFor(8);
    expect(cell.textContent ?? '').not.toMatch(/\d/);
    expect(cell.dataset.acTooltipText).toBe('5000 Pyreals');
  });
});

describe.skipIf(!domWindow)('RECON.inventory-grid-dat-cells.b — the waiting ghost 0x10000349 (real GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let pending = 0;
  const shortcuts = new Array<number>(18).fill(0);
  const GHOST = (0x0600109a).toString(16);

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
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
    ui.itemShortcutObjectAt = (i: number) => shortcuts[i] ?? 0;
    ui.itemRequestPendingFor = (guid: number) => guid === pending;
    ui.uiTextures.set(0x0600109a, 'data:image/png;base64,G');
    ui.uiTextures.set(0x0600109e, 'data:image/png;base64,T');
  });
  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
  });

  const dagger = { id: 7, weenieClassId: 900, name: 'Plain Dagger', value: 0, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 };
  const potion = { id: 9, weenieClassId: 901, name: 'Health Potion', value: 0, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 };
  function cellFor(guid: number): HTMLElement {
    if (!ui.inventoryPanelHandle) ui.toggleInventory();
    const grid = ui.inventoryPanelHandle.elements.get(0x100001cf).querySelector('div[style*="grid"]') as HTMLElement;
    return ([...grid.children] as HTMLElement[]).find(c => c.dataset.acSelGuid === String(guid))!;
  }
  const ghostOf = (cell: HTMLElement) => cell.querySelector(':scope > [data-waiting-ghost]') as HTMLElement | null;
  const nextTick = () => new Promise<void>(r => setTimeout(r, 5));

  it('ItemList_BeginDrag ghosts the dragged pack item with 0x0600109a; the others stay bare', () => {
    pending = 0;
    ui.setInventoryData([dagger, potion], [], 1, 100);
    const cell = cellFor(7);
    expect(ghostOf(cell)).toBeNull();
    cell.dispatchEvent(new domWindow.Event('dragstart', { bubbles: true }));
    const ghost = ghostOf(cell);
    expect(ghost?.dataset.waitingGhost).toBe(GHOST);
    expect(ghost?.style.backgroundImage).toContain('base64,G');
    expect(ui.isItemWaiting(7)).toBe(true);
    expect(ghostOf(cellFor(9))).toBeNull();
  });

  it('a drag that ends with no request sent (refused / non-move drop, cancel) clears the ghost', async () => {
    pending = 0;
    const cell = cellFor(7);
    cell.dispatchEvent(new domWindow.Event('dragend', { bubbles: true }));
    await nextTick();
    expect(ui.isItemWaiting(7)).toBe(false);
    expect(ghostOf(cell)).toBeNull();
  });

  it('a drop that sent a request keeps the ghost through a rebuild until the server answers', async () => {
    ui.setInventoryData([dagger, potion], [], 1, 100);
    cellFor(9).dispatchEvent(new domWindow.Event('dragstart', { bubbles: true }));
    pending = 9; // the drop's PutItemInContainer recorded the request
    domWindow.document.body.dispatchEvent(new domWindow.Event('drop', { bubbles: true }));
    await nextTick();
    expect(ui.isItemWaiting(9)).toBe(true);
    ui.setInventoryData([dagger, potion], [], 1, 100);
    expect(ghostOf(cellFor(9))?.dataset.waitingGhost).toBe(GHOST);
    // ServerSaysMoveItem / SetStackSize / AttemptFailed → SetWaitingState(0), in place.
    const cell = cellFor(9);
    pending = 0;
    ui.setItemWaiting(9, false);
    expect(cell.isConnected).toBe(true);
    expect(ghostOf(cell)).toBeNull();
  });

  it('the ghost sits under the shortcut tag 0x1000034a (read order: 0x10000349 before it)', () => {
    shortcuts[0] = 7;
    ui.setInventoryData([dagger, potion], [], 1, 100);
    ui.setItemWaiting(7, true);
    const cell = cellFor(7);
    const kids = [...cell.children] as HTMLElement[];
    const g = kids.findIndex(k => k.dataset.waitingGhost !== undefined);
    const t = kids.findIndex(k => k.dataset.shortcutTag !== undefined);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(t).toBeGreaterThan(g);
    ui.setItemWaiting(7, false);
    shortcuts[0] = 0;
  });
});

describe.skipIf(!domWindow)('RECON.inventory-grid-dat-cells.c — the sell-state badge 0x10000437 on every UIItem (real GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const shortcuts = new Array<number>(18).fill(0);
  const PLAYER = 0x50000001;
  const PACK = 0x80000020;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
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
    ui.itemShortcutObjectAt = (i: number) => shortcuts[i] ?? 0;
    ui.itemRequestPendingFor = () => false;
    ui.uiTextures.set(0x060012d9, 'data:image/png;base64,S');
    ui.uiTextures.set(0x0600109a, 'data:image/png;base64,G');
    ui.uiTextures.set(0x0600109e, 'data:image/png;base64,T');
  });
  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
  });

  const dagger = { id: 7, weenieClassId: 900, name: 'Plain Dagger', value: 10, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: PLAYER };
  const potion = { id: 9, weenieClassId: 901, name: 'Health Potion', value: 10, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: PLAYER };
  const sack = { id: PACK, weenieClassId: 902, name: 'Sack', value: 10, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: PLAYER, itemsCapacity: 24 };
  const sword = { id: 11, weenieClassId: 903, name: 'Long Sword', value: 10, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0, slot: 0x100000 };
  /** The open vendor's sell list (VendorItemSetSellState sets each object's sellState). */
  function listForSale(guids: number[]): void {
    ui.vendorVisible = guids.length > 0;
    ui.vendorData.sellList = guids.map((guid) => ({ guid, qty: 1 }));
  }
  function render(): void {
    ui.setInventoryData([dagger, potion, sack], [sword], 1, 100);
    ui.setSidePackGuids([PLAYER, PACK]);
    if (!ui.inventoryPanelHandle) ui.toggleInventory();
    else ui.renderInventoryPanel();
  }
  const panel = (): HTMLElement => ui.inventoryPanelHandle.root as HTMLElement;
  const gridCell = (guid: number): HTMLElement => {
    const grid = ui.inventoryPanelHandle.elements.get(0x100001cf).querySelector('div[style*="grid"]') as HTMLElement;
    return ([...grid.children] as HTMLElement[]).find(c => c.dataset.acSelGuid === String(guid))!;
  };
  const badgeOf = (cell: Element | null | undefined) => (cell?.querySelector(':scope > [data-sell-state]') ?? null) as HTMLElement | null;

  it('a pack item on the sell list carries the 0x060012d9 badge over its icon; the others none', () => {
    listForSale([7]);
    render();
    const badge = badgeOf(gridCell(7));
    expect(badge).not.toBeNull();
    expect(badge!.style.backgroundImage).toContain('base64,S');
    expect(badge!.style.width).toBe('32px');
    expect(badgeOf(gridCell(9))).toBeNull();
  });

  it('an empty side pack on the sell list carries it in the pack column (0x1000033f > 0x1000033e overlays)', () => {
    listForSale([PACK]);
    render();
    const packCells = [...panel().querySelectorAll('[data-pack-wait-cell]')] as HTMLElement[];
    const sackCell = packCells.find(c => c.dataset.acSelGuid === String(PACK));
    expect(sackCell).toBeDefined();
    expect(badgeOf(sackCell)?.style.backgroundImage).toContain('base64,S');
    expect(badgeOf(gridCell(7))).toBeNull();
  });

  it('a worn item on the sell list carries it on its paperdoll slot (templates based on 0x10000445)', () => {
    listForSale([11]);
    render();
    const slot = panel().querySelector('[data-ac-sel-guid="11"][data-equip-slot]') ?? panel().querySelector('[data-equip-slot="Weapon"]');
    expect(badgeOf(slot)).not.toBeNull();
    listForSale([]);
    render();
    expect(panel().querySelectorAll('[data-sell-state]').length).toBe(0);
  });

  it('the badge reads over the waiting ghost 0x10000349 and the shortcut tag 0x1000034a (overlay read order)', () => {
    shortcuts[0] = 7;
    listForSale([7]);
    render();
    ui.setItemWaiting(7, true);
    const kids = [...gridCell(7).children] as HTMLElement[];
    const g = kids.findIndex(k => k.dataset.waitingGhost !== undefined);
    const t = kids.findIndex(k => k.dataset.shortcutTag !== undefined);
    const b = kids.findIndex(k => k.dataset.sellState !== undefined);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(t).toBeGreaterThan(g);
    expect(b).toBeGreaterThan(t);
    ui.setItemWaiting(7, false);
    shortcuts[0] = 0;
    listForSale([]);
  });
});

describe.skipIf(!domWindow)('RECON.inventory-grid-dat-cells.b — the ghost media is preloaded', () => {
  it('loadChargenTextures() loads 0x0600109a, so the live ghost paints the DAT stipple (not the transparent fallback)', async () => {
    const g = globalThis as Record<string, unknown>;
    const saved: Record<string, unknown> = {};
    for (const key of DOM_GLOBALS) { saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    try {
      const mod = await import('../packages/renderer/src/ui/GameUI.js');
      const container = domWindow.document.createElement('div');
      domWindow.document.body.appendChild(container);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ui: any = new mod.GameUI(container);
      ui.textureManager = {
        getIconRGBA: () => ({ width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4) }),
        getIconDataURL: (id: number) => `data:image/png;base64,tex${id.toString(16)}`,
        getJPEGDataURL: () => null,
      };
      ui.loadChargenTextures();
      expect(ui.uiTextures.get(0x0600109a)).toBe('data:image/png;base64,tex600109a');
      // RECON.inventory-grid-dat-cells.c — the sell-state badge 0x10000437 too.
      expect(ui.uiTextures.get(0x060012d9)).toBe('data:image/png;base64,tex60012d9');
    } finally {
      for (const key of DOM_GLOBALS) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
    }
  });
});
