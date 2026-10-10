/**
 * BUG.patron-allegiance-instance-id-dropped — PlayerDescription's
 * PropertyInstanceId hash table (Allegiance=24, Patron=25, Monarch=26) was
 * parsed into `result.propertiesInstanceId` but nothing downstream ever
 * read the Map. main.ts's onPlayerDescription handler mirrored every other
 * property bucket (Int/Int64/Bool/Float/DataId) into playerState but had no
 * equivalent line for propertiesInstanceId, and the live-broadcast sibling
 * (onPublicUpdatePropertyInstanceID) only branched on PropertyInstanceId.
 * Wielder, silently discarding Monarch/Patron/Allegiance changes too.
 *
 * Per reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInstanceId.cs
 * :43-46, Allegiance(24) and Patron(25) carry [SendOnLogin]; Monarch(26)
 * does not but is re-broadcast live via GameMessagePublicUpdateInstanceID
 * whenever Player_Allegiance.cs's swear/break-allegiance path changes it
 * (broadcast=true in Player_Properties.cs's UpdateProperty).
 *
 * The fix wires playerState.patronGuid/monarchGuid/allegianceGuid from both
 * paths (packages/renderer/src/main.ts onPlayerDescription +
 * onPublicUpdatePropertyInstanceID) — thin glue over already-tested APIs,
 * matching the precedent set by BUG.enchantment-registry-login-dropped's
 * docblock. The behavioral coverage below targets the actual parse surface
 * this fix depends on: the PF_INSTANCE_ID hash-table branch in
 * PlayerDescriptionParser, which previously had zero test coverage even
 * though it was already implemented correctly.
 */
import { describe, it, expect } from 'vitest';
import { parsePlayerDescription } from '../packages/renderer/src/network/PlayerDescriptionParser';

const PF_INSTANCE_ID = 0x0040; // DescriptionPropertyFlag.PropertyIid

const PROP_ALLEGIANCE = 24;
const PROP_PATRON = 25;
const PROP_MONARCH = 26;

class PayloadWriter {
  private buf = new ArrayBuffer(4096);
  private dv = new DataView(this.buf);
  private p = 0;
  u16(v: number): this { this.dv.setUint16(this.p, v, true); this.p += 2; return this; }
  u32(v: number): this { this.dv.setUint32(this.p, v, true); this.p += 4; return this; }
  bytes(): Uint8Array { return new Uint8Array(this.buf, 0, this.p); }
}

// header: propertyFlags(u32) + weenieType(u32)
function header(w: PayloadWriter, propertyFlags: number): void {
  w.u32(propertyFlags).u32(0);
}

// Every payload must reach the unconditional trailing fields regardless of
// which flag-gated blocks ran, and continue on to a clean return (no
// caught parse error) so the test isn't relying on partial-result fallback
// behavior: vectorFlags(u32) + _hasHealth(u32) + optionFlags(u32) +
// characterOptions1(u32, the sentinel we check) + SpellLists8 placeholder
// (u32, since CHAR_OPT_SPELL_LISTS_8 is unset) + spellbookFilters(u32,
// unconditional) + inventoryCount(u32) + equippedCount(u32), both 0 since
// CHAR_OPT_GAMEPLAY_OPTIONS is unset.
function trailer(w: PayloadWriter, co1Sentinel: number): void {
  w.u32(0).u32(0); // vectorFlags=0, hasHealth=0 — skip every VF_* block
  w.u32(0); // optionFlags=0
  w.u32(co1Sentinel); // CharacterOptions1
  w.u32(0); // SpellLists8 placeholder (CHAR_OPT_SPELL_LISTS_8 unset)
  w.u32(0); // spellbookFilters
  w.u32(0); // inventoryCount
  w.u32(0); // equippedCount
}

describe('BUG.patron-allegiance-instance-id-dropped — PF_INSTANCE_ID parsing', () => {
  it('default result (no PF_INSTANCE_ID bit) leaves propertiesInstanceId empty and reaches CO1', () => {
    const w = new PayloadWriter();
    header(w, 0);
    trailer(w, 111);

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.propertiesInstanceId.size).toBe(0);
    expect(result!.characterOptions1).toBe(111);
  });

  it('parses Allegiance/Patron/Monarch guids from the hash table into propertiesInstanceId', () => {
    const w = new PayloadWriter();
    header(w, PF_INSTANCE_ID);
    // hash table header: count(u16) + buckets(u16)
    w.u16(3).u16(8);
    w.u32(PROP_ALLEGIANCE).u32(0xA0000001);
    w.u32(PROP_PATRON).u32(0xA0000002);
    w.u32(PROP_MONARCH).u32(0xA0000003);
    trailer(w, 222);

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.propertiesInstanceId.size).toBe(3);
    expect(result!.propertiesInstanceId.get(PROP_ALLEGIANCE)).toBe(0xA0000001);
    expect(result!.propertiesInstanceId.get(PROP_PATRON)).toBe(0xA0000002);
    expect(result!.propertiesInstanceId.get(PROP_MONARCH)).toBe(0xA0000003);

    // Cursor landed exactly on CharacterOptions1 — proves each entry is
    // read as exactly 8 bytes (key u32 + value u32), matching ACE's
    // GetAllPropertyInstanceIdWhere hash-table wire format.
    expect(result!.characterOptions1).toBe(222);
  });

  it('a Patron-only login snapshot (the practical case — Allegiance(24) is dead in current ACE) round-trips', () => {
    const w = new PayloadWriter();
    header(w, PF_INSTANCE_ID);
    w.u16(1).u16(8);
    w.u32(PROP_PATRON).u32(0x50001234);
    trailer(w, 333);

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.propertiesInstanceId.get(PROP_PATRON)).toBe(0x50001234);
    expect(result!.propertiesInstanceId.has(PROP_MONARCH)).toBe(false);
    expect(result!.characterOptions1).toBe(333);
  });
});
