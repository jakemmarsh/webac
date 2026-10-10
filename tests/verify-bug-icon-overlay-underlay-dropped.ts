/**
 * BUG.icon-overlay-underlay-dropped — CreateObject's IconOverlayId/
 * IconUnderlayId were parsed then discarded (packages/network/src/
 * MessageSerializer.ts parseCreateObject + parseApproachVendor both read
 * `WeenieHeaderFlag.IconOverlay` / `WeenieHeaderFlag2.IconUnderlay` off the
 * wire via readPackedDwordOfKnownType and threw the return value away).
 * No consumer anywhere composited overlay/underlay onto the base icon, so
 * rare items never got their gold glow underlay (ACE Corpse.cs:341-342
 * stamps 0x6005B0C) and tiered loot never showed its Item Max Level
 * overlay badge (ACE LootGenerationFactory_Aetheria.cs:29).
 *
 * PropertyDataId wire values (reference/ACE/Source/ACE.Entity/Enum/
 * Properties/PropertyDataId.cs:69-71): IconOverlay=50, IconOverlaySecondary
 * =51 (unused — ACE never sends it, no client consumer needed), IconUnderlay
 * =52.
 *
 * This suite drives the real shipped code end to end:
 *  1. parseCreateObject / parseApproachVendor against constructed wire bytes
 *     (mirroring the exact field order in MessageSerializer.ts) — confirms
 *     the values are captured, not discarded, and default to 0 when the
 *     flag bits are absent.
 *  2. ServerObjectManager.createObject() — confirms CreateObjectData's new
 *     fields land on the ServerObject.
 *  3. applyPropertyDataIdUpdate() — the pure PropertyDataId->field mapping
 *     extracted from main.ts's onPublicUpdatePropertyDataID switch (so a
 *     live IconOverlay/IconUnderlay broadcast, e.g. an Aetheria tier-up,
 *     updates the mirror without a re-enter-visual-range round trip).
 *  4. GameUI.buildItemIconElement() (happy-dom) — confirms the actual
 *     compositing markup: underlay full-size behind the base icon, overlay
 *     a full-size layer on top of it (CORE.18.c.a), and the plain single-div
 *     fallback when neither is present.
 *  5. renderInventoryPanel (happy-dom, real GameUI) — confirms an inventory
 *     item carrying iconOverlayDid/iconUnderlayDid actually renders the
 *     composited element in its slot.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { parseCreateObject, parseApproachVendor } from '../packages/network/src/MessageSerializer.js';

// ─── Minimal wire-format writer mirroring BinaryReader's exact semantics
//     (packages/network/src/MessageSerializer.ts) for the CreateObject /
//     ApproachVendor weenie-data section. ───
class Writer {
  private bytes: number[] = [];
  private get pos(): number { return this.bytes.length; }
  u8(v: number): this { this.bytes.push(v & 0xff); return this; }
  u16(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number): this {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  /** ACE packed DWORD, 2-byte form only (value must be < 0x8000). */
  packed(v: number): this {
    if (v >= 0x8000) throw new Error('packed() helper only supports the 2-byte form in this test');
    return this.u16(v);
  }
  align(boundary = 4): this {
    const rem = this.pos % boundary;
    if (rem !== 0) for (let i = 0; i < boundary - rem; i++) this.u8(0);
    return this;
  }
  /** Matches BinaryReader.readString16's own internal 4-byte alignment. */
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

const WEENIE_FLAG_ICON_OVERLAY = 0x40000000;
const WEENIE_FLAG2_ICON_UNDERLAY = 0x01;
const OBJDESC_FLAG_INCLUDES_SECOND_HEADER = 0x04000000;

/**
 * Build a minimal CreateObject payload (guid + empty model data + all-zero
 * PhysicsDesc + bare weenie header) with the given weenieFlags/weenieFlags2,
 * optionally followed by the IconOverlay/IconUnderlay packed DIDs when
 * those flag bits are set. Every other conditional weenie field is off, so
 * the writer only needs to emit exactly what parseCreateObject will read.
 */
