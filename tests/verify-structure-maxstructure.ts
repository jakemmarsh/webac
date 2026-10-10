/**
 * BUG.structure-maxstructure-discarded — CreateObject/ApproachVendor read
 * WeenieHeaderFlag.Structure (0x400) + .MaxStructure (0x800) ushorts and
 * threw both away, so the retail item-icon uses-remaining bar
 * (UIElement_UIItem::UpdateStructureDisplay @ 004e17a0, decomp line 216748)
 * could never be driven — a half-used healing kit or lockpick looked
 * identical to a fresh one in the pack.
 *
 * Retail mechanism (all pinned in packages/renderer/src/ui/structureBar.ts):
 *  - ACE writes Structure + MaxStructure as ushorts under the flag bits
 *    (WorldObject_Networking.cs:117-121).
 *  - UpdateStructureDisplay hides the StructureBar meter when
 *    _maxStructure == 0 or structure/maxStructure == 1.0, else shows it
 *    with fill attribute 0x69 = Clamp(structure/maxStructure, 0, 1).
 *  - The meter is element 0x10000348 in LayoutDesc 0x21000037 (UIItem
 *    template 0x10000346): a type-7 UIElement_Meter at (26,1), 5x30 in
 *    the 32x32 icon, track texture 0x06004d24, fill child texture
 *    0x06004d25, direction property p111=4 — per UIElement_Meter::
 *    DrawChildren @ 0046fbd0 case 4 the fill is clipped bottom-up.
 *  - Live drain: GameMessagePublicUpdatePropertyInt of
 *    PropertyInt.Structure = 92 (ACE Healer.cs:191, Lock.cs:94,
 *    PetDevice.cs:94; refill via PetDevice.cs:576).
 *
 * This suite drives the real shipped code:
 *  1. parseCreateObject / parseApproachVendor against constructed wire
 *     bytes — values captured as ushorts, defaults 0, framing preserved
 *     (StackSize after the two ushorts still decodes).
 *  2. structureBarFraction pure helper — UpdateStructureDisplay mirror.
 *  3. buildInventoryEntry — fields reach the inventory item model, with a
 *     real 0 structure preserved while maxStructure gates the meter.
 *  4. InventoryManager.applyPublicPropertyInt — the live-drain routing.
 *  5. applyPublicUpdatePropertyInt — the world-object mirror routing.
 *  6. GameUI renderInventoryPanel (happy-dom, real GameUI) — a half-used
 *     item renders the bar with a bottom-anchored fill at the right
 *     height; a fresh item renders no bar.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { parseCreateObject, parseApproachVendor } from '../packages/network/src/MessageSerializer.js';
import {
  structureBarFraction,
  STRUCTURE_BAR_BG_TEXTURE,
  STRUCTURE_BAR_FILL_TEXTURE,
  STRUCTURE_BAR_X,
  STRUCTURE_BAR_Y,
  STRUCTURE_BAR_W,
  STRUCTURE_BAR_H,
} from '../packages/renderer/src/ui/structureBar.js';
import { buildInventoryEntry } from '../packages/renderer/src/network/objectSubjectRouting.js';
import { InventoryManager, PropertyInt } from '../packages/shared/src/index.js';
import { applyPublicUpdatePropertyInt, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';

// ─── Wire writer mirroring BinaryReader semantics (same as
//     verify-cooldown-id-duration.ts) ───
class Writer {
  private bytes: number[] = [];
  private get pos(): number { return this.bytes.length; }
  u8(v: number): this { this.bytes.push(v & 0xff); return this; }
  u16(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number): this {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  f32(v: number): this {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v, true);
    for (const b of new Uint8Array(dv.buffer)) this.u8(b);
    return this;
  }
  /** ACE packed DWORD, 2-byte form only (value must be < 0x8000). */
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
    const totalRead = 2 + s.length;
    const rem = totalRead % 4;
    if (rem !== 0) for (let i = 0; i < 4 - rem; i++) this.u8(0);
    return this;
  }
  toUint8Array(): Uint8Array { return new Uint8Array(this.bytes); }
}

const FLAG_STRUCTURE = 0x00000400;
const FLAG_MAX_STRUCTURE = 0x00000800;
const FLAG_STACK_SIZE = 0x00001000;

