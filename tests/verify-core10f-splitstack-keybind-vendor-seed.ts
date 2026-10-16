/**
 * CORE.10.f — the two remaining GenItemHolder::splitSize surfaces.
 *
 * Ground truth (decompiled retail client, build ac1_sep13):
 * - Split-stack input action: CPlayerSystem::OnAction case 2 @ 00561890 →
 *   CM_UI::SendNotice_SplitStack(ACCWeenieObject::selectedID);
 *   gmToolbarUI::RecvNotice_SplitStack @ 004bd2a0 — when the notice's guid
 *   IS the selection and its stackSize >= 2, the toolbar split entry is
 *   shown + focused + UIElement_Text::SelectAll'd. Any other selection is
 *   a no-op. The portal.dat ActionMap names the action "Split Selected
 *   Stack" (id 0x1000002d, class UI).
 * - Vendor seeding: gmToolbarUI::HandleSelectionChanged @ 004bf380 — the
 *   function unconditionally resets splitSize/maxSplitSize to 1/1 on a
 *   selection change (@ 004bf6e8), then for a stack of >=2: if the open
 *   vendor exists (ClientUISystem::vendorID != 0), the stack's containerID
 *   == vendorID, and its ITEM_TYPE intersects 0xdc41cb0, splitSize seeds 1;
 *   otherwise splitSize seeds the full stack size. maxSplitSize is always
 *   the stack size (0 → 1).
 * - Consumption: ItemHolder::GetObjectSplitSize @ 00586f00 — a transfer
 *   gesture takes splitSize when the object IS the global selection, else
 *   the object's full stackSize (0 → 1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'PointerEvent'] as const;

const VENDOR_GUID = 0x70001234;
const MASK = 0x0dc41cb0;

describe('CORE.10.f — action-id wiring (portal.dat ActionMap)', () => {
  it('"Split Selected Stack" is ActionMap id 0x1000002d, class UI, known to the registry', async () => {
    const { ACT } = await import('../packages/renderer/src/input/KeybindDefaults.js');
    const { KeybindRegistry } = await import('../packages/renderer/src/input/KeybindRegistry.js');
    const { ActionClass } = await import('../packages/renderer/src/input/KeybindActionClass.js');
    expect(ACT.SplitSelectedStack).toBe(0x1000002d);
    const reg = new KeybindRegistry();
    const action = reg.action(ACT.SplitSelectedStack);
    expect(action).toBeTruthy();
    expect(action!.name).toBe('Split Selected Stack');
    expect(action!.cls).toBe(ActionClass.UI);
  });
});

describe('CORE.10.f — split-stack focus + vendor splitSize seeding (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      return {
        root, elements: new Map(), descs: new Map(),
        setText: () => {}, setInteractive: () => {}, setVisible: () => {},
        setState: () => {}, setFill: () => {}, setPalette: () => {},
        setTexture: () => {}, close: () => { root.remove(); },
      };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
    };
    ui.uiManager.setScreen('game');
    ui.renderHUD();
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function setTarget(opts: { id?: number; stackSize?: number; containerId?: number; itemType?: number; name?: string } = {}): void {
    ui.hud.setTarget({
      id: opts.id ?? 0x80001111, name: opts.name ?? 'Healing Potion',
      pluralName: opts.name ? undefined : 'Healing Potions', level: 0,
      healthFraction: 0, distance: 1, type: 'item',
      stackSize: opts.stackSize ?? 0,
      containerId: opts.containerId, itemType: opts.itemType,
    });
    ui.updateHUD();
  }
  function clearTarget(): void { ui.hud.setTarget(null); ui.updateHUD(); }
  const entryEl = () => ui.targetStackEntry as HTMLInputElement;

  const openVendor = () => ui.showVendorWindow(
    'Test Vendor',
    [{ guid: 0x80001111, weenieClassId: 10, name: 'Healing Potion', price: 40, burden: 25, stackSize: 50, itemType: 0x80 }],
    [], '1.25', '0.75', undefined, undefined, VENDOR_GUID,
  );

  it('RecvNotice_SplitStack: a selected stack of >=2 focuses the split entry and select-alls it', () => {
    clearTarget();
    setTarget({ stackSize: 40, id: 0x80002222 });
    ui.focusToolbarSplitEntry();
    expect(domWindow.document.activeElement).toBe(entryEl());
    // The focus handler mirrors retail Focus + SelectAll: inputFocused keeps
    // typed digits from firing shortcut keybinds while the entry is active.
    expect(ui.uiManager.inputFocused).toBe(true);
    entryEl().blur();
    expect(ui.uiManager.inputFocused).toBe(false);
  });

  it('RecvNotice_SplitStack: a non-stack selection (or none) is a no-op', () => {
    clearTarget();
    ui.focusToolbarSplitEntry();
    expect(domWindow.document.activeElement).not.toBe(entryEl());
    setTarget({ stackSize: 1, id: 0x80003333, name: 'Iron Dagger' });
    ui.focusToolbarSplitEntry();
    expect(domWindow.document.activeElement).not.toBe(entryEl());
    expect(ui.uiManager.inputFocused).toBe(false);
  });

  it("an examine of a shop item resolves to the open vendor's merchandise row (IdentifyObject reaches ACE's Vendor.TryGetItemForSale), and only while it is open", async () => {
    const { targetResolves } = await import('@ac/shared');
    const where = { inPack: () => false, worn: () => false, inOpenContainer: () => false, inWorld: () => false, forSale: (g: number) => !!ui.vendorStockItem(g) };
    expect(targetResolves(0x80001111, 0x50000001, where)).toBe(false); // no vendor open: the gate drops it, as before
    openVendor();
    expect(ui.vendorStockItem(0x80001111)?.name).toBe('Healing Potion');
    expect(targetResolves(0x80001111, 0x50000001, where)).toBe(true);
    expect(targetResolves(0x80009999, 0x50000001, where)).toBe(false);
    ui.hideVendorWindow();
    expect(ui.vendorStockItem(0x80001111)).toBeUndefined();
  });

  it('vendor branch: a stack in the OPEN vendor container with itemType in mask 0xdc41cb0 seeds splitSize=1', () => {
    clearTarget();
    openVendor();
    setTarget({ stackSize: 50, id: 0x80001111, containerId: VENDOR_GUID, itemType: 0x80 /* Misc — in mask */ });
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 1, maxSplitSize: 50 });
    expect(entryEl().value).toBe('1');
    ui.hideVendorWindow();
  });

  it('vendor branch: itemType outside the mask (MissileWeapon 0x100) seeds the FULL stack', () => {
    clearTarget();
    openVendor();
    setTarget({ stackSize: 100, id: 0x80004444, containerId: VENDOR_GUID, itemType: 0x100, name: 'Arrow' });
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 100, maxSplitSize: 100 });
    ui.hideVendorWindow();
  });

  it('vendor branch: a stack NOT contained by the vendor seeds full even with a mask itemType', () => {
    clearTarget();
    openVendor();
    setTarget({ stackSize: 30, id: 0x80005555, containerId: 0x50009999, itemType: 0x80 });
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 30, maxSplitSize: 30 });
    ui.hideVendorWindow();
  });

  it('vendor branch: with the vendor CLOSED the same selection seeds full (vendorID cleared on close)', () => {
    clearTarget();
    openVendor();
    ui.hideVendorWindow();
    setTarget({ stackSize: 50, id: 0x80006666, containerId: VENDOR_GUID, itemType: 0x80 });
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 50, maxSplitSize: 50 });
  });

  it('selection change to a NON-stack resets splitSize/maxSplitSize to 1/1 (@ 004bf6e8), never leaking stale amounts', () => {
    clearTarget();
    setTarget({ stackSize: 40, id: 0x80007777 });
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 40, maxSplitSize: 40 });
    setTarget({ stackSize: 0, id: 0x80008888, name: 'Iron Dagger' });
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 1, maxSplitSize: 1 });
  });

  it('seedVendorSelection (vendor row click) sets the global selection with vendor containerId + itemType', () => {
    clearTarget();
    openVendor();
    let selectedCb = 0;
    ui.setVendorCallbacks({ onSelectItem: (guid: number) => { selectedCb = guid; } });
    ui.seedVendorSelection(
      { guid: 0x80001111, name: 'Healing Potion', pluralName: 'Healing Potions', stackSize: 50, itemType: 0x80, iconDid: 0x060010d2 },
      true,
    );
    expect(selectedCb).toBe(0x80001111);
    expect(ui.hud.target).toMatchObject({
      id: 0x80001111, name: 'Healing Potion', type: 'item',
      stackSize: 50, containerId: VENDOR_GUID, itemType: 0x80,
    });
    // …and the seeding rule fires end-to-end: mask type in vendor → 1.
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 1, maxSplitSize: 50 });
    // Toolbar strip labels the stack "%d %hs" via the wire plural.
    expect(ui.targetNameHost.textContent).toBe('50 Healing Potions');
    ui.hideVendorWindow();
    ui.setVendorCallbacks({});
  });

  it('a sell-tab row (fromBuyTab=false) seeds no containerId → full-stack split like any owned selection', () => {
    clearTarget();
    openVendor();
    ui.seedVendorSelection({ guid: 0x80009999, name: 'Arrow', pluralName: 'Arrows', stackSize: 75, itemType: 0x100 }, false);
    expect(ui.hud.target.containerId).toBeUndefined();
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 75, maxSplitSize: 75 });
    ui.hideVendorWindow();
  });

  it('GetObjectSplitSize: the SELECTED object takes splitSize; any other object takes its full stack (0 → 1)', () => {
    clearTarget();
    openVendor();
    setTarget({ stackSize: 50, id: 0x80001111, containerId: VENDOR_GUID, itemType: 0x80 });
    // Seeded 1; the player dials the entry to 7.
    entryEl().value = '7';
    entryEl().dispatchEvent(new domWindow.Event('change', { bubbles: true }));
    expect(ui.getObjectSplitSize({ guid: 0x80001111, stackSize: 50 })).toBe(7);
    // A different (unselected) object: full stack.
    expect(ui.getObjectSplitSize({ guid: 0x8000aaaa, stackSize: 25 })).toBe(25);
    // No stack info: 1.
    expect(ui.getObjectSplitSize({ guid: 0x8000bbbb })).toBe(1);
    ui.hideVendorWindow();
  });

  it('the mask itself matches the retail constant decomposition', async () => {
    // ACE ItemType (reference/ACE/Source/ACE.Entity/Enum/ItemType.cs):
    // Creature|Food|Misc|Useless|Gem|SpellComponents|PromissoryNote|
    // CraftCookingBase|CraftAlchemyBase|0x1000000|CraftAlchemyIntermediate|
    // CraftFletchingIntermediate = 0x0dc41cb0.
    const bits = [0x10, 0x20, 0x80, 0x400, 0x800, 0x1000, 0x40000, 0x400000, 0x800000, 0x1000000, 0x4000000, 0x8000000];
    expect(bits.reduce((a, b) => a | b, 0)).toBe(MASK);
    // MissileWeapon (0x100) and Money (0x40) are NOT in the mask.
    expect(MASK & 0x100).toBe(0);
    expect(MASK & 0x40).toBe(0);
  });
});
