/**
 * GAP.86 — ApproachVendor (0x0062) had zero behavioral wire-format coverage.
 * Every existing test that touched `parseApproachVendor` (verify-ace-event-coverage,
 * verify-faithful-595-vendor-alt-currency, verify-house-restrictions-parse,
 * verify-vendor-sell-tab-refresh) is a source-text regex pin — none actually
 * drive the shipped parser with real bytes. Per CLAUDE.md "Never Break Tests":
 * source-text pins catch nothing and must be paired with a behavioral test.
 *
 * Anchors the wire format against ACE C# server-side serialization:
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventApproachVendor.cs
 *   reference/ACE/Source/ACE.Server/WorldObjects/WorldObject_Networking.cs (SerializeGameDataOnly
 *     -> SerializeCreateObject(gamedataonly: true) — the per-item weenie-header shape)
 *
 * Vendor header: guid u32, merchandiseItemTypes u32, merchandiseMinValue u32,
 * merchandiseMaxValue u32, dealMagicalItems u32(bool), buyPrice f32, sellPrice f32,
 * alternateCurrency u32, [always] altCurrencyAmount u32 + altCurrencyName String16L,
 * numItems u32, then numItems x (packed stack/pwdType u32 + GameDataOnly weenie block).
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameMessageOpcode, GameEventType } from '@ac/network';
import type { ApproachVendorData } from '@ac/network';

function event(eventType: number, payload: Uint8Array, headerObjectGuid = 0x50001111) {
  return {
    type: 'event' as const,
    opcode: GameMessageOpcode.GameEvent as GameMessageOpcode.GameEvent,
    objectGuid: headerObjectGuid,
    sequence: 1,
    eventType,
    payload,
  };
}

/** WeenieHeaderFlag bits used below (MessageSerializer.ts's `const enum` isn't exported). */
const WHF_PLURAL_NAME = 0x00000001;
const WHF_VALUE = 0x00000008;
const WHF_USABLE = 0x00000010;
const WHF_UI_EFFECTS = 0x00000080;
const WHF_COMBAT_USE = 0x00000200;
const WHF_STACK_SIZE = 0x00001000;
const WHF_MAX_STACK_SIZE = 0x00002000;
const WHF_BURDEN = 0x00200000;

function writeVendorHeader(w: BinaryWriter, opts: {
  vendorGuid: number; itemTypes: number; minValue: number; maxValue: number;
  dealMagical: boolean; buyPrice: number; sellPrice: number;
  altCurrency: number; altCurrencyAmount: number; altCurrencyName: string;
  numItems: number;
}) {
  w.writeUInt32(opts.vendorGuid);
  w.writeUInt32(opts.itemTypes);
  w.writeUInt32(opts.minValue);
  w.writeUInt32(opts.maxValue);
  w.writeUInt32(opts.dealMagical ? 1 : 0);
  w.writeFloat32(opts.buyPrice);
  w.writeFloat32(opts.sellPrice);
  w.writeUInt32(opts.altCurrency);
  w.writeUInt32(opts.altCurrencyAmount);
  w.writeString16(opts.altCurrencyName);
  w.writeUInt32(opts.numItems);
}

/**
 * Writes one vendor merchandise item: packed (stackSize & 0xFFFFFF | 0xFF000000)
 * header + the GameDataOnly weenie block (guid, weenieFlags, name, weenieClassId
 * packed, iconId packed-of-known-type 0x06000000, itemType, objDescFlags, align,
 * then conditional fields gated by weenieFlags, then a final align).
 */