function buildCreateObjectPayload(opts: {
  weenieFlags?: number;
  structure?: number;
  maxStructure?: number;
  stackSize?: number;
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
  w.string16(''); // name
  w.packed(300); // weenieClassId
  w.packed(1); // iconId -> 0x06000001
  w.u32(0); // itemType
  w.u32(0); // objectDescFlags (no second header)
  w.align(4);
  // Conditional weenie fields in parser read order — only the three under
  // test are exercised here (every other flag bit is off).
  if (flags & FLAG_STRUCTURE) w.u16(opts.structure ?? 0);
  if (flags & FLAG_MAX_STRUCTURE) w.u16(opts.maxStructure ?? 0);
  if (flags & FLAG_STACK_SIZE) w.u16(opts.stackSize ?? 0);
  w.align(4);
  return w.toUint8Array();
}

describe('BUG.structure-maxstructure-discarded — parseCreateObject captures Structure/MaxStructure', () => {
  it('reads both ushorts off the wire and returns them', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags: FLAG_STRUCTURE | FLAG_MAX_STRUCTURE,
      structure: 37,
      maxStructure: 100,
    }));
    expect(obj).not.toBeNull();
    expect(obj!.guid).toBe(0x80035555);
    expect(obj!.structure).toBe(37);
    expect(obj!.maxStructure).toBe(100);
  });

  it('defaults both to 0 when the flag bits are absent', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({}));
    expect(obj).not.toBeNull();
    expect(obj!.structure).toBe(0);
    expect(obj!.maxStructure).toBe(0);
  });

  it('framing parity: the two ushorts are consumed exactly (StackSize after them still decodes)', () => {
    // If either ushort were mis-sized, the trailing StackSize read would
    // land off-position and misparse.
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags: FLAG_STRUCTURE | FLAG_MAX_STRUCTURE | FLAG_STACK_SIZE,
      structure: 5,
      maxStructure: 50,
      stackSize: 123,
    }));
    expect(obj).not.toBeNull();
    expect(obj!.structure).toBe(5);
    expect(obj!.maxStructure).toBe(50);
    expect(obj!.stackSize).toBe(123);
  });

  it('a spent item keeps its real 0 structure alongside a nonzero maxStructure', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags: FLAG_STRUCTURE | FLAG_MAX_STRUCTURE,
      structure: 0,
      maxStructure: 30,
    }));
    expect(obj).not.toBeNull();
    expect(obj!.structure).toBe(0);
    expect(obj!.maxStructure).toBe(30);
  });
});

describe('BUG.structure-maxstructure-discarded — parseApproachVendor threads the fields onto VendorItemData', () => {
  function buildVendorPayload(): Uint8Array {
    const w = new Writer();
    w.u32(0x50003333); // vendorGuid
    w.u32(0); // merchandiseItemTypes
    w.u32(0); // merchandiseMinValue
    w.u32(0); // merchandiseMaxValue
    w.u32(0); // dealMagicalItems
    w.f32(1.0); // buyPrice
    w.f32(1.0); // sellPrice
    w.u32(0); // alternateCurrency
    w.u32(0); // altCurrencyAmount
    w.string16(''); // altCurrencyName
    w.u32(1); // numItems
    w.u32((0xff << 24) | 1); // packed pwdType=-1 + stackSize 1
    w.u32(0x80004444); // item guid
    w.u32(FLAG_STRUCTURE | FLAG_MAX_STRUCTURE); // weenieFlags
    w.string16(''); // name
    w.packed(400); // weenieClassId
    w.packed(2); // iconId
    w.u32(0); // itemType
    w.u32(0); // objectDescFlags
    w.align(4);
    w.u16(12); // structure
    w.u16(25); // maxStructure
    w.align(4);
    return w.toUint8Array();
  }

  it('captures structure/maxStructure per item', () => {
    const result = parseApproachVendor(buildVendorPayload());
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].structure).toBe(12);
    expect(result!.items[0].maxStructure).toBe(25);
  });
});

// ─── structureBar pure helper (UpdateStructureDisplay mirror) ───

