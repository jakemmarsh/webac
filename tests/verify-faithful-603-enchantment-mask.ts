/**
 * FAITHFUL.603 — PlayerDescription enchantment-registry mask values.
 *
 * Found live during FAITHFUL.594 verification (not by the sweep): the
 * parser's EnchantmentMask constants were invented — Cooldown=0x04,
 * Vitae=0x10. ACE EnchantmentCategory.cs:
 *   Multiplicative = 0x1, Additive = 0x2, Vitae = 0x4, Cooldown = 0x8.
 *
 * Failure mode: any character with vitae (= any character that has EVER
 * died) sends mask bit 0x4 with a count-less single vitae Enchantment
 * (EnchantmentRegistry.cs Write order: Mult list, Add list, Cooldown list,
 * Vitae single). The old constants read that bit as a cooldown LIST, so
 * the vitae record's leading SpellID u16 (666) was consumed as a u32
 * count and the parser walked 666 phantom enchantments off the end of the
 * payload (observed: abort at 30660 of 30620 bytes). The catch block then
 * returned partial results, silently resetting CharacterOptions1/2, spell
 * bars, spellbook filters, and inventory placement to sentinels on every
 * login — i.e. FAITHFUL.569/570/572's load-side restores were dead on
 * arrival for every once-dead character.
 *
 * BUG.enchantment-registry-login-dropped converted the parser's skip-only
 * enchantment consumption into real parsing (result.enchantments/
 * result.vitae) — these tests were previously source-text pins on the now-
 * removed skipEnchantment()/skipEnchantmentList() helper names, so they're
 * rewritten here as behavioral synthetic-payload roundtrips that exercise
 * the actual mask-bit branching.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parsePlayerDescription } from '../packages/renderer/src/network/PlayerDescriptionParser';

const __dir = dirname(fileURLToPath(import.meta.url));
const parserSrc = readFileSync(
  join(__dir, '..', 'packages', 'renderer', 'src', 'network', 'PlayerDescriptionParser.ts'), 'utf8');

const VF_ENCHANTMENT = 0x0200;

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
    this.u16(0); // hasSpellSetId = 0 (no trailing spellSetId)
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
    return this;
  }
  bytes(): Uint8Array { return new Uint8Array(this.buf, 0, this.p); }
}

describe('FAITHFUL.603: EnchantmentMask constants match ACE EnchantmentCategory.cs', () => {
  it('Multiplicative=0x1, Additive=0x2, Vitae=0x4, Cooldown=0x8', () => {
    expect(parserSrc).toMatch(/ENCH_MULTIPLICATIVE = 0x01/);
    expect(parserSrc).toMatch(/ENCH_ADDITIVE\s+= 0x02/);
    expect(parserSrc).toMatch(/ENCH_VITAE\s+= 0x04/);
    expect(parserSrc).toMatch(/ENCH_COOLDOWN\s+= 0x08/);
    // the invented values must not return
    expect(parserSrc).not.toMatch(/ENCH_COOLDOWN\s+= 0x04/);
    expect(parserSrc).not.toMatch(/ENCH_VITAE\s+= 0x10/);
  });

  it('behavioral: mask=0x4 (Vitae only) parses ONE count-less enchantment and lands cleanly on the next field — no phantom-count corruption', () => {
    // Regression guard for the exact FAITHFUL.603 failure mode: if Vitae's
    // bit were mis-read as a cooldown LIST, the vitae record's leading
    // spellId(u16)+layer(u16) would be consumed as a bogus u32 list count
    // (666 | (1 << 16) here) and the parser would attempt to walk
    // thousands of phantom 60-byte records, corrupting or aborting well
    // before reaching CharacterOptions1.
    const w = new PayloadWriter();
    w.u32(0);              // propertyFlags
    w.u32(0);              // weenieType
    w.u32(VF_ENCHANTMENT); // vectorFlags
    w.u32(0);              // _hasHealth (unconditional read)
    w.u32(0x04);           // enchantmentMask = ENCH_VITAE only
    w.enchantment({ spellId: 666, layer: 1, statModType: 0x0800000 /* EnchantmentTypeFlags.Vitae */, statModValue: 0.9 });
    w.u32(0);              // optionFlags
    const CO1_SENTINEL = 0xDEADBEEF;
    w.u32(CO1_SENTINEL);   // CharacterOptions1

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.vitae).not.toBeNull();
    expect(result!.vitae!.spellId).toBe(666);
    expect(result!.vitae!.statModValue).toBeCloseTo(0.9, 5);
    expect(result!.enchantments).toHaveLength(1);
    // Byte cursor reached CharacterOptions1 intact — proves no phantom list walk.
    expect(result!.characterOptions1).toBe(CO1_SENTINEL);
  });

  it('behavioral: mask=0x8 (Cooldown only) reads a real count-prefixed list, distinct from Vitae', () => {
    const w = new PayloadWriter();
    w.u32(0);
    w.u32(0);
    w.u32(VF_ENCHANTMENT);
    w.u32(0);
    w.u32(0x08); // ENCH_COOLDOWN only
    w.u32(2);    // count = 2
    w.enchantment({ spellId: 111, statModValue: 1.0 });
    w.enchantment({ spellId: 222, statModValue: 1.0 });
    w.u32(0);              // optionFlags
    const CO1_SENTINEL = 0x1234;
    w.u32(CO1_SENTINEL);   // CharacterOptions1

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.vitae).toBeNull();
    expect(result!.enchantments.map(e => e.spellId)).toEqual([111, 222]);
    expect(result!.characterOptions1).toBe(CO1_SENTINEL);
  });

  it('consume order matches the ACE write order: Mult, Add, Cooldown, then Vitae (single, no count)', () => {
    const m = parserSrc.match(/if \(enchantmentMask & ENCH_MULTIPLICATIVE\) readEnchantmentList\(\);\s*\n\s*if \(enchantmentMask & ENCH_ADDITIVE\) readEnchantmentList\(\);\s*\n\s*if \(enchantmentMask & ENCH_COOLDOWN\) readEnchantmentList\(\);\s*\n\s*if \(enchantmentMask & ENCH_VITAE\) \{/);
    expect(m).not.toBeNull();
  });

  it('the restore consumer guards the -1 parse-abort sentinel (network/spellbookFilterWire.ts, which main.ts calls)', async () => {
    const { applyLoginSpellbookFilters } = await import('../packages/renderer/src/network/spellbookFilterWire.js');
    const got: number[] = [];
    expect(applyLoginSpellbookFilters({ setSpellbookFilters: (f: number) => { got.push(f); } }, { spellbookFilters: -1 })).toBe(false);
    expect(got).toEqual([]);
  });
});
