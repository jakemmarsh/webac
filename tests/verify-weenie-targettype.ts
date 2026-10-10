/**
 * BUG.weenie-targettype-discarded — CreateObject/ApproachVendor read the
 * WeenieHeaderFlag.TargetType (0x80000) uint and threw it away, so no
 * consumer could perform retail's client-side use-with-target
 * compatibility check and every armed targeted use (healing kit, key,
 * lockpick) was shipped to the server regardless of the clicked target.
 *
 * Retail ground truth:
 *  - ACE writes `(uint?)TargetType ?? 0u` under the flag bit
 *    (WorldObject_Networking.cs:108-109), set only when the property is
 *    non-null (:739-740). PropertyInt.TargetType = 94.
 *  - ItemHolder::TargetCompatibleWithObject @ 00587520 (decomp line
 *    376447): after useability/ownership/trade gates, accept iff
 *    `source.pwd._targetType & target->GetItemType()` is non-zero; on
 *    mismatch send interface notice 0x1a with the acclient.exe wide-string
 *    literal "Cannot use the %s with the %s" and never send the request.
 *
 * This suite drives the real shipped code:
 *  1. parseCreateObject / parseApproachVendor against constructed wire
 *     bytes — value captured, default 0, framing preserved (StackSize
 *     after the uint still decodes).
 *  2. isUseTargetCompatible pure helper — the retail mask gate, including
 *     the targetType==0 no-restriction case and the Gameboard sign bit.
 *  3. buildCannotUseMessage — the exact retail literal.
 *  4. buildInventoryEntry — the field reaches the inventory item model
 *     (0 normalizes to undefined, matching ACE null semantics).
 */
import { describe, it, expect } from 'vitest';
import { parseCreateObject, parseApproachVendor } from '../packages/network/src/MessageSerializer.js';
import { buildInventoryEntry } from '../packages/renderer/src/network/objectSubjectRouting.js';
import { isUseTargetCompatible, buildCannotUseMessage } from '../packages/shared/src/weenie-types.js';
import { ItemType } from '../packages/shared/src/game-types.js';

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

const FLAG_TARGET_TYPE = 0x00080000;
const FLAG_STACK_SIZE = 0x00001000;

function buildCreateObjectPayload(opts: {
  weenieFlags?: number;
  targetType?: number;
  stackSize?: number;
}): Uint8Array {
  const w = new Writer();
  w.u32(0x80036666); // guid
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
  // Conditional weenie fields in parser read order — only the two under
  // test are exercised here (every other flag bit is off).
  if (flags & FLAG_TARGET_TYPE) w.u32(opts.targetType ?? 0);
  if (flags & FLAG_STACK_SIZE) w.u16(opts.stackSize ?? 0);
  w.align(4);
  return w.toUint8Array();
}

describe('BUG.weenie-targettype-discarded — parseCreateObject captures TargetType', () => {
  it('reads the uint off the wire and returns it', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags: FLAG_TARGET_TYPE,
      targetType: ItemType.Creature,
    }));
    expect(obj).not.toBeNull();
    expect(obj!.guid).toBe(0x80036666);
    expect(obj!.targetType).toBe(ItemType.Creature);
  });

  it('defaults to 0 (no restriction) when the flag bit is absent — ACE null semantics', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({}));
    expect(obj).not.toBeNull();
    expect(obj!.targetType).toBe(0);
  });

  it('framing parity: the uint is consumed exactly (StackSize after it still decodes)', () => {
    // If the field were mis-sized, the trailing StackSize read would land
    // off-position and misparse.
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags: FLAG_TARGET_TYPE | FLAG_STACK_SIZE,
      targetType: ItemType.Creature | ItemType.Lockable,
      stackSize: 77,
    }));
    expect(obj).not.toBeNull();
    expect(obj!.targetType).toBe(ItemType.Creature | ItemType.Lockable);
    expect(obj!.stackSize).toBe(77);
  });

  it('a multi-bit ItemType mask round-trips (key: Lockable|Container-style masks)', () => {
    const mask = ItemType.Container | ItemType.Lockable | ItemType.Misc;
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags: FLAG_TARGET_TYPE,
      targetType: mask,
    }));
    expect(obj!.targetType).toBe(mask);
  });
});

