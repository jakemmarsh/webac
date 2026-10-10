/**
 * FAITHFUL.401 — Sibling of FAITHFUL.400 for the Int64 / Bool / Float
 * property maps in PlayerDescription.
 *
 * Consumer wiring in main.ts seeds playerState/playerAfk/vitals regen
 * rates from these maps for the handful of keys ACE's login snapshot
 * actually [SendOnLogin]-tags (per SendOnLoginProperties.cs's reflection
 * over the attribute):
 *   Int64:  AvailableLuminance (6), MaximumLuminance (7)
 *   Bool:   IsAdvocate (47), IsPsr (97), SpellComponentsRequired (68)
 *   Float:  HealthRate (3), StaminaRate (4), ManaRate (5)
 *
 * BUG.itemtotalxp-monarch-login-seed-unreachable and
 * BUG.afk-ignorehousebarriers-login-seed-unreachable found that four prior
 * reads — Int64 ItemTotalXp (4), InstanceId Monarch (26, covered by
 * verify-bug-patron-allegiance-instance-id-dropped.ts), and Bool Afk (110) /
 * IgnoreHouseBarriers (25) — were dead code: ACE's
 * GameEventPlayerDescription.cs filters every property bucket to
 * SendOnLoginProperties before it ever reaches the wire, and none of these
 * keys carry [SendOnLogin] (PropertyInt64.cs: ItemTotalXp is
 * [AssessmentProperty] only; PropertyBool.cs: Afk is [Ephemeral] only and
 * IgnoreHouseBarriers carries no attribute at all), so
 * `desc.propertiesInt64.get(ItemTotalXp)` / `desc.propertiesBool.get(Afk)` /
 * `desc.propertiesBool.get(IgnoreHouseBarriers)` were always undefined at
 * login. All four reads were deleted from main.ts, which is why none of
 * them are asserted "present" below.
 *
 * This test drives the real wire parser (not a source-text regex over
 * main.ts) to prove two things: (1) the SendOnLogin-tagged keys parse
 * correctly out of the Int64/Bool/Double hash tables ACE actually sends,
 * and (2) a hash table that omits the non-SendOnLogin keys — the actual
 * shape of ACE's login payload — leaves those getters `undefined`, which
 * is the structural reason the deleted reads could never do anything.
 */
import { describe, it, expect } from 'vitest';
import { parsePlayerDescription } from '../packages/renderer/src/network/PlayerDescriptionParser';
import { DescriptionPropertyFlag, PropertyInt64 } from '@ac/shared';

const PF_INT64 = DescriptionPropertyFlag.PropertyInt64;
const PF_BOOL = DescriptionPropertyFlag.PropertyBool;
const PF_DOUBLE = DescriptionPropertyFlag.PropertyDouble;

const PROP_ITEM_TOTAL_XP = 4;
const PROP_AVAILABLE_LUMINANCE = 6;
const PROP_MAXIMUM_LUMINANCE = 7;

const PROP_AFK = 110;
const PROP_IS_ADVOCATE = 47;
const PROP_IS_PSR = 97;
const PROP_IGNORE_HOUSE_BARRIERS = 25;
const PROP_SPELL_COMPONENTS_REQUIRED = 68;

const PROP_HEALTH_RATE = 3;
const PROP_STAMINA_RATE = 4;
const PROP_MANA_RATE = 5;

class PayloadWriter {
  private buf = new ArrayBuffer(4096);
  private dv = new DataView(this.buf);
  private p = 0;
  u16(v: number): this { this.dv.setUint16(this.p, v, true); this.p += 2; return this; }
  u32(v: number): this { this.dv.setUint32(this.p, v, true); this.p += 4; return this; }
  i64(v: bigint): this { this.dv.setBigInt64(this.p, v, true); this.p += 8; return this; }
  f64(v: number): this { this.dv.setFloat64(this.p, v, true); this.p += 8; return this; }
  bytes(): Uint8Array { return new Uint8Array(this.buf, 0, this.p); }
}

// header: propertyFlags(u32) + weenieType(u32)
function header(w: PayloadWriter, propertyFlags: number): void {
  w.u32(propertyFlags).u32(0);
}

