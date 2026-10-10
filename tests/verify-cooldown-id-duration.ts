/**
 * BUG.cooldown-id-duration-discarded — CreateObject/ApproachVendor read
 * WeenieHeaderFlag2.Cooldown (uint CooldownId) + .CooldownDuration (double)
 * and threw both away, so the retail item-icon cooldown meter
 * (UIElement_UIItem::UpdateCooldownDisplay @ 004e1e20, decomp line 217040)
 * and the appraisal "Cooldown When Used/Remaining" lines
 * (ItemExamineUI::Appraisal_ShowSpecialProperties, both strings literal in
 * the EoL binary) could never be driven.
 *
 * Retail mechanism (all pinned in packages/renderer/src/ui/cooldownMeter.ts):
 *  - ACE writes CooldownId uint + CooldownDuration double under the flags2
 *    bits (WorldObject_Networking.cs:211-215) when the weenie carries
 *    PropertyInt.SharedCooldown/PropertyFloat.CooldownDuration.
 *  - On use, ACE EnchantmentManager.StartCooldown mints a cooldown
 *    enchantment with spell id 0x8000 + CooldownId
 *    (SpellCategory_Cooldown = 0x8000, EnchantmentManager.cs:1181).
 *  - CEnchantmentRegistry::OnCooldown @ 005943c0 matches
 *    (spellId & 0xFFFF) == cooldownId + 0x8000 and outputs
 *    remaining = startTime + duration - now, dropping expired entries.
 *  - The icon overlay is one of ten full-size decile textures
 *    0x060067cf..0x060067d8 (Icon_Cooldown_10..100, elements
 *    0x1000054f..0x10000558 in LayoutDesc 0x21000037).
 *
 * This suite drives the real shipped code:
 *  1. parseCreateObject / parseApproachVendor against constructed wire
 *     bytes — values captured (uint + real float64), defaults 0, and the
 *     cursor stays framed (PetOwner after the double still parses).
 *  2. cooldownMeter pure helpers — OnCooldown mirror + decile mapping.
 *  3. buildInventoryEntry — fields reach the inventory item model.
 *  4. GameUI renderInventoryPanel (happy-dom, real GameUI) — an item whose
 *     shared cooldown is active renders the decile overlay div with the
 *     decile's DAT texture; no active cooldown -> no overlay.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { parseCreateObject, parseApproachVendor } from '../packages/network/src/MessageSerializer.js';
import {
  cooldownRemainingSeconds,
  cooldownDecile,
  cooldownOverlayTextureId,
  COOLDOWN_OVERLAY_TEXTURE_BASE,
} from '../packages/renderer/src/ui/cooldownMeter.js';
import { buildInventoryEntry } from '../packages/renderer/src/network/objectSubjectRouting.js';

// ─── Wire writer mirroring BinaryReader semantics (same as
//     verify-bug-icon-overlay-underlay-dropped.ts) ───
class Writer {
  private bytes: number[] = [];
  private get pos(): number { return this.bytes.length; }
  u8(v: number): this { this.bytes.push(v & 0xff); return this; }
  u16(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number): this {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  f64(v: number): this {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v, true);
    for (const b of new Uint8Array(dv.buffer)) this.u8(b);
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

const OBJDESC_FLAG_INCLUDES_SECOND_HEADER = 0x04000000;
const FLAG2_COOLDOWN = 0x02;
const FLAG2_COOLDOWN_DURATION = 0x04;
const FLAG2_PET_OWNER = 0x08;

function buildCreateObjectPayload(opts: {
  weenieFlags2?: number;
  cooldownId?: number;
  cooldownDuration?: number;
  petOwner?: number;
}): Uint8Array {
  const w = new Writer();
  w.u32(0x80031337); // guid
  w.u8(0x11).u8(0).u8(0).u8(0); // model header, no sub-blocks
  w.align(4);
  w.u32(0); // physFlags
  w.u32(0); // physicsState
  for (let i = 0; i < 9; i++) w.u16(0); // 9 sequence timestamps
  w.align(4);
  w.u32(0); // weenieFlags = 0 (every flag-1 conditional off)
  w.string16(''); // name
  w.packed(300); // weenieClassId
  w.packed(1); // iconId -> 0x06000001
  w.u32(0); // itemType
  const hasSecondHeader = opts.weenieFlags2 !== undefined;
  w.u32(hasSecondHeader ? OBJDESC_FLAG_INCLUDES_SECOND_HEADER : 0);
  w.align(4);
  if (hasSecondHeader) {
    const f2 = opts.weenieFlags2!;
    w.u32(f2);
    if (f2 & FLAG2_COOLDOWN) w.u32(opts.cooldownId ?? 0);
    if (f2 & FLAG2_COOLDOWN_DURATION) w.f64(opts.cooldownDuration ?? 0);
    if (f2 & FLAG2_PET_OWNER) w.u32(opts.petOwner ?? 0);
  }
  w.align(4);
  return w.toUint8Array();
}

describe('BUG.cooldown-id-duration-discarded — parseCreateObject captures CooldownId/CooldownDuration', () => {
  it('reads uint id + float64 duration off the wire and returns them', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags2: FLAG2_COOLDOWN | FLAG2_COOLDOWN_DURATION,
      cooldownId: 27,
      cooldownDuration: 180.5,
    }));
    expect(obj).not.toBeNull();
    expect(obj!.guid).toBe(0x80031337);
    expect(obj!.cooldownId).toBe(27);
    expect(obj!.cooldownDuration).toBeCloseTo(180.5, 9);
  });

  it('defaults both to 0 when the flags2 bits are absent', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({ weenieFlags2: 0 }));
    expect(obj).not.toBeNull();
    expect(obj!.cooldownId).toBe(0);
    expect(obj!.cooldownDuration).toBe(0);
  });

  it('defaults both to 0 with no second header at all', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({}));
    expect(obj).not.toBeNull();
    expect(obj!.cooldownId).toBe(0);
    expect(obj!.cooldownDuration).toBe(0);
  });

  it('RECON.object-is-attackable-port — PetOwner is captured (it was read and discarded)', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({ weenieFlags2: FLAG2_PET_OWNER, petOwner: 0x50000abc }));
    expect(obj!.petOwner).toBe(0x50000abc);
    expect(parseCreateObject(buildCreateObjectPayload({ weenieFlags2: 0 }))!.petOwner).toBe(0);
  });

  it('framing parity: the 8-byte double is consumed exactly (PetOwner after it still decodes)', () => {
    // If the duration were still read as two discarded uint32s — or as a
    // float32 — the trailing PetOwner read would misparse or overrun.
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags2: FLAG2_COOLDOWN | FLAG2_COOLDOWN_DURATION | FLAG2_PET_OWNER,
      cooldownId: 3,
      cooldownDuration: 42.25,
      petOwner: 0x50001234,
    }));
    expect(obj).not.toBeNull();
    expect(obj!.cooldownId).toBe(3);
    expect(obj!.cooldownDuration).toBeCloseTo(42.25, 9);
  });
});

describe('BUG.cooldown-id-duration-discarded — parseApproachVendor threads the fields onto VendorItemData', () => {
  function buildVendorPayload(): Uint8Array {
    const w = new Writer();
    w.u32(0x50001111); // vendorGuid
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
    w.u32(0x80002222); // item guid
    w.u32(0); // weenieFlags
    w.string16(''); // name
    w.packed(400); // weenieClassId
    w.packed(2); // iconId
    w.u32(0); // itemType
    w.u32(OBJDESC_FLAG_INCLUDES_SECOND_HEADER); // objectDescFlags
    w.align(4);
    w.u32(FLAG2_COOLDOWN | FLAG2_COOLDOWN_DURATION); // weenieFlags2
    w.u32(9); // cooldownId
    w.f64(60.0); // cooldownDuration
    w.align(4);
    return w.toUint8Array();
  }

  it('captures cooldownId/cooldownDuration per item', () => {
    const result = parseApproachVendor(buildVendorPayload());
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].cooldownId).toBe(9);
    expect(result!.items[0].cooldownDuration).toBeCloseTo(60.0, 9);
  });
});

// ─── cooldownMeter pure helpers ───

function ench(spellId: number, opts: Partial<{ isCooldown: boolean; duration: number; appliedAt: number }> = {}) {
  return { spellId, isCooldown: opts.isCooldown ?? true, duration: opts.duration ?? 100, appliedAt: opts.appliedAt ?? 0 };
}

describe('BUG.cooldown-id-duration-discarded — cooldownRemainingSeconds (OnCooldown mirror)', () => {
  it('matches (spellId & 0xFFFF) == 0x8000 + cooldownId and returns start+duration-now', () => {
    // id 27 -> spell 0x801b; applied at t=10 for 100s; now t=50 -> 60 left.
    expect(cooldownRemainingSeconds(27, [ench(0x801b, { appliedAt: 10, duration: 100 })], 50)).toBe(60);
  });

  it('ignores non-cooldown enchantments even with a matching id', () => {
    expect(cooldownRemainingSeconds(27, [ench(0x801b, { isCooldown: false })], 50)).toBe(0);
  });

  it('ignores unrelated cooldown ids', () => {
    expect(cooldownRemainingSeconds(27, [ench(0x8003)], 50)).toBe(0);
  });

  it('expired entry -> 0 (retail removes it and returns not-on-cooldown)', () => {
    expect(cooldownRemainingSeconds(27, [ench(0x801b, { appliedAt: 0, duration: 100 })], 101)).toBe(0);
  });

  it('cooldownId <= 0 -> 0 (retail gates on 0 < _cooldown_id)', () => {
    expect(cooldownRemainingSeconds(0, [ench(0x8000)], 0)).toBe(0);
  });
});

describe('BUG.cooldown-id-duration-discarded — cooldownDecile (UpdateCooldownDisplay mirror)', () => {
  const onCd = (remainingFrac: number, duration = 100) =>
    cooldownDecile(27, duration, [ench(0x801b, { appliedAt: 0, duration: duration * remainingFrac })], 0);

  it('just used (full duration remaining) -> decile 10 (Icon_Cooldown_100)', () => {
    expect(onCd(1.0)).toBe(10);
  });

  it('95% remaining -> 10, 85% -> 9, 55% -> 6', () => {
    expect(onCd(0.95)).toBe(10);
    expect(onCd(0.85)).toBe(9);
    expect(onCd(0.55)).toBe(6);
  });

  it('almost expired (5%) -> decile 1 (an overlay stays visible while unusable)', () => {
    expect(onCd(0.05)).toBe(1);
  });

  it('not on cooldown -> 0', () => {
    expect(cooldownDecile(27, 100, [], 0)).toBe(0);
  });

  it('duration <= 0 -> 0 (retail leaves the element index 0)', () => {
    expect(cooldownDecile(27, 0, [ench(0x801b, { duration: 50 })], 0)).toBe(0);
  });

  it('remaining beyond duration clamps to 10', () => {
    expect(cooldownDecile(27, 10, [ench(0x801b, { duration: 500 })], 0)).toBe(10);
  });

  it('texture ids: decile 1 -> 0x060067cf ... decile 10 -> 0x060067d8', () => {
    expect(cooldownOverlayTextureId(1)).toBe(COOLDOWN_OVERLAY_TEXTURE_BASE);
    expect(cooldownOverlayTextureId(1)).toBe(0x060067cf);
    expect(cooldownOverlayTextureId(10)).toBe(0x060067d8);
    expect(cooldownOverlayTextureId(4)).toBe(0x060067d2);
  });
});

describe('BUG.cooldown-id-duration-discarded — buildInventoryEntry carries the fields', () => {
  const base = {
    weenieClassId: 42, name: 'Black Marrow Gem', pluralName: '', value: 10, burden: 5,
    stackSize: 1, maxStackSize: 1, containerId: 0, iconId: 0x06000001,
    validLocations: 0, itemType: 0, uiEffects: 0, usable: 0,
  };

  it('threads cooldownId/cooldownDuration through', () => {
    const entry = buildInventoryEntry({ ...base, cooldownId: 27, cooldownDuration: 180 });
    expect(entry.cooldownId).toBe(27);
    expect(entry.cooldownDuration).toBe(180);
  });

  it('0 -> undefined (matches the iconOverlay/iconUnderlay normalization)', () => {
    const entry = buildInventoryEntry({ ...base, cooldownId: 0, cooldownDuration: 0 });
    expect(entry.cooldownId).toBeUndefined();
    expect(entry.cooldownDuration).toBeUndefined();
  });
});

// ─── happy-dom behavioral coverage: real GameUI decile overlay ───

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const INVENTORY_ELEMENT_IDS = [0x100001d0, 0x100001cd, 0x100001ce, 0x100001cf];

describe('BUG.cooldown-id-duration-discarded — renderInventoryPanel decile overlay (real GameUI)', () => {
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
    ui.itemIconCache.set(0x06000501, 'data:image/png;base64,GEM');
    // Prime all ten decile overlay textures.
    for (let d = 0; d < 10; d++) {
      ui.itemIconCache.set(COOLDOWN_OVERLAY_TEXTURE_BASE + d, `data:image/png;base64,CD${(d + 1) * 10}`);
    }
    ui.toggleInventory();
  });
  afterAll(() => {
    if (ui?.cooldownMeterTimer) { clearInterval(ui.cooldownMeterTimer); ui.cooldownMeterTimer = null; }
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function gemItem() {
    return {
      id: 7, weenieClassId: 902, name: 'Black Marrow Gem', value: 0, burden: 1,
      stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0,
      iconDid: 0x06000501, cooldownId: 27, cooldownDuration: 100,
    };
  }

  function firstCell(): HTMLElement {
    const gridEl = ui.inventoryPanelHandle.elements.get(0x100001cf);
    const itemGrid = gridEl.querySelector('div[style*="grid"]') as HTMLElement;
    return itemGrid.children[0] as HTMLElement;
  }

  function cellCooldownOverlays(cell: HTMLElement): HTMLElement[] {
    return [...cell.children].filter(c =>
      (c as HTMLElement).style.backgroundImage?.includes('base64,CD')) as HTMLElement[];
  }

  it('shows the full-size decile overlay while the shared cooldown is active', () => {
    // Cooldown enchantment for id 27 (spell 0x8000+27), just applied.
    ui.addEnchantment({
      spellId: 0x8000 + 27, layer: 1, name: 'Cooldown', iconId: 0,
      isBeneficial: false, isVitae: false, isCooldown: true,
      duration: 100, startTime: 0, casterGuid: 0,
    });
    ui.setInventoryData([gemItem()], [], 1, 100);

    const overlays = cellCooldownOverlays(firstCell());
    expect(overlays).toHaveLength(1);
    // Just applied -> ~100% remaining -> decile 10 texture.
    expect(overlays[0].style.backgroundImage).toContain('base64,CD100');
    expect(overlays[0].style.inset).toBe('0');
    expect(overlays[0].style.pointerEvents).toBe('none');
    // The 1s heartbeat ticker is armed while an overlay is live.
    expect(ui.cooldownMeterTimer).not.toBeNull();
  });

  it('shows no overlay for the same item once the cooldown enchantment is gone', () => {
    ui.removeEnchantment(0x8000 + 27, 1);
    ui.setInventoryData([gemItem()], [], 1, 100);
    expect(cellCooldownOverlays(firstCell())).toHaveLength(0);
  });

  it('shows no overlay for an item without a cooldownId even with cooldown enchantments active', () => {
    ui.addEnchantment({
      spellId: 0x8000 + 27, layer: 1, name: 'Cooldown', iconId: 0,
      isBeneficial: false, isVitae: false, isCooldown: true,
      duration: 100, startTime: 0, casterGuid: 0,
    });
    ui.setInventoryData([{ ...gemItem(), cooldownId: undefined, cooldownDuration: undefined }], [], 1, 100);
    expect(cellCooldownOverlays(firstCell())).toHaveLength(0);
    ui.removeEnchantment(0x8000 + 27, 1);
  });
});