function buildCreateObjectPayload(opts: {
  weenieFlags: number;
  weenieFlags2?: number;
  overlayRaw?: number;
  underlayRaw?: number;
}): Uint8Array {
  const w = new Writer();
  w.u32(0x80009999); // guid
  w.u8(0x11).u8(0).u8(0).u8(0); // modelByte, numSubPalettes, numTexChanges, numAnimParts
  w.align(4);
  w.u32(0); // physFlags
  w.u32(0); // physicsState
  for (let i = 0; i < 9; i++) w.u16(0); // 9 sequence timestamps
  w.align(4);
  w.u32(opts.weenieFlags);
  w.string16(''); // name
  w.packed(300); // weenieClassId
  w.packed(1); // iconId -> 0x06000001
  w.u32(0); // itemType
  const hasSecondHeader = opts.weenieFlags2 !== undefined;
  w.u32(hasSecondHeader ? OBJDESC_FLAG_INCLUDES_SECOND_HEADER : 0); // objectDescFlags
  w.align(4);
  if (hasSecondHeader) w.u32(opts.weenieFlags2!);
  // Conditional weenie fields: everything between iconId and IconOverlay is
  // gated off by construction (weenieFlags only ever carries IconOverlay
  // in these tests). IconOverlay/IconUnderlay themselves:
  if (opts.weenieFlags & WEENIE_FLAG_ICON_OVERLAY) w.packed(opts.overlayRaw ?? 0);
  if (hasSecondHeader && (opts.weenieFlags2! & WEENIE_FLAG2_ICON_UNDERLAY)) w.packed(opts.underlayRaw ?? 0);
  w.align(4);
  return w.toUint8Array();
}

describe('BUG.icon-overlay-underlay-dropped — parseCreateObject captures IconOverlay/IconUnderlay', () => {
  it('reads both DIDs off the wire and returns them (not discarded)', () => {
    const payload = buildCreateObjectPayload({
      weenieFlags: WEENIE_FLAG_ICON_OVERLAY,
      weenieFlags2: WEENIE_FLAG2_ICON_UNDERLAY,
      overlayRaw: 0x1234,
      underlayRaw: 0x5678,
    });
    const obj = parseCreateObject(payload);
    expect(obj).not.toBeNull();
    expect(obj!.guid).toBe(0x80009999);
    expect(obj!.iconId).toBe(0x06000001);
    expect(obj!.iconOverlayId).toBe(0x06001234);
    expect(obj!.iconUnderlayId).toBe(0x06005678);
  });

  it('defaults both DIDs to 0 when neither flag bit is set', () => {
    const payload = buildCreateObjectPayload({ weenieFlags: 0 });
    const obj = parseCreateObject(payload);
    expect(obj).not.toBeNull();
    expect(obj!.iconOverlayId).toBe(0);
    expect(obj!.iconUnderlayId).toBe(0);
  });

  it('captures IconOverlay alone (no second header / IconUnderlay)', () => {
    const payload = buildCreateObjectPayload({
      weenieFlags: WEENIE_FLAG_ICON_OVERLAY,
      overlayRaw: 0x0c34,
    });
    const obj = parseCreateObject(payload);
    expect(obj).not.toBeNull();
    expect(obj!.iconOverlayId).toBe(0x06000c34);
    expect(obj!.iconUnderlayId).toBe(0);
  });
});

describe('BUG.icon-overlay-underlay-dropped — parseApproachVendor captures the same fields', () => {
  function buildVendorPayload(): Uint8Array {
    const w = new Writer();
    w.u32(0x50001111); // vendorGuid
    w.u32(0); // merchandiseItemTypes
    w.u32(0); // merchandiseMinValue
    w.u32(0); // merchandiseMaxValue
    w.u32(0); // dealMagicalItems
    // buyPrice/sellPrice: float32, use raw bytes for 1.0
    const f = new DataView(new ArrayBuffer(4));
    f.setFloat32(0, 1.0, true);
    for (const b of new Uint8Array(f.buffer)) w.u8(b);
    for (const b of new Uint8Array(f.buffer)) w.u8(b);
    w.u32(0); // alternateCurrency
    w.u32(0); // altCurrencyAmount
    w.string16(''); // altCurrencyName
    w.u32(1); // numItems

    // One item: packed stack (pwdType=-1 upper byte, stackSize=1)
    w.u32((0xff << 24) | 1);
    w.u32(0x80002222); // item guid
    w.u32(WEENIE_FLAG_ICON_OVERLAY); // weenieFlags
    w.string16(''); // name
    w.packed(400); // weenieClassId
    w.packed(2); // iconId -> 0x06000002
    w.u32(0); // itemType
    w.u32(OBJDESC_FLAG_INCLUDES_SECOND_HEADER); // objectDescFlags
    w.align(4);
    w.u32(WEENIE_FLAG2_ICON_UNDERLAY); // weenieFlags2
    w.packed(0x0aaa); // iconOverlayId raw -> 0x06000aaa
    w.packed(0x0bbb); // iconUnderlayId raw -> 0x06000bbb
    w.align(4);
    return w.toUint8Array();
  }

  it('threads iconOverlayId/iconUnderlayId onto each VendorItemData entry', () => {
    const result = parseApproachVendor(buildVendorPayload());
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].iconId).toBe(0x06000002);
    expect(result!.items[0].iconOverlayId).toBe(0x06000aaa);
    expect(result!.items[0].iconUnderlayId).toBe(0x06000bbb);
  });
});

