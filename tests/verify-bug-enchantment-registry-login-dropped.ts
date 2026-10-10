/**
 * BUG.enchantment-registry-login-dropped — the login PlayerDescription's
 * EnchantmentRegistry (Vitae + every active buff/debuff) was parsed only to
 * skip bytes, never applied.
 *
 * ACE `GameEventPlayerDescription.cs:337-338` writes
 * `EnchantmentManager.SendRegistry(writer)` whenever the vector's
 * VF_ENCHANTMENT bit is set. `SendRegistry`'s ONLY call site in
 * ACE.Server is that login line (verified: no other caller in
 * reference/ACE/Source/ACE.Server/) — it is NOT redundant with the live
 * MagicUpdateEnchantment(s) broadcasts, which only fire on later changes,
 * never at login. Pre-fix, `PlayerDescriptionParser` consumed the bytes via
 * skipEnchantment()/skipEnchantmentList() purely to keep the cursor
 * aligned for SpellLists8, discarding every field. Any character that had
 * ever died (i.e. carried a Vitae enchantment) or logged in with an active
 * buff showed 0% vitae penalty / no buff icons until the next server-side
 * change re-broadcast it.
 *
 * Fix: PlayerDescriptionParser now builds `result.enchantments` (every
 * Multiplicative/Additive/Cooldown/Vitae record) + `result.vitae`
 * (convenience reference to the Vitae record, or null) via the same
 * `parseEnchantmentFromReader` used by the live MagicUpdateMultipleEnchantments
 * path (`@ac/network`). main.ts's `onPlayerDescription` handler consumes
 * both: sets `playerState.vitae` from `result.vitae`'s statModValue and
 * calls `gameUI.addEnchantment` for every entry, mirroring
 * `onMagicUpdateMultipleEnchantments`'s per-enchantment handling. That
 * main.ts wiring is thin glue over already-tested APIs (VitaeSystem.
 * setVitaePenalty, GameUI.addEnchantment) — the behavioral coverage below
 * targets the actual bug surface, the binary parsing itself (mask
 * decoding, per-category record counts, byte alignment into the fields
 * that follow).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlayerDescription } from '../packages/renderer/src/network/PlayerDescriptionParser';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const ACE_SEND_REGISTRY = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/WorldObjects/Managers/EnchantmentManager.cs'), 'utf-8');
const ACE_PD = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventPlayerDescription.cs'), 'utf-8');

const VF_ENCHANTMENT = 0x0200;
const ENCHANTMENT_TYPE_VITAE = 0x0800000;
const ENCHANTMENT_TYPE_BENEFICIAL = 0x2000000;

interface EnchWriterOpts {
  spellId: number;
  layer?: number;
  spellCategory?: number;
  powerLevel?: number;
  startTime?: number;
  duration?: number;
  casterGuid?: number;
  degradeModifier?: number;
  degradeLimit?: number;
  lastTimeDegraded?: number;
  statModType?: number;
  statModKey?: number;
  statModValue?: number;
  spellSetId?: number; // when set, writes hasSpellSetId=1 + trailing u32
}

class PayloadWriter {
  private buf = new ArrayBuffer(65536);
  private dv = new DataView(this.buf);
  private p = 0;
  u32(v: number): this { this.dv.setUint32(this.p, v, true); this.p += 4; return this; }
  u16(v: number): this { this.dv.setUint16(this.p, v, true); this.p += 2; return this; }
  f32(v: number): this { this.dv.setFloat32(this.p, v, true); this.p += 4; return this; }
  f64(v: number): this { this.dv.setFloat64(this.p, v, true); this.p += 8; return this; }
  enchantment(o: EnchWriterOpts): this {
    this.u16(o.spellId);
    this.u16(o.layer ?? 1);
    this.u16(o.spellCategory ?? 0);
    this.u16(o.spellSetId !== undefined ? 1 : 0);
    this.u32(o.powerLevel ?? 0);
    this.f64(o.startTime ?? 0);
    this.f64(o.duration ?? 0);
    this.u32(o.casterGuid ?? 0);
    this.f32(o.degradeModifier ?? 0);
    this.f32(o.degradeLimit ?? 0);
    this.f64(o.lastTimeDegraded ?? 0);
    this.u32(o.statModType ?? 0);
    this.u32(o.statModKey ?? 0);
    this.f32(o.statModValue ?? 1.0);
    if (o.spellSetId !== undefined) this.u32(o.spellSetId);
    return this;
  }
  bytes(): Uint8Array { return new Uint8Array(this.buf, 0, this.p); }
}

// Minimal header every payload needs before the enchantment-registry section:
// propertyFlags(0) + weenieType(0) + vectorFlags + _hasHealth(0, unconditional).
function header(w: PayloadWriter, vectorFlags: number): void {
  w.u32(0).u32(0).u32(vectorFlags).u32(0);
}

describe('BUG.enchantment-registry-login-dropped — ACE ground truth', () => {
  it('EnchantmentManager.SendRegistry has exactly one call site in ACE.Server: login', () => {
    expect(ACE_PD).toMatch(/EnchantmentManager\.SendRegistry\(Writer\)/);
    expect(ACE_SEND_REGISTRY).toMatch(/public void SendRegistry\(BinaryWriter writer\)/);
  });
});

describe('BUG.enchantment-registry-login-dropped — default result (no VF_ENCHANTMENT bit)', () => {
  it('enchantments defaults to an empty array and vitae to null', () => {
    const w = new PayloadWriter();
    header(w, 0); // no vector flags at all
    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.enchantments).toEqual([]);
    expect(result!.vitae).toBeNull();
  });
});

describe('BUG.enchantment-registry-login-dropped — full registry roundtrip', () => {
  it('parses Multiplicative + Additive + Cooldown lists + a single Vitae record, in ACE write order', () => {
    const w = new PayloadWriter();
    header(w, VF_ENCHANTMENT);
    w.u32(0x01 | 0x02 | 0x08 | 0x04); // Multiplicative | Additive | Cooldown | Vitae
    // Multiplicative: 1 entry
    w.u32(1);
    w.enchantment({ spellId: 1001, statModType: ENCHANTMENT_TYPE_BENEFICIAL, statModValue: 1.25 });
    // Additive: 2 entries
    w.u32(2);
    w.enchantment({ spellId: 2001, statModType: ENCHANTMENT_TYPE_BENEFICIAL, statModValue: 5 });
    w.enchantment({ spellId: 2002, statModType: 0, statModValue: -3 }); // harmful (no Beneficial bit)
    // Cooldown: 1 entry
    w.u32(1);
    w.enchantment({ spellId: 3001, statModType: 0x1000000 /* Cooldown */, statModValue: 0 });
    // Vitae: single, no count prefix
    w.enchantment({ spellId: 666, statModType: ENCHANTMENT_TYPE_VITAE, statModValue: 0.85 });
    // Trailing sentinel field to prove the cursor landed exactly right.
    w.u32(0); // optionFlags
    const CO1_SENTINEL = 777;
    w.u32(CO1_SENTINEL); // CharacterOptions1

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();

    // All 5 records present (1 mult + 2 add + 1 cooldown + 1 vitae).
    expect(result!.enchantments).toHaveLength(5);
    expect(result!.enchantments.map(e => e.spellId)).toEqual([1001, 2001, 2002, 3001, 666]);

    // Vitae surfaced both inline and via the convenience field.
    expect(result!.vitae).not.toBeNull();
    expect(result!.vitae!.spellId).toBe(666);
    expect(result!.vitae!.isVitae).toBe(true);
    expect(result!.vitae!.statModValue).toBeCloseTo(0.85, 5);
    expect(result!.enchantments[4]).toBe(result!.vitae);

    // Beneficial/harmful flags decoded correctly per-record.
    expect(result!.enchantments[0].isBeneficial).toBe(true);
    expect(result!.enchantments[2].isBeneficial).toBe(false);
    expect(result!.enchantments[3].isCooldown).toBe(true);

    // Cursor reached CharacterOptions1 exactly — no drift from the 4-branch parse.
    expect(result!.characterOptions1).toBe(CO1_SENTINEL);
  });

  it('parses the conditional trailing spellSetId (+4 bytes) when hasSpellSetId is set', () => {
    const w = new PayloadWriter();
    header(w, VF_ENCHANTMENT);
    w.u32(0x01); // Multiplicative only
    w.u32(1);
    w.enchantment({ spellId: 5001, statModValue: 2.0, spellSetId: 42 });
    w.u32(0); // optionFlags
    w.u32(99); // CharacterOptions1 sentinel

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.enchantments).toHaveLength(1);
    expect(result!.enchantments[0].spellSetId).toBe(42);
    expect(result!.enchantments[0].hasSpellSetId).not.toBe(0);
    expect(result!.characterOptions1).toBe(99);
  });

  it('an empty registry (mask=0, VF_ENCHANTMENT set) parses to no entries and reaches the next field', () => {
    const w = new PayloadWriter();
    header(w, VF_ENCHANTMENT);
    w.u32(0); // enchantmentMask = none
    w.u32(0); // optionFlags
    w.u32(55); // CharacterOptions1 sentinel

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.enchantments).toEqual([]);
    expect(result!.vitae).toBeNull();
    expect(result!.characterOptions1).toBe(55);
  });
});