function writeVendorItem(w: BinaryWriter, opts: {
  packedStackSize: number; // value written into the low 24 bits pre-pwdType-tag
  guid: number; name: string; weenieClassId: number; iconId: number; itemType: number;
  weenieFlags: number; pluralName?: string; value?: number; stackSize?: number; maxStackSize?: number; burden?: number;
  uiEffects?: number; usable?: number; combatUse?: number;
}) {
  const packed = ((opts.packedStackSize & 0x00FFFFFF) | 0xFF000000) >>> 0;
  w.writeUInt32(packed);

  w.writeUInt32(opts.guid);
  w.writeUInt32(opts.weenieFlags);
  w.writeString16(opts.name);
  w.writeUInt16(opts.weenieClassId); // packed dword, single-word form (< 0x8000)
  w.writeUInt16(opts.iconId - 0x06000000); // packed dword of known type 0x06000000
  w.writeUInt32(opts.itemType);
  w.writeUInt32(0); // objectDescFlags — no IncludesSecondHeader bit, so no weenieFlags2 word follows
  // align(4) after objectDescFlags: 4 fixed u32s (guid,flags,classId-as-u16,iconId-as-u16=4B,itemType,descFlags)
  // handled implicitly below by re-deriving from writer position isn't available; pad manually.
  alignWriter(w);

  // CORE.10.f — PluralName is the FIRST conditional weenie field (ACE
  // SerializeCreateObject writes it right after the header block).
  if (opts.weenieFlags & WHF_PLURAL_NAME) w.writeString16(opts.pluralName ?? '');
  if (opts.weenieFlags & WHF_VALUE) w.writeUInt32(opts.value ?? 0);
  if (opts.weenieFlags & WHF_USABLE) w.writeUInt32(opts.usable ?? 0);
  if (opts.weenieFlags & WHF_UI_EFFECTS) w.writeUInt32(opts.uiEffects ?? 0);
  if (opts.weenieFlags & WHF_COMBAT_USE) w.writeUInt8((opts.combatUse ?? 0) & 0xff);
  if (opts.weenieFlags & WHF_STACK_SIZE) w.writeUInt16(opts.stackSize ?? 0);
  if (opts.weenieFlags & WHF_MAX_STACK_SIZE) w.writeUInt16(opts.maxStackSize ?? 0);
  if (opts.weenieFlags & WHF_BURDEN) w.writeUInt16(opts.burden ?? 0);

  alignWriter(w);
}

function alignWriter(w: BinaryWriter) {
  const rem = w.position % 4;
  if (rem !== 0) {
    for (let i = 0; i < 4 - rem; i++) w.writeUInt8(0);
  }
}