describe('BUG.structure-maxstructure-discarded — structureBarFraction', () => {
  it('maxStructure 0/undefined -> null (retail hides the meter)', () => {
    expect(structureBarFraction(5, 0)).toBeNull();
    expect(structureBarFraction(5, undefined)).toBeNull();
    expect(structureBarFraction(undefined, undefined)).toBeNull();
  });

  it('ratio exactly 1.0 -> null (fresh item shows no bar)', () => {
    expect(structureBarFraction(30, 30)).toBeNull();
    expect(structureBarFraction(1, 1)).toBeNull();
  });

  it('partial -> the ratio', () => {
    expect(structureBarFraction(15, 30)).toBeCloseTo(0.5, 9);
    expect(structureBarFraction(1, 4)).toBeCloseTo(0.25, 9);
  });

  it('spent item (structure 0) -> 0, still shown as an empty bar', () => {
    expect(structureBarFraction(0, 30)).toBe(0);
  });

  it('over-full ratio clamps to 1 but is still shown (retail hides only on exact 1.0)', () => {
    expect(structureBarFraction(40, 30)).toBe(1);
  });

  it('texture/geometry constants match LayoutDesc 0x21000037 element 0x10000348', () => {
    expect(STRUCTURE_BAR_BG_TEXTURE).toBe(0x06004d24);
    expect(STRUCTURE_BAR_FILL_TEXTURE).toBe(0x06004d25);
    expect([STRUCTURE_BAR_X, STRUCTURE_BAR_Y, STRUCTURE_BAR_W, STRUCTURE_BAR_H]).toEqual([26, 1, 5, 30]);
  });
});

describe('BUG.structure-maxstructure-discarded — buildInventoryEntry carries the fields', () => {
  const base = {
    weenieClassId: 42, name: 'Healing Kit', pluralName: '', value: 10, burden: 5,
    stackSize: 1, maxStackSize: 1, containerId: 0, iconId: 0x06000001,
    validLocations: 0, itemType: 0, uiEffects: 0, usable: 0,
  };

  it('threads structure/maxStructure through', () => {
    const entry = buildInventoryEntry({ ...base, structure: 12, maxStructure: 25 });
    expect(entry.structure).toBe(12);
    expect(entry.maxStructure).toBe(25);
  });

  it('preserves a real 0 structure while maxStructure gates the meter on', () => {
    const entry = buildInventoryEntry({ ...base, structure: 0, maxStructure: 25 });
    expect(entry.structure).toBe(0);
    expect(entry.maxStructure).toBe(25);
  });

  it('maxStructure 0 -> both undefined (no uses meter)', () => {
    const entry = buildInventoryEntry({ ...base, structure: 0, maxStructure: 0 });
    expect(entry.structure).toBeUndefined();
    expect(entry.maxStructure).toBeUndefined();
  });
});

describe('BUG.structure-maxstructure-discarded — InventoryManager.applyPublicPropertyInt (live drain)', () => {
  function managerWithKit(): { inv: InventoryManager; guid: number } {
    const inv = new InventoryManager();
    const guid = 0x80005555;
    inv.addItem({
      weenieClassId: 42, name: 'Healing Kit', value: 10, burden: 5,
      stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0,
      structure: 25, maxStructure: 25,
    }, guid);
    return { inv, guid };
  }

  it('PropertyInt.Structure updates the item and reports a change', () => {
    const { inv, guid } = managerWithKit();
    expect(inv.applyPublicPropertyInt(guid, PropertyInt.Structure, 24)).toBe(true);
    expect(inv.getItem(guid)!.structure).toBe(24);
  });

  it('PropertyInt.MaxStructure updates the item (tinkered refill/raise)', () => {
    const { inv, guid } = managerWithKit();
    expect(inv.applyPublicPropertyInt(guid, PropertyInt.MaxStructure, 30)).toBe(true);
    expect(inv.getItem(guid)!.maxStructure).toBe(30);
  });

  it('unknown guid -> false, untouched', () => {
    const { inv } = managerWithKit();
    expect(inv.applyPublicPropertyInt(0xdead, PropertyInt.Structure, 1)).toBe(false);
  });

  it('unrelated key -> false, untouched', () => {
    const { inv, guid } = managerWithKit();
    expect(inv.applyPublicPropertyInt(guid, PropertyInt.Value, 999)).toBe(false);
    expect(inv.getItem(guid)!.structure).toBe(25);
  });
});

