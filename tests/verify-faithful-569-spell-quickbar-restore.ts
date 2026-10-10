/**
 * FAITHFUL.569 — restore the spell quickbar from PlayerDescription's
 * SpellLists8 section. FAITHFUL.383 wired the SAVE path (Add/Remove
 * SpellFavorite ship to ACE → CharacterPropertiesSpellBar table) but
 * the LOAD path was never implemented. Pre-fix every login restored an
 * empty spell bar — the player had to re-drag spells from the spellbook
 * into the 8 quickbar pages every session.
 *
 * Wire format per ACE `GameEventPlayerDescription.cs:341-378`:
 *   uint optionFlags              (CharacterOptionDataFlag bitfield)
 *   uint CharacterOptions1
 *   if (Shortcut bit set):
 *     uint shortcutCount + N × Shortcut (12 bytes each)
 *   if (SpellLists8 bit set):
 *     for i = 0..7:
 *       uint count + N × spellId(uint)
 *   else:
 *     uint 0u                     (single filler)
 *
 * Spell bars on the wire come AFTER spells + enchantments + optionFlags
 * + CharacterOptions1 + (conditional) shortcuts. PlayerDescriptionParser
 * was extended to consume the enchantment registry bytes (per
 * EnchantmentRegistry.cs:9-22), read optionFlags + CharacterOptions1,
 * skip the conditional shortcut list, then populate
 * `result.spellBars[0..7]` from the SpellLists8 lists.
 *
 * main.ts wires the parsed spellBars to gameUI.setSpellData(spells,
 * spellBarSlots) by looking up each spellId in magicController and
 * building an 8×9 SpellDefinition matrix.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlayerDescription } from '../packages/renderer/src/network/PlayerDescriptionParser';
import { restoreSpellBars } from '../packages/renderer/src/ui/SpellShortcutBar';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const PARSER = readFileSync(resolve(REPO, 'packages/renderer/src/network/PlayerDescriptionParser.ts'), 'utf-8');
const ACE_PD = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventPlayerDescription.cs'), 'utf-8');
const ACE_OPT_FLAG = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/CharacterOptionDataFlag.cs'), 'utf-8');

describe('FAITHFUL.569 — PlayerDescriptionResult exposes spellBars', () => {
  it('PlayerDescriptionResult type has spellBars: number[][]', () => {
    expect(PARSER).toMatch(/spellBars:\s*number\[\]\[\]/);
  });

  it('docblock cites ACE GameEventPlayerDescription.cs lines 364-378 (SpellLists8)', () => {
    expect(PARSER).toMatch(/GameEventPlayerDescription\.cs:364-378/);
  });

  it('default result initializes spellBars to 8 empty arrays', () => {
    expect(PARSER).toMatch(/spellBars:\s*\[\[\],\s*\[\],\s*\[\],\s*\[\],\s*\[\],\s*\[\],\s*\[\],\s*\[\]\]/);
  });
});

describe('FAITHFUL.569 — parser reads enchantment registry + optionFlags + SpellLists8', () => {
  it('parser consumes the EnchantmentRegistry bytes via the 4 mask-bit branches', () => {
    expect(PARSER).toMatch(/ENCH_MULTIPLICATIVE/);
    expect(PARSER).toMatch(/ENCH_ADDITIVE/);
    expect(PARSER).toMatch(/ENCH_COOLDOWN/);
    expect(PARSER).toMatch(/ENCH_VITAE/);
    // Vitae is a SINGLE enchantment (no count prefix per
    // EnchantmentRegistry.cs:22 — `.FirstOrDefault()`). Since
    // BUG.enchantment-registry-login-dropped this is real parsing (not a
    // skip) — see verify-bug-enchantment-registry-login-dropped.ts for the
    // behavioral roundtrip.
    expect(PARSER).toMatch(/if \(enchantmentMask & ENCH_VITAE\) \{/);
  });

  it('parser reads optionFlags + CharacterOptions1 (in that order)', () => {
    expect(PARSER).toMatch(/const optionFlags = r\.readUInt32\(\)/);
    // FAITHFUL.570 — CO1 is now surfaced on the result, not discarded.
    expect(PARSER).toMatch(/result\.characterOptions1 = r\.readUInt32\(\)|r\.readUInt32\(\);\s*\/\/ CharacterOptions1|const _characterOptions1 = r\.readUInt32\(\)/);
  });

  it('parser conditionally reads shortcuts (12 bytes each per Shortcut.cs:44-49)', () => {
    // BUG.shortcut-bar-restore-dropped — the shortcut list used to be a
    // blind r.skip(shortcutCount * 12); it's now parsed into
    // result.shortcuts. Full behavioral coverage of the parse itself lives
    // in verify-bug-shortcut-bar-restore-dropped.ts.
    expect(PARSER).toMatch(/CHAR_OPT_SHORTCUT/);
    expect(PARSER).toMatch(/result\.shortcuts\.push\(\{\s*index,\s*objectId,\s*spellId,\s*layer\s*\}\)/);
  });

  it('parser reads 8 spell-bar lists when SpellLists8 bit is set', () => {
    expect(PARSER).toMatch(/CHAR_OPT_SPELL_LISTS_8/);
    expect(PARSER).toMatch(/for \(let bar = 0; bar < 8; bar\+\+\)/);
    expect(PARSER).toMatch(/result\.spellBars\[bar\]/);
  });

  it('parser falls back to consuming the single placeholder 0u when SpellLists8 is unset', () => {
    expect(PARSER).toMatch(/r\.readUInt32\(\);\s*\/\/ single 0u placeholder per ACE source line 377/);
  });
});

describe('FAITHFUL.569 — synthetic PlayerDescription roundtrip restores spell bars', () => {
  it('parser populates spellBars[0..7] from a synthetic SpellLists8 payload', () => {
    // Build a minimal PlayerDescription with:
    //   - propertyFlags = 0 (no properties)
    //   - weenieType = 0
    //   - vectorFlags = 0 (no attributes/skills/spells/enchantments)
    //   - optionFlags = SpellLists8 (0x400)
    //   - CharacterOptions1 = 0
    //   - SpellLists8 section: 8 bars with sample spell IDs
    //     bar 0: [100, 200, 300]
    //     bar 1: [400]
    //     bars 2-7: empty
    const buf = new ArrayBuffer(4096);
    const dv = new DataView(buf);
    let p = 0;
    const w32 = (v: number) => { dv.setUint32(p, v, true); p += 4; };
    w32(0);                       // propertyFlags
    w32(0);                       // weenieType
    w32(0);                       // vectorFlags (no VF_* bits)
    w32(0);                       // unused _hasHealth — wait, this is gated on VF_ATTRIBUTE
    // Actually with vectorFlags=0 the attribute/skill/spell/enchantment blocks
    // are entirely skipped — so we go straight to optionFlags.
    // But our parser reads `_hasHealth` UNCONDITIONALLY after vectorFlags
    // (PlayerDescriptionParser line 261). Account for that.
    // (Looking at the parser code — line 260-261:
    //   const vectorFlags = r.readUInt32();
    //   const _hasHealth = r.readUInt32();
    // So _hasHealth is always read.)
    // → buffer position now: 4 × 4 = 16 bytes of header (propertyFlags,
    // weenieType, vectorFlags, _hasHealth).
    // Next: optionFlags + CharacterOptions1.
    w32(0x400);                   // optionFlags = SpellLists8 only
    w32(0);                       // CharacterOptions1
    // SpellLists8: 8 bars.
    w32(3); w32(100); w32(200); w32(300);  // bar 0
    w32(1); w32(400);                       // bar 1
    w32(0);                                 // bar 2
    w32(0);                                 // bar 3
    w32(0);                                 // bar 4
    w32(0);                                 // bar 5
    w32(0);                                 // bar 6
    w32(0);                                 // bar 7

    const payload = new Uint8Array(buf, 0, p);
    const result = parsePlayerDescription(payload);

    expect(result).not.toBeNull();
    expect(result!.spellBars).toHaveLength(8);
    expect(result!.spellBars[0]).toEqual([100, 200, 300]);
    expect(result!.spellBars[1]).toEqual([400]);
    for (let i = 2; i < 8; i++) {
      expect(result!.spellBars[i]).toEqual([]);
    }
  });

  it('parser falls back to 8 empty arrays when SpellLists8 bit is not set', () => {
    const buf = new ArrayBuffer(4096);
    const dv = new DataView(buf);
    let p = 0;
    const w32 = (v: number) => { dv.setUint32(p, v, true); p += 4; };
    w32(0);              // propertyFlags
    w32(0);              // weenieType
    w32(0);              // vectorFlags
    w32(0);              // _hasHealth
    w32(0);              // optionFlags = 0 (NO SpellLists8)
    w32(0);              // CharacterOptions1
    w32(0);              // single 0u placeholder per ACE source line 377

    const payload = new Uint8Array(buf, 0, p);
    const result = parsePlayerDescription(payload);

    expect(result).not.toBeNull();
    expect(result!.spellBars).toHaveLength(8);
    for (const bar of result!.spellBars) {
      expect(bar).toEqual([]);
    }
  });

  it('parser reads the Shortcut list when Shortcut bit is set, then reaches SpellLists8', () => {
    const buf = new ArrayBuffer(4096);
    const dv = new DataView(buf);
    let p = 0;
    const w32 = (v: number) => { dv.setUint32(p, v, true); p += 4; };
    const w16 = (v: number) => { dv.setUint16(p, v, true); p += 2; };
    w32(0);              // propertyFlags
    w32(0);              // weenieType
    w32(0);              // vectorFlags
    w32(0);              // _hasHealth
    w32(0x401);          // optionFlags = Shortcut (0x1) | SpellLists8 (0x400)
    w32(0);              // CharacterOptions1
    // Shortcuts: count=2 + 2 × 12 bytes
    w32(2);              // count
    // Shortcut 1: Index=0, ObjectId=0x12345678, SpellId=0, Layer=0
    w32(0); w32(0x12345678); w16(0); w16(0);
    // Shortcut 2: Index=1, ObjectId=0xABCDEF01, SpellId=0, Layer=0
    w32(1); w32(0xABCDEF01); w16(0); w16(0);
    // SpellLists8 — single spell in bar 0
    w32(1); w32(999);  // bar 0
    for (let i = 1; i < 8; i++) w32(0); // bars 1-7 empty

    const payload = new Uint8Array(buf, 0, p);
    const result = parsePlayerDescription(payload);

    expect(result).not.toBeNull();
    // BUG.shortcut-bar-restore-dropped — the 2 shortcut entries are now
    // captured (not just skipped), and the cursor still lands correctly on
    // SpellLists8 afterward.
    expect(result!.shortcuts).toEqual([
      { index: 0, objectId: 0x12345678, spellId: 0, layer: 0 },
      { index: 1, objectId: 0xABCDEF01, spellId: 0, layer: 0 },
    ]);
    expect(result!.spellBars[0]).toEqual([999]);
  });
});

// The main.ts restore glue is restoreSpellBars (SpellShortcutBar.ts); these
// drive it (were main.ts source-text pins).
describe('FAITHFUL.569 / SWEEP1006B — restoreSpellBars (the login restore)', () => {
  const def = (id: number) => ({ id, name: `S${id}` });
  it('resolves the 8 bars in order, padded to the 9-slot shape, counting the restored slots', () => {
    const r = restoreSpellBars([[100, 200, 300], [400]], () => true, def);
    expect(r.slots).toHaveLength(8);
    expect(r.slots[0].map((s) => s?.id ?? null)).toEqual([100, 200, 300, null, null, null, null, null, null]);
    expect(r.slots[1][0]?.id).toBe(400);
    expect(r.slots[7].every((s) => s === null)).toBe(true);
    expect(r.restored).toBe(4);
    expect(r.removed).toEqual([]);
  });

  it('does not cut a bar at 9 (retail favorites are an unbounded list)', () => {
    const ids = Array.from({ length: 12 }, (_, i) => i + 1);
    expect(restoreSpellBars([ids], () => true, def).slots[0]).toHaveLength(12);
  });

  it('drops favorites of spells no longer known (the rest close up) and reports each for RemoveSpellFavorite', () => {
    const known = new Set([100, 300, 400]);
    const r = restoreSpellBars([[100, 200, 300], [], [200, 400]], (id) => known.has(id), def);
    expect(r.slots[0].slice(0, 3).map((s) => s?.id ?? null)).toEqual([100, 300, null]);
    expect(r.slots[2][0]?.id).toBe(400);
    expect(r.removed).toEqual([{ spellId: 200, tab: 0 }, { spellId: 200, tab: 2 }]);
  });
});

describe('FAITHFUL.569 — ACE source still anchors the fix', () => {
  it('ACE GameEventPlayerDescription.cs still writes 8-bar SpellLists8 section when bit set', () => {
    expect(ACE_PD).toMatch(/for \(int i = 0; i <= 7; i\+\+\)/);
    expect(ACE_PD).toMatch(/GetSpellsInSpellBar\(i\)/);
    expect(ACE_PD).toMatch(/Writer\.Write\(spells\.Count\)/);
  });

  it('ACE CharacterOptionDataFlag still has SpellLists8 = 0x400', () => {
    expect(ACE_OPT_FLAG).toMatch(/SpellLists8\s*=\s*0x00000400/);
  });

  it('ACE CharacterOptionDataFlag still has Shortcut = 0x1', () => {
    expect(ACE_OPT_FLAG).toMatch(/Shortcut\s*=\s*0x00000001/);
  });
});