describe('BUG.weenie-targettype-discarded — parseApproachVendor threads targetType onto VendorItemData', () => {
  function buildVendorPayload(targetType: number): Uint8Array {
    const w = new Writer();
    w.u32(0x50004444); // vendorGuid
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
    w.u32(0x80005555); // item guid
    w.u32(FLAG_TARGET_TYPE); // weenieFlags
    w.string16(''); // name
    w.packed(400); // weenieClassId
    w.packed(2); // iconId
    w.u32(0); // itemType
    w.u32(0); // objectDescFlags
    w.align(4);
    w.u32(targetType);
    w.align(4);
    return w.toUint8Array();
  }

  it('captures the vendor item targetType', () => {
    const result = parseApproachVendor(buildVendorPayload(ItemType.Creature));
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].targetType).toBe(ItemType.Creature);
  });
});

describe('BUG.weenie-targettype-discarded — isUseTargetCompatible (TargetCompatibleWithObject @ 00587520 mask gate)', () => {
  it('accepts when source mask overlaps target itemType (healing kit -> creature)', () => {
    expect(isUseTargetCompatible(ItemType.Creature, ItemType.Creature)).toBe(true);
  });

  it('rejects when there is no overlap (healing kit -> chest)', () => {
    expect(isUseTargetCompatible(ItemType.Creature, ItemType.Container | ItemType.Lockable)).toBe(false);
  });

  it('accepts any single overlapping bit in a multi-bit mask (key -> locked door)', () => {
    const keyMask = ItemType.Container | ItemType.Lockable;
    expect(isUseTargetCompatible(keyMask, ItemType.Lockable)).toBe(true);
  });

  it('targetType 0 / undefined = no restriction (ACE writes the flag only when non-null)', () => {
    expect(isUseTargetCompatible(0, ItemType.MeleeWeapon)).toBe(true);
    expect(isUseTargetCompatible(undefined, ItemType.Creature)).toBe(true);
  });

  it('handles the Gameboard sign bit without signed-coercion false negatives', () => {
    // ItemType.Gameboard = 0x80000000: JS 32-bit & yields a negative int;
    // the helper must still treat the overlap as non-zero.
    expect(isUseTargetCompatible(ItemType.Gameboard, ItemType.Gameboard)).toBe(true);
    expect(isUseTargetCompatible(ItemType.Gameboard, ItemType.Creature)).toBe(false);
  });
});

describe('BUG.weenie-targettype-discarded — buildCannotUseMessage (acclient.exe literal)', () => {
  it('formats the retail rejection notice "Cannot use the %s with the %s"', () => {
    expect(buildCannotUseMessage('Handy Healing Kit', 'Wooden Chest'))
      .toBe('Cannot use the Handy Healing Kit with the Wooden Chest');
  });
});

describe('BUG.weenie-targettype-discarded — buildInventoryEntry threads targetType into the item model', () => {
  const base = {
    weenieClassId: 628,
    name: 'Handy Healing Kit',
    value: 150,
    burden: 165,
    stackSize: 1,
    maxStackSize: 1,
    containerId: 0,
    iconId: 0x06000f2d,
    validLocations: 0,
    itemType: ItemType.Misc,
    uiEffects: 0,
    usable: 0x00100000, // target mask bits set — use-with-target item
  };

  it('a nonzero targetType reaches the inventory item', () => {
    const entry = buildInventoryEntry({ ...base, targetType: ItemType.Creature });
    expect(entry.targetType).toBe(ItemType.Creature);
  });

  it('targetType 0 normalizes to undefined (no restriction, ACE null)', () => {
    const entry = buildInventoryEntry({ ...base, targetType: 0 });
    expect(entry.targetType).toBeUndefined();
  });

  it('absent targetType (older fixture source) normalizes to undefined', () => {
    const entry = buildInventoryEntry(base);
    expect(entry.targetType).toBeUndefined();
  });
});