describe('BUG.icon-overlay-underlay-dropped — ServerObjectManager.createObject()', () => {
  async function makeSOM() {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    const scene = { add: () => {}, remove: () => {} };
    const setupModelRenderer = { createSetupMeshWithOverrides: () => null, loadSetupModel: () => null };
    const appearanceManager = { loadPaletteColors: () => null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new ServerObjectManager(setupModelRenderer as any, appearanceManager as any, scene as any);
  }

  function baseData(overrides: Record<string, unknown> = {}) {
    return {
      guid: 0x80005555, name: 'Test Rare', weenieClassId: 300, itemType: 0,
      position: null, setupId: 0, motionTableId: 0, iconId: 0x06000001,
      physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
      basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
      containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0,
      validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0,
      uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0, velocityZ: 0,
      soundTableId: 0, objScale: 1.0, translucency: 0, defaultScript: 0,
      defaultScriptIntensity: 1.0, iconOverlayId: 0, iconUnderlayId: 0,
      ...overrides,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('carries CreateObjectData.iconOverlayId/iconUnderlayId onto the ServerObject', async () => {
    const som = await makeSOM();
    const obj = som.createObject(baseData({ iconOverlayId: 0x06001234, iconUnderlayId: 0x06005678 }));
    expect(obj).not.toBeNull();
    expect(obj!.iconOverlayId).toBe(0x06001234);
    expect(obj!.iconUnderlayId).toBe(0x06005678);
  });

  it('defaults to 0, not undefined, when the wire sent neither', async () => {
    const som = await makeSOM();
    const obj = som.createObject(baseData());
    expect(obj).not.toBeNull();
    expect(obj!.iconOverlayId).toBe(0);
    expect(obj!.iconUnderlayId).toBe(0);
  });
});

describe('BUG.icon-overlay-underlay-dropped — applyPropertyDataIdUpdate (live PublicUpdatePropertyDataID)', () => {
  async function importFn() {
    const mod = await import('../packages/renderer/src/world/ServerObjectManager.js');
    return mod.applyPropertyDataIdUpdate;
  }

  function baseObj() {
    return {
      guid: 1, name: '', weenieClassId: 0, setupId: 0, iconId: 0, itemType: 0,
      physicsState: 0, position: null, worldX: 0, worldY: 0, worldZ: 0,
      radarColor: 0, radarBehavior: 0, usable: 0, mesh: null, basePalette: 0,
      subPalettes: [], textureChanges: [], animPartChanges: [], motionTableId: 0,
      soundTableId: 0, objectDescFlags: 0, wielderId: 0, wieldedLocation: 0,
      parentLocation: 0,
      collisionRadius: 0,
      cellId: 0, healthCurrent: 0, healthMax: 0, staminaCurrent: 0,
      staminaMax: 0, manaCurrent: 0, manaMax: 0, value: 0, burden: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('key=50 (PropertyDataId.IconOverlay) updates obj.iconOverlayId', async () => {
    const apply = await importFn();
    const obj = baseObj();
    apply(obj, 50, 0x06009999);
    expect(obj.iconOverlayId).toBe(0x06009999);
    expect(obj.iconUnderlayId).toBeUndefined();
  });

  it('key=52 (PropertyDataId.IconUnderlay) updates obj.iconUnderlayId', async () => {
    const apply = await importFn();
    const obj = baseObj();
    apply(obj, 52, 0x0600aaaa);
    expect(obj.iconUnderlayId).toBe(0x0600aaaa);
    expect(obj.iconOverlayId).toBeUndefined();
  });

  it('existing keys (1/2/3/8) still map to their pre-existing fields', async () => {
    const apply = await importFn();
    const obj = baseObj();
    apply(obj, 1, 0x02000010);
    apply(obj, 2, 0x09000020);
    apply(obj, 3, 0x20000030);
    apply(obj, 8, 0x06000040);
    expect(obj.setupId).toBe(0x02000010);
    expect(obj.motionTableId).toBe(0x09000020);
    expect(obj.soundTableId).toBe(0x20000030);
    expect(obj.iconId).toBe(0x06000040);
  });

  it('an unrecognized key is a no-op', async () => {
    const apply = await importFn();
    const obj = baseObj();
    const before = { ...obj };
    apply(obj, 999, 42);
    expect(obj).toEqual(before);
  });
});

// ─── happy-dom behavioral coverage: real GameUI compositing markup ───

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('BUG.icon-overlay-underlay-dropped — GameUI.buildItemIconElement (behavioral, real GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  // Prime the private lazy icon cache directly — same mechanism
  // getItemIconURL uses internally, avoiding the need for a real DAT
  // texture manager just to exercise the compositing markup.
  function primeIcon(did: number, url: string): void {
    ui.itemIconCache.set(did, url);
  }

  it('returns null when the base icon cannot be resolved', () => {
    expect(ui.buildItemIconElement(0x06fffffe, 32)).toBeNull();
  });

  it('with no overlay/underlay: returns a single plain icon div (pre-fix markup preserved)', () => {
    primeIcon(0x06000101, 'data:image/png;base64,BASE');
    const el = ui.buildItemIconElement(0x06000101, 32);
    expect(el).not.toBeNull();
    expect(el.children.length).toBe(0);
    expect(el.style.backgroundImage).toContain('data:image/png;base64,BASE');
    expect(el.style.position).not.toBe('relative');
  });

  it('with underlay + overlay: layers underlay behind, base icon, full-size overlay on top', () => {
    primeIcon(0x06000201, 'data:image/png;base64,BASE2');
    primeIcon(0x06000202, 'data:image/png;base64,OVERLAY');
    primeIcon(0x06000203, 'data:image/png;base64,UNDERLAY');
    const el = ui.buildItemIconElement(0x06000201, 32, 0x06000202, 0x06000203);
    expect(el).not.toBeNull();
    expect(el.style.position).toBe('relative');
    expect(el.children.length).toBe(3);
    const [underlay, base, overlay] = [...el.children] as HTMLElement[];
    expect(underlay.style.backgroundImage).toContain('data:image/png;base64,UNDERLAY');
    expect(base.style.backgroundImage).toContain('data:image/png;base64,BASE2');
    expect(overlay.style.backgroundImage).toContain('data:image/png;base64,OVERLAY');
    // CORE.18.c.a — IconData::RenderIcons @ 0058d180 blits the overlay
    // (Blit_4Alpha) at the icon's origin over the whole 32x32 surface: the
    // Aetheria tier textures (0x06006c34..) are 32x32 with the numeral drawn
    // in their corner, so the pre-fix 14-px top-right badge shrank the whole
    // overlay into the corner. Overlay and underlay both fill the icon area
    // (DOM order = paint order: underlay, base, overlay).
    expect(overlay.style.inset).toBe('0');
    expect(overlay.style.backgroundSize).toBe('32px 32px');
    expect(underlay.style.inset).toBe('0');
  });

  it('with only an underlay (no overlay): still wraps (rare item, no tiered badge)', () => {
    primeIcon(0x06000301, 'data:image/png;base64,BASE3');
    primeIcon(0x06000302, 'data:image/png;base64,RAREGLOW');
    const el = ui.buildItemIconElement(0x06000301, 32, undefined, 0x06000302);
    expect(el).not.toBeNull();
    expect(el.children.length).toBe(2);
  });
});

const INVENTORY_ELEMENT_IDS = [0x100001d0, 0x100001cd, 0x100001ce, 0x100001cf];

describe('BUG.icon-overlay-underlay-dropped — renderInventoryPanel composites real inventory items', () => {
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
    ui.itemIconCache.set(0x06000401, 'data:image/png;base64,ITEM');
    ui.itemIconCache.set(0x06000402, 'data:image/png;base64,BADGE');
    ui.itemIconCache.set(0x06000403, 'data:image/png;base64,GLOW');
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('a rare/tiered item in the pack renders the composited (underlay+base+overlay) element, not a plain icon', () => {
    ui.toggleInventory();
    ui.setInventoryData(
      [{
        id: 1, weenieClassId: 900, name: 'Rare Aetheria', value: 0, burden: 1,
        stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0,
        iconDid: 0x06000401, iconOverlayDid: 0x06000402, iconUnderlayDid: 0x06000403,
      }],
      [], 1, 100,
    );

    const gridEl = ui.inventoryPanelHandle.elements.get(0x100001cf);
    // CORE.1 — the grid now sits inside the (15,20) list viewport with a
    // contents label above it (retail layout 0x21000021).
    const itemGrid = gridEl.querySelector('div[style*="grid"]') as HTMLElement;
    const firstCell = itemGrid.children[0] as HTMLElement;
    // The icon element is the composited wrapper: position:relative, 3 layered children.
    const iconEl = firstCell.children[0] as HTMLElement;
    expect(iconEl.style.position).toBe('relative');
    expect(iconEl.children.length).toBe(3);
  });

  it('a plain item (no overlay/underlay) still renders the single-div fallback', () => {
    ui.setInventoryData(
      [{
        id: 2, weenieClassId: 901, name: 'Plain Dagger', value: 0, burden: 1,
        stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0,
        iconDid: 0x06000401,
      }],
      [], 1, 100,
    );
    const gridEl = ui.inventoryPanelHandle.elements.get(0x100001cf);
    const itemGrid = gridEl.querySelector('div[style*="grid"]') as HTMLElement;
    const firstCell = itemGrid.children[0] as HTMLElement;
    const iconEl = firstCell.children[0] as HTMLElement;
    expect(iconEl.children.length).toBe(0);
  });
});