describe('ApproachVendor (0x0062) wire format — ACE-anchored, behavioral', () => {
  it('parses the vendor header with zero merchandise and no alt currency', () => {
    const h = new ServerMessageHandler();
    let cap: { vendorGuid: number; parsed: ApproachVendorData | null } | null = null;
    h.setHandlers({ onApproachVendor: (d: any) => { cap = d; } });

    const w = new BinaryWriter(64);
    writeVendorHeader(w, {
      vendorGuid: 0x50001111, itemTypes: 0x3fffffff, minValue: 0, maxValue: 1000000,
      dealMagical: true, buyPrice: 1.25, sellPrice: 0.5,
      altCurrency: 0, altCurrencyAmount: 0, altCurrencyName: '',
      numItems: 0,
    });

    h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer()));

    expect(cap).not.toBeNull();
    const parsed = cap!.parsed!;
    expect(parsed).not.toBeNull();
    expect(parsed.vendorGuid).toBe(0x50001111);
    expect(parsed.merchandiseItemTypes).toBe(0x3fffffff);
    expect(parsed.merchandiseMinValue).toBe(0);
    expect(parsed.merchandiseMaxValue).toBe(1000000);
    expect(parsed.dealMagicalItems).toBe(true);
    expect(parsed.buyPrice).toBeCloseTo(1.25, 5);
    expect(parsed.sellPrice).toBeCloseTo(0.5, 5);
    expect(parsed.alternateCurrency).toBe(0);
    expect(parsed.altCurrencyAmount).toBe(0);
    expect(parsed.altCurrencyName).toBe('');
    expect(parsed.items).toHaveLength(0);
  });

  it('parses non-zero alternate currency fields (FAITHFUL.595 wire shape)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onApproachVendor: (d: any) => { cap = d; } });

    const w = new BinaryWriter(64);
    writeVendorHeader(w, {
      vendorGuid: 0x50002222, itemTypes: 1, minValue: 0, maxValue: 500,
      dealMagical: false, buyPrice: 2.0, sellPrice: 0.25,
      altCurrency: 0x38000123, altCurrencyAmount: 47, altCurrencyName: 'Trade Notes',
      numItems: 0,
    });

    h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer()));

    const parsed = cap.parsed as ApproachVendorData;
    expect(parsed.alternateCurrency).toBe(0x38000123);
    expect(parsed.altCurrencyAmount).toBe(47);
    expect(parsed.altCurrencyName).toBe('Trade Notes');
  });

  it('parses a merchandise item with Value/StackSize/MaxStackSize/Burden weenie fields', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onApproachVendor: (d: any) => { cap = d; } });

    const w = new BinaryWriter(128);
    writeVendorHeader(w, {
      vendorGuid: 0x50003333, itemTypes: 1, minValue: 0, maxValue: 500,
      dealMagical: false, buyPrice: 1.0, sellPrice: 0.4,
      altCurrency: 0, altCurrencyAmount: 0, altCurrencyName: '',
      numItems: 1,
    });
    writeVendorItem(w, {
      packedStackSize: 7, // finite vendor-side stack — should be overridden by the weenie StackSize field below
      guid: 0x50100001, name: 'Iron Longsword', weenieClassId: 1234, iconId: 0x06001a2b,
      itemType: 2,
      weenieFlags: WHF_VALUE | WHF_STACK_SIZE | WHF_MAX_STACK_SIZE | WHF_BURDEN,
      value: 250, stackSize: 3, maxStackSize: 20, burden: 150,
    });

    h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer()));

    const parsed = cap.parsed as ApproachVendorData;
    expect(parsed.items).toHaveLength(1);
    const item = parsed.items[0];
    expect(item.guid).toBe(0x50100001);
    expect(item.name).toBe('Iron Longsword');
    expect(item.weenieClassId).toBe(1234);
    expect(item.iconId).toBe(0x06001a2b);
    expect(item.itemType).toBe(2);
    expect(item.value).toBe(250);
    expect(item.burden).toBe(150);
    expect(item.maxStackSize).toBe(20);
    // The weenie's own StackSize field (3) wins over the vendor-packed fallback (7).
    expect(item.stackSize).toBe(3);
    // No PluralName flag → undefined (client-side +s/+es fallthrough applies).
    expect(item.pluralName).toBeUndefined();
  });

  it('CORE.10.f — captures PluralName (first conditional field) without disturbing later fields', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onApproachVendor: (d: any) => { cap = d; } });

    const w = new BinaryWriter(160);
    writeVendorHeader(w, {
      vendorGuid: 0x50006666, itemTypes: 1, minValue: 0, maxValue: 500,
      dealMagical: false, buyPrice: 1.0, sellPrice: 0.4,
      altCurrency: 0, altCurrencyAmount: 0, altCurrencyName: '',
      numItems: 1,
    });
    writeVendorItem(w, {
      packedStackSize: 0,
      guid: 0x50100003, name: 'Healing Potion', weenieClassId: 640, iconId: 0x060010d2,
      itemType: 0x80,
      weenieFlags: WHF_PLURAL_NAME | WHF_VALUE | WHF_STACK_SIZE | WHF_MAX_STACK_SIZE | WHF_BURDEN,
      pluralName: 'Healing Potions', value: 40, stackSize: 50, maxStackSize: 100, burden: 25,
    });

    h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer()));

    const item = (cap.parsed as ApproachVendorData).items[0];
    expect(item.pluralName).toBe('Healing Potions');
    // Pre-fix the string was read-and-discarded; the fields AFTER it must
    // still land byte-correct with the capture in place.
    expect(item.name).toBe('Healing Potion');
    expect(item.value).toBe(40);
    expect(item.stackSize).toBe(50);
    expect(item.maxStackSize).toBe(100);
    expect(item.burden).toBe(25);
  });

  it('CORE.18.c.a — captures UiEffects (the merchandise cell\'s RenderIcons tint) without disturbing later fields', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onApproachVendor: (d: any) => { cap = d; } });

    const w = new BinaryWriter(160);
    writeVendorHeader(w, {
      vendorGuid: 0x50007777, itemTypes: 2, minValue: 0, maxValue: 500,
      dealMagical: true, buyPrice: 1.0, sellPrice: 0.4,
      altCurrency: 0, altCurrencyAmount: 0, altCurrencyName: '',
      numItems: 2,
    });
    writeVendorItem(w, {
      packedStackSize: 0,
      guid: 0x50100010, name: 'Enchanted Cap', weenieClassId: 700, iconId: 0x06001351,
      itemType: 2, weenieFlags: WHF_VALUE | WHF_UI_EFFECTS | WHF_STACK_SIZE | WHF_BURDEN,
      value: 900, uiEffects: 0x1, stackSize: 1, burden: 75,
    });
    writeVendorItem(w, {
      packedStackSize: 0,
      guid: 0x50100011, name: 'Plain Cap', weenieClassId: 701, iconId: 0x06001351,
      itemType: 2, weenieFlags: WHF_VALUE | WHF_BURDEN, value: 90, burden: 75,
    });

    h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer()));

    const [magic, plain] = (cap.parsed as ApproachVendorData).items;
    expect(magic.uiEffects).toBe(0x1);
    expect(magic.value).toBe(900);
    expect(magic.stackSize).toBe(1);
    expect(magic.burden).toBe(75);
    // The next item still parses byte-correct; no flag → 0.
    expect(plain.name).toBe('Plain Cap');
    expect(plain.uiEffects).toBe(0);
    expect(plain.value).toBe(90);
  });

  it('SWEEP1006B toolbar Use button — captures Usable and CombatUse without disturbing later fields', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onApproachVendor: (d: any) => { cap = d; } });
    const w = new BinaryWriter(160);
    writeVendorHeader(w, {
      vendorGuid: 0x50007778, itemTypes: 1, minValue: 0, maxValue: 500,
      dealMagical: true, buyPrice: 1.0, sellPrice: 0.4,
      altCurrency: 0, altCurrencyAmount: 0, altCurrencyName: '',
      numItems: 2,
    });
    writeVendorItem(w, {
      packedStackSize: 0,
      guid: 0x50100020, name: 'Dagger', weenieClassId: 702, iconId: 0x06001351,
      itemType: 1, weenieFlags: WHF_VALUE | WHF_USABLE | WHF_COMBAT_USE | WHF_STACK_SIZE | WHF_BURDEN,
      value: 50, usable: 1, combatUse: 1, stackSize: 1, burden: 60,
    });
    writeVendorItem(w, {
      packedStackSize: 0,
      guid: 0x50100021, name: 'Rock', weenieClassId: 703, iconId: 0x06001351,
      itemType: 0x80, weenieFlags: WHF_VALUE | WHF_BURDEN, value: 1, burden: 5,
    });
    h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer()));
    const [dagger, rock] = (cap.parsed as ApproachVendorData).items;
    expect(dagger.usable).toBe(1);
    expect(dagger.combatUse).toBe(1);
    expect(dagger.stackSize).toBe(1);
    expect(dagger.burden).toBe(60);
    expect(rock.name).toBe('Rock');
    expect(rock.usable).toBe(0);
    expect(rock.combatUse).toBe(0);
    expect(rock.burden).toBe(5);
  });

  it('falls back to the vendor-packed stack size when the weenie has no StackSize field', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onApproachVendor: (d: any) => { cap = d; } });

    const w = new BinaryWriter(128);
    writeVendorHeader(w, {
      vendorGuid: 0x50004444, itemTypes: 1, minValue: 0, maxValue: 500,
      dealMagical: false, buyPrice: 1.0, sellPrice: 0.4,
      altCurrency: 0, altCurrencyAmount: 0, altCurrencyName: '',
      numItems: 1,
    });
    writeVendorItem(w, {
      packedStackSize: 9,
      guid: 0x50100002, name: 'Arrow', weenieClassId: 500, iconId: 0x06002000,
      itemType: 1,
      weenieFlags: 0, // no StackSize flag at all
    });

    h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer()));

    const item = (cap.parsed as ApproachVendorData).items[0];
    expect(item.stackSize).toBe(9);
  });

  it('decodes the vendor-packed stack size as -1 (unlimited supply) when the low 24 bits are all set', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onApproachVendor: (d: any) => { cap = d; } });

    const w = new BinaryWriter(128);
    writeVendorHeader(w, {
      vendorGuid: 0x50005555, itemTypes: 1, minValue: 0, maxValue: 500,
      dealMagical: false, buyPrice: 1.0, sellPrice: 0.4,
      altCurrency: 0, altCurrencyAmount: 0, altCurrencyName: '',
      numItems: 1,
    });
    writeVendorItem(w, {
      packedStackSize: 0xFFFFFF, // ACE: (uint)(-1) & 0xFFFFFF == 0xFFFFFF -> unlimited supply
      guid: 0x50100003, name: 'Bulk Reagent', weenieClassId: 900, iconId: 0x06003000,
      itemType: 1,
      weenieFlags: 0,
    });

    h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer()));

    const item = (cap.parsed as ApproachVendorData).items[0];
    expect(item.stackSize).toBe(-1);
  });

  it('parses multiple merchandise items in sequence (loop advances the cursor correctly)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onApproachVendor: (d: any) => { cap = d; } });

    const w = new BinaryWriter(256);
    writeVendorHeader(w, {
      vendorGuid: 0x50006666, itemTypes: 1, minValue: 0, maxValue: 500,
      dealMagical: false, buyPrice: 1.0, sellPrice: 0.4,
      altCurrency: 0, altCurrencyAmount: 0, altCurrencyName: '',
      numItems: 2,
    });
    writeVendorItem(w, {
      packedStackSize: 1,
      guid: 0x50100010, name: 'First Item', weenieClassId: 100, iconId: 0x06004000,
      itemType: 1, weenieFlags: WHF_VALUE, value: 10,
    });
    writeVendorItem(w, {
      packedStackSize: 1,
      guid: 0x50100011, name: 'Second Item - longer name to shift alignment', weenieClassId: 200, iconId: 0x06004001,
      itemType: 1, weenieFlags: WHF_VALUE | WHF_BURDEN, value: 20, burden: 5,
    });

    h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer()));

    const parsed = cap.parsed as ApproachVendorData;
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].name).toBe('First Item');
    expect(parsed.items[0].value).toBe(10);
    expect(parsed.items[1].name).toBe('Second Item - longer name to shift alignment');
    expect(parsed.items[1].value).toBe(20);
    expect(parsed.items[1].burden).toBe(5);
  });

  it('BUG.approach-vendor-no-per-item-recovery: keeps the vendor header + already-parsed ' +
     'items when a LATER merchandise entry is truncated, instead of discarding the whole message', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onApproachVendor: (d: any) => { cap = d; } });

    const w = new BinaryWriter(256);
    // numItems claims 3, but only 1 valid item is actually written — the 2nd
    // item's packed-stack u32 read runs off the end of the buffer and throws.
    writeVendorHeader(w, {
      vendorGuid: 0x50008888, itemTypes: 1, minValue: 0, maxValue: 500,
      dealMagical: false, buyPrice: 1.0, sellPrice: 0.4,
      altCurrency: 0x38000456, altCurrencyAmount: 12, altCurrencyName: 'Notes',
      numItems: 3,
    });
    writeVendorItem(w, {
      packedStackSize: 1,
      guid: 0x50100020, name: 'Good Item', weenieClassId: 300, iconId: 0x06005000,
      itemType: 1, weenieFlags: WHF_VALUE, value: 42,
    });
    // Deliberately no bytes for item 2 or item 3.

    expect(() => h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer()))).not.toThrow();

    expect(cap.parsed).not.toBeNull();
    const parsed = cap.parsed as ApproachVendorData;
    // Header fields survive — pre-fix, the outer catch discarded these too.
    expect(parsed.vendorGuid).toBe(0x50008888);
    expect(parsed.alternateCurrency).toBe(0x38000456);
    expect(parsed.altCurrencyName).toBe('Notes');
    // Only the successfully-parsed item before the truncation is kept.
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].name).toBe('Good Item');
    expect(parsed.items[0].value).toBe(42);
  });

  it('returns null on truncated/malformed payload instead of throwing', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onApproachVendor: (d: any) => { cap = d; } });

    const w = new BinaryWriter(16);
    w.writeUInt32(0x50007777);
    // Truncated — no more fields, but numItems etc. are claimed elsewhere in the format.
    expect(() => h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer()))).not.toThrow();
    expect(cap.parsed).toBeNull();
    // With no parse result, the top-level vendorGuid falls back to 0 rather than
    // leaking the (always-wrong, per below) header objectGuid.
    expect(cap.vendorGuid).toBe(0);
  });

  it('top-level vendorGuid comes from the payload, never from the GameEvent header objectGuid ' +
     '(GameEventMessage.cs base ctor always writes session.Player.Guid into the header field for ' +
     'every GameEvent type, so it is never the vendor guid — regression test for the same dead-field ' +
     'mislabeling class the GAP.86 ViewContents fix addressed)', () => {
    const h = new ServerMessageHandler();
    let cap: { vendorGuid: number; parsed: ApproachVendorData | null } | null = null;
    h.setHandlers({ onApproachVendor: (d: any) => { cap = d; } });

    const w = new BinaryWriter(64);
    writeVendorHeader(w, {
      vendorGuid: 0x50009999, itemTypes: 1, minValue: 0, maxValue: 100,
      dealMagical: false, buyPrice: 1.0, sellPrice: 0.5,
      altCurrency: 0, altCurrencyAmount: 0, altCurrencyName: '',
      numItems: 0,
    });

    // Deliberately different from the payload's vendor guid (0x50009999) — mirrors the
    // real server, which always sets this header field to the player's own guid, never
    // the vendor's.
    h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer(), 0xDEADBEEF));

    expect(cap).not.toBeNull();
    expect(cap!.vendorGuid).toBe(0x50009999);
    expect(cap!.vendorGuid).not.toBe(0xDEADBEEF);
    expect(cap!.parsed!.vendorGuid).toBe(cap!.vendorGuid);
  });
});