// Unconditional trailing fields every payload must reach regardless of
// which flag-gated blocks ran, matching the wire layout precedent in
// verify-bug-patron-allegiance-instance-id-dropped.ts.
function trailer(w: PayloadWriter, co1Sentinel: number): void {
  w.u32(0).u32(0); // vectorFlags=0, hasHealth=0 — skip every VF_* block
  w.u32(0); // optionFlags=0
  w.u32(co1Sentinel); // CharacterOptions1
  w.u32(0); // SpellLists8 placeholder (CHAR_OPT_SPELL_LISTS_8 unset)
  w.u32(0); // spellbookFilters
  w.u32(0); // inventoryCount
  w.u32(0); // equippedCount
}

describe('Int64 hash table (FAITHFUL.401 / BUG.itemtotalxp-monarch-login-seed-unreachable)', () => {
  it('parses AvailableLuminance/MaximumLuminance from a payload shaped like ACE\'s real login snapshot (ItemTotalXp absent)', () => {
    const w = new PayloadWriter();
    header(w, PF_INT64);
    w.u16(2).u16(8); // ACE's SendOnLoginProperties never includes ItemTotalXp
    w.u32(PROP_AVAILABLE_LUMINANCE).i64(1000n);
    w.u32(PROP_MAXIMUM_LUMINANCE).i64(5000n);
    trailer(w, 111);

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.propertiesInt64.get(PROP_AVAILABLE_LUMINANCE)).toBe(1000n);
    expect(result!.propertiesInt64.get(PROP_MAXIMUM_LUMINANCE)).toBe(5000n);
    expect(result!.propertiesInt64.get(PROP_ITEM_TOTAL_XP)).toBeUndefined();
    expect(result!.characterOptions1).toBe(111);
  });

  it('parses whatever key/value pairs are actually on the wire, with no client-side allowlist', () => {
    // The parser itself has no SendOnLogin gate — that filtering happens
    // server-side in GameEventPlayerDescription.cs before the payload is
    // ever written. If a key IS present the parser stores it generically;
    // ItemTotalXp simply never appears in a real login payload.
    const w = new PayloadWriter();
    header(w, PF_INT64);
    w.u16(1).u16(8);
    w.u32(PROP_ITEM_TOTAL_XP).i64(999n);
    trailer(w, 222);

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.propertiesInt64.get(PROP_ITEM_TOTAL_XP)).toBe(999n);
  });
});

describe('Bool hash table (FAITHFUL.401)', () => {
  it('parses IsAdvocate/IsPsr/SpellComponentsRequired from a payload shaped like ACE\'s real login snapshot (Afk/IgnoreHouseBarriers absent)', () => {
    const w = new PayloadWriter();
    header(w, PF_BOOL);
    w.u16(3).u16(8); // ACE's SendOnLoginProperties never includes Afk or IgnoreHouseBarriers
    w.u32(PROP_IS_ADVOCATE).u32(1);
    w.u32(PROP_IS_PSR).u32(1);
    w.u32(PROP_SPELL_COMPONENTS_REQUIRED).u32(0);
    trailer(w, 333);

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.propertiesBool.get(PROP_IS_ADVOCATE)).toBe(true);
    expect(result!.propertiesBool.get(PROP_IS_PSR)).toBe(true);
    expect(result!.propertiesBool.get(PROP_SPELL_COMPONENTS_REQUIRED)).toBe(false);
    expect(result!.propertiesBool.get(PROP_AFK)).toBeUndefined();
    expect(result!.propertiesBool.get(PROP_IGNORE_HOUSE_BARRIERS)).toBeUndefined();
    expect(result!.characterOptions1).toBe(333);
  });
});

describe('Double (Float) hash table (FAITHFUL.401)', () => {
  it('parses HealthRate/StaminaRate/ManaRate — the only [SendOnLogin] Float keys', () => {
    const w = new PayloadWriter();
    header(w, PF_DOUBLE);
    w.u16(3).u16(8);
    w.u32(PROP_HEALTH_RATE).f64(1.5);
    w.u32(PROP_STAMINA_RATE).f64(1.0);
    w.u32(PROP_MANA_RATE).f64(0.5);
    trailer(w, 444);

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.propertiesFloat.get(PROP_HEALTH_RATE)).toBeCloseTo(1.5);
    expect(result!.propertiesFloat.get(PROP_STAMINA_RATE)).toBeCloseTo(1.0);
    expect(result!.propertiesFloat.get(PROP_MANA_RATE)).toBeCloseTo(0.5);
    expect(result!.characterOptions1).toBe(444);
  });
});

describe('PropertyInt64.ItemTotalXp enum value', () => {
  it('is 4, matching the wire key used above', () => {
    expect(PropertyInt64.ItemTotalXp).toBe(PROP_ITEM_TOTAL_XP);
  });
});