describe('BUG.structure-maxstructure-discarded — applyPublicUpdatePropertyInt (world-object mirror)', () => {
  function bareObj(): ServerObject {
    return { structure: 10, maxStructure: 10 } as unknown as ServerObject;
  }

  it('routes PropertyInt.Structure to obj.structure', () => {
    const obj = bareObj();
    applyPublicUpdatePropertyInt(obj, PropertyInt.Structure, 7);
    expect(obj.structure).toBe(7);
  });

  it('routes PropertyInt.MaxStructure to obj.maxStructure', () => {
    const obj = bareObj();
    applyPublicUpdatePropertyInt(obj, PropertyInt.MaxStructure, 50);
    expect(obj.maxStructure).toBe(50);
  });
});

// ─── happy-dom behavioral coverage: real GameUI uses-remaining bar ───

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const INVENTORY_ELEMENT_IDS = [0x100001d0, 0x100001cd, 0x100001ce, 0x100001cf];

describe('BUG.structure-maxstructure-discarded — renderInventoryPanel bar (real GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
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
    ui.itemIconCache.set(0x06000601, 'data:image/png;base64,KIT');
    ui.itemIconCache.set(STRUCTURE_BAR_BG_TEXTURE, 'data:image/png;base64,SBTRACK');
    ui.itemIconCache.set(STRUCTURE_BAR_FILL_TEXTURE, 'data:image/png;base64,SBFILL');
    ui.toggleInventory();
  });
  afterAll(() => {
    if (ui?.cooldownMeterTimer) { clearInterval(ui.cooldownMeterTimer); ui.cooldownMeterTimer = null; }
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function kitItem(structure: number, maxStructure: number) {
    return {
      id: 9, weenieClassId: 902, name: 'Healing Kit', value: 0, burden: 1,
      stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0,
      iconDid: 0x06000601, structure, maxStructure,
    };
  }

  function firstCell(): HTMLElement {
    const gridEl = ui.inventoryPanelHandle.elements.get(0x100001cf);
    const itemGrid = gridEl.querySelector('div[style*="grid"]') as HTMLElement;
    return itemGrid.children[0] as HTMLElement;
  }

  function cellBars(cell: HTMLElement): HTMLElement[] {
    return [...cell.querySelectorAll('[data-structure-bar]')] as HTMLElement[];
  }

  it('renders the bar with a bottom-anchored fill for a half-used item', () => {
    ui.setInventoryData([kitItem(15, 30)], [], 1, 100);
    const bars = cellBars(firstCell());
    expect(bars).toHaveLength(1);
    const bar = bars[0];
    // Track: 5x30 at (26,1) — 32px icon, scale 1.
    expect(bar.style.left).toBe('26px');
    expect(bar.style.top).toBe('1px');
    expect(bar.style.width).toBe('5px');
    expect(bar.style.height).toBe('30px');
    expect(bar.style.backgroundImage).toContain('base64,SBTRACK');
    // Fill: bottom-anchored window at fraction * 30px.
    const fill = bar.children[0] as HTMLElement;
    expect(fill.style.bottom).toBe('0px');
    expect(fill.style.height).toBe('15px');
    expect(fill.style.backgroundImage).toContain('base64,SBFILL');
    expect(fill.style.backgroundPosition).toBe('left bottom');
  });

  it('renders no bar for a fresh item (ratio 1.0)', () => {
    ui.setInventoryData([kitItem(30, 30)], [], 1, 100);
    expect(cellBars(firstCell())).toHaveLength(0);
  });

  it('renders an empty bar (0-height fill) for a spent item', () => {
    ui.setInventoryData([kitItem(0, 30)], [], 1, 100);
    const bars = cellBars(firstCell());
    expect(bars).toHaveLength(1);
    expect((bars[0].children[0] as HTMLElement).style.height).toBe('0px');
  });

  it('renders no bar for an item with no uses meter (maxStructure 0)', () => {
    ui.setInventoryData([kitItem(0, 0)], [], 1, 100);
    expect(cellBars(firstCell())).toHaveLength(0);
  });
});
