/**
 * CORE.17.o.a — an openable side pack renders a FIXED grid of the pack's
 * own ItemsCapacity cells, not visible-area padding.
 *
 * Retail ground truth (decompiled EoL client):
 *  - UIElement_ItemList::ItemList_UpdateContainerListSize @ 004e39e0
 *    (decomp :218818): capacity = pwd._itemsCapacity of the list's parent
 *    container; when the container's bitfield lacks Openable (0x1) and it
 *    is not the player, capacity = 0; capacity < 0 → attribute 0x10000015
 *    = -1 + UpdateEmptySlots, else attribute = capacity + UpdateFixedSlots.
 *  - UIElement_ItemList::UpdateFixedSlots @ 004e3910 (:218766): grows or
 *    trims the list to EXACTLY the attribute (empty state 0x1000001c).
 *  - UIElement_ItemList::UpdateEmptySlots @ 004e3700 (:218663): pads the
 *    visible area ONLY while the attribute is -1.
 *  - PublicWeenieDesc::UnPack @ 005ad470 (:414533 / :414997): _itemsCapacity
 *    = 0 unless WeenieHeaderFlag.ItemsCapacity (0x2) carries the byte, read
 *    as a SIGNED char — the world DB's -1 containers arrive as 0xff = -1.
 *  - ACE WorldObject_Networking.cs:90 / :722 writes the byte when
 *    ItemCapacity is non-null (every ACE pack weenie: 24), and
 *    UpdateObjectDescriptionFlags sets Openable on an unlocked Container.
 *
 * Pre-fix: parseCreateObject consumed and dropped the byte, InventoryItem
 * carried no capacity, and GameUI padded every side pack to the reflowed
 * viewport (54 cells at the then-stretched dock) — a 24-slot pack drew nine rows.
 *
 * This suite drives the shipped code:
 *  1. parseCreateObject against constructed wire bytes.
 *  2. buildInventoryEntry — the Openable gate.
 *  3. GameUI.renderInventoryPanel (happy-dom, real GameUI) — the cell count
 *     per pack kind.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { parseCreateObject } from '../packages/network/src/MessageSerializer.js';
import { buildInventoryEntry } from '../packages/renderer/src/network/objectSubjectRouting.js';
import { ObjectDescriptionFlag } from '../packages/shared/src/index.js';

// ─── Wire writer mirroring BinaryReader semantics (same as
//     verify-structure-maxstructure.ts) ───
class Writer {
  private bytes: number[] = [];
  private get pos(): number { return this.bytes.length; }
  u8(v: number): this { this.bytes.push(v & 0xff); return this; }
  u16(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number): this {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  packed(v: number): this {
    if (v >= 0x8000) throw new Error('packed() helper only supports the 2-byte form');
    return this.u16(v);
  }
  align(boundary = 4): this {
    const rem = this.pos % boundary;
    if (rem !== 0) for (let i = 0; i < boundary - rem; i++) this.u8(0);
    return this;
  }
  string16(s: string): this {
    this.u16(s.length);
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    const rem = (2 + s.length) % 4;
    if (rem !== 0) for (let i = 0; i < 4 - rem; i++) this.u8(0);
    return this;
  }
  toUint8Array(): Uint8Array { return new Uint8Array(this.bytes); }
}

const FLAG_ITEMS_CAPACITY = 0x00000002;
const FLAG_CONTAINERS_CAPACITY = 0x00000004;
const FLAG_VALUE = 0x00000008;
const FLAG_CONTAINER = 0x00004000;

function buildCreateObjectPayload(opts: {
  weenieFlags?: number;
  objectDescFlags?: number;
  itemsCapacity?: number;
  containersCapacity?: number;
  value?: number;
  containerId?: number;
}): Uint8Array {
  const w = new Writer();
  w.u32(0x80035555); // guid
  w.u8(0x11).u8(0).u8(0).u8(0); // model header, no sub-blocks
  w.align(4);
  w.u32(0); // physFlags
  w.u32(0); // physicsState
  for (let i = 0; i < 9; i++) w.u16(0); // 9 sequence timestamps
  w.align(4);
  const flags = opts.weenieFlags ?? 0;
  w.u32(flags);
  w.string16('Pack'); // name
  w.packed(136); // weenieClassId (backpack)
  w.packed(1); // iconId -> 0x06000001
  w.u32(0x200); // itemType Container
  w.u32(opts.objectDescFlags ?? 0); // objectDescFlags (no second header)
  w.align(4);
  // Conditional weenie fields in parser read order.
  if (flags & FLAG_ITEMS_CAPACITY) w.u8(opts.itemsCapacity ?? 0);
  if (flags & FLAG_CONTAINERS_CAPACITY) w.u8(opts.containersCapacity ?? 0);
  if (flags & FLAG_VALUE) w.u32(opts.value ?? 0);
  if (flags & FLAG_CONTAINER) w.u32(opts.containerId ?? 0);
  w.align(4);
  return w.toUint8Array();
}

describe('CORE.17.o.a — parseCreateObject captures WeenieHeaderFlag.ItemsCapacity', () => {
  it('reads the byte off the wire and returns it', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags: FLAG_ITEMS_CAPACITY, itemsCapacity: 24,
    }));
    expect(obj).not.toBeNull();
    expect(obj!.guid).toBe(0x80035555);
    expect(obj!.itemsCapacity).toBe(24);
  });

  it('reads the byte SIGNED like PublicWeenieDesc::UnPack (char): a world-DB -1 container arrives as 0xff and decodes to -1', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags: FLAG_ITEMS_CAPACITY, itemsCapacity: 0xff,
    }));
    expect(obj!.itemsCapacity).toBe(-1);
  });

  it('defaults to 0 when the flag bit is absent (the retail PublicWeenieDesc unpack default)', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({}));
    expect(obj!.itemsCapacity).toBe(0);
  });

  it('framing parity: the byte is consumed exactly (ContainersCapacity, Value and Container after it still decode)', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags: FLAG_ITEMS_CAPACITY | FLAG_CONTAINERS_CAPACITY | FLAG_VALUE | FLAG_CONTAINER,
      itemsCapacity: 24, containersCapacity: 0, value: 1234, containerId: 0x50000001,
    }));
    expect(obj!.itemsCapacity).toBe(24);
    expect(obj!.value).toBe(1234);
    expect(obj!.containerId).toBe(0x50000001);
  });

  it('the Openable bit rides objectDescFlags alongside it', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags: FLAG_ITEMS_CAPACITY, itemsCapacity: 24, objectDescFlags: ObjectDescriptionFlag.Openable,
    }));
    expect(obj!.objectDescFlags & ObjectDescriptionFlag.Openable).toBe(ObjectDescriptionFlag.Openable);
  });
});

describe('CORE.17.o.a — buildInventoryEntry applies the ItemList_UpdateContainerListSize Openable gate', () => {
  const base = {
    weenieClassId: 136, name: 'Pack', value: 10, burden: 100, stackSize: 1, maxStackSize: 1,
    containerId: 0x50000001, iconId: 0x06000001, validLocations: 0, itemType: 0x200, uiEffects: 0, usable: 0,
  };

  it('an openable container keeps its wire capacity', () => {
    const entry = buildInventoryEntry({ ...base, objectDescFlags: ObjectDescriptionFlag.Openable, itemsCapacity: 24 });
    expect(entry.itemsCapacity).toBe(24);
  });

  it('a non-openable container (no Openable bit) resolves to undefined — its grid keeps the visible-area padding', () => {
    const entry = buildInventoryEntry({ ...base, objectDescFlags: 0, itemsCapacity: 24 });
    expect(entry.itemsCapacity).toBeUndefined();
  });

  it('an openable container with no capacity on the wire keeps the unpack default 0 (a real fixed count of zero)', () => {
    const entry = buildInventoryEntry({ ...base, objectDescFlags: ObjectDescriptionFlag.Openable, itemsCapacity: 0 });
    expect(entry.itemsCapacity).toBe(0);
  });

  it('an openable container with the signed -1 keeps it (a chest opened as a container: attribute -1, visible-area padding)', () => {
    const entry = buildInventoryEntry({ ...base, objectDescFlags: ObjectDescriptionFlag.Openable, itemsCapacity: -1 });
    expect(entry.itemsCapacity).toBe(-1);
  });

  it('a fixture without the fields (older callers) is unaffected', () => {
    const entry = buildInventoryEntry(base);
    expect(entry.itemsCapacity).toBeUndefined();
  });
});

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

describe('CORE.17.o.a — GameUI.renderInventoryPanel sizes the open side pack from its capacity', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  let ui: any;
  const PLAYER_GUID = 0x50000001;
  const PACK_GUID = 0x8000ff01;
  const GRID_EMPTY_TILE = 0x06004d20;

  function stubLayoutRenderer() {
    return {
      renderPanel: (_layoutId: number, container: HTMLElement) => {
        const wrapper = domWindow.document.createElement('div');
        container.appendChild(wrapper);
        const root = domWindow.document.createElement('div');
        wrapper.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [0x100001cc, 0x100001cd, 0x100001ce, 0x100001cf, 0x100001d0]) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return { root, elements, setText: () => {}, close: () => { wrapper.remove(); } };
      },
    };
  }

  function item(id: number, name: string, containerId: number, itemType = 0, extra: Record<string, unknown> = {}) {
    return {
      id, weenieClassId: id & 0xffff, name, value: 1, burden: 10, iconDid: 0,
      stackSize: 1, maxStackSize: 1, stackable: false, containerId, itemType, ...extra,
    };
  }

  const gridArea = (): HTMLElement => ui.inventoryPanelHandle.elements.get(0x100001cf);
  const gridCells = (): HTMLElement[] => [...(gridArea().querySelector('div[style*="grid"]') as HTMLElement).children] as HTMLElement[];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = stubLayoutRenderer();
    ui.uiTextures.set(GRID_EMPTY_TILE, 'data:image/png;base64,tex6004d20');
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function open(pack: Record<string, unknown>, packContents = 1) {
    const items = [item(0x8000aaaa, 'Dagger', PLAYER_GUID), pack];
    for (let i = 0; i < packContents; i++) items.push(item(0x8000b000 + i, `Apple ${i}`, PACK_GUID));
    ui.setSidePackGuids([PLAYER_GUID, PACK_GUID]);
    ui.setInventoryData(items, [], 30, 15000);
    ui.selectedPackSlot = 1;
    ui.hud.setTarget(null);
    if (!ui.inventoryVisible) ui.toggleInventory();
    else ui.renderInventoryPanel();
  }

  beforeEach(() => { ui.selectedPackSlot = 0; });

  it('an openable pack with ItemsCapacity 24 renders exactly 24 cells — four rows of six, not the 3-row viewport padding', () => {
    open(item(PACK_GUID, 'Leather Pack', PLAYER_GUID, 0x200, { itemsCapacity: 24 }));
    const cells = gridCells();
    expect(cells.length).toBe(24);
    // the one Apple occupies cell 0; the rest are the empty-state tiles
    expect(cells[0].style.backgroundImage || '').not.toContain('tex6004d20');
    expect(cells[1].style.backgroundImage).toContain('tex6004d20');
    expect(cells[23].style.backgroundImage).toContain('tex6004d20');
  });

  it('the fixed count follows the pack, not the player: a 12-cell pack renders 12', () => {
    open(item(PACK_GUID, 'Small Pouch', PLAYER_GUID, 0x200, { itemsCapacity: 12 }));
    expect(gridCells().length).toBe(12);
  });

  it('a pack whose capacity is unknown (not Openable → undefined) keeps the visible-area padding (18 cells: the default panels-window body 3-row viewport, CORE.18.e)', () => {
    open(item(PACK_GUID, 'Locked Pack', PLAYER_GUID, 0x200));
    expect(gridCells().length).toBe(18);
  });

  it('an openable pack whose capacity is the signed -1 keeps the visible-area padding (attribute -1 → UpdateEmptySlots)', () => {
    open(item(PACK_GUID, 'Odd Chest', PLAYER_GUID, 0x200, { itemsCapacity: -1 }));
    expect(gridCells().length).toBe(18);
  });

  it('an openable pack with capacity 0 renders only its occupied cells (UpdateFixedSlots trims to the attribute)', () => {
    open(item(PACK_GUID, 'Odd Pack', PLAYER_GUID, 0x200, { itemsCapacity: 0 }), 2);
    expect(gridCells().length).toBe(2);
  });

  it('the main pack is untouched: slot 0 still shows the player ItemsCapacity (102)', () => {
    open(item(PACK_GUID, 'Leather Pack', PLAYER_GUID, 0x200, { itemsCapacity: 24 }));
    ui.selectedPackSlot = 0;
    ui.renderInventoryPanel();
    expect(gridCells().length).toBe(102);
  });
});