describe('BUG.ac1999-appraisal-details — a ware keeps the weenie fields its examine reads', () => {
  it('AmmoType / ValidLocations / Priority are kept (they were read and dropped)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onApproachVendor: (d: any) => { cap = d; } });
    const w = new BinaryWriter(256);
    writeVendorHeader(w, {
      vendorGuid: 0x50003333, itemTypes: 0x100, minValue: 0, maxValue: 10000, dealMagical: false,
      buyPrice: 1.35, sellPrice: 0.6, altCurrency: 0, altCurrencyAmount: 0, altCurrencyName: '', numItems: 2,
    });
    const ware = (guid: number, name: string, flags: number, fields: (w: BinaryWriter) => void) => {
      w.writeUInt32(0xffffffff); // unlimited stock
      w.writeUInt32(guid); w.writeUInt32(flags); w.writeString16(name);
      w.writeUInt16(363); w.writeUInt16(0x1234); w.writeUInt32(0x100); w.writeUInt32(0);
      alignWriter(w);
      fields(w);
      alignWriter(w);
    };
    // A bow: AmmoType 0x100 (u16, before Value), Value 0x8, ValidLocations 0x10000.
    ware(0x80000101, 'Yumi', 0x100 | 0x8 | 0x10000, (x) => { x.writeUInt16(1); x.writeUInt32(400); x.writeUInt32(0x400000); });
    // A coat: Value, ValidLocations, Priority 0x40000, then Burden 0x200000.
    ware(0x80000102, 'Coat', 0x8 | 0x10000 | 0x40000 | 0x200000, (x) => { x.writeUInt32(90); x.writeUInt32(0x600); x.writeUInt32(0x6); x.writeUInt16(250); });
    h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer()));
    const [bow, coat] = (cap.parsed as ApproachVendorData).items;
    expect([bow.name, bow.ammoType, bow.value, bow.validLocations, bow.clothingPriority]).toEqual(['Yumi', 1, 400, 0x400000, 0]);
    expect([coat.name, coat.value, coat.validLocations, coat.clothingPriority, coat.burden]).toEqual(['Coat', 90, 0x600, 0x6, 250]);
  });
});
