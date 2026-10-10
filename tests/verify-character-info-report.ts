/**
 * ASSESS: Character Information panel report (gmCharacterInfoUI port).
 *
 * Drives the SHIPPED code paths behaviorally:
 *   - acStringHash       — AC's compute_str_hash, verified against the live
 *                          DAT entry ids decoded from the retail client.
 *   - getStringParts     — multi-fragment template access.
 *   - buildCharacterInfoReport — interleave substitution, base/spec luminance
 *                          split, count pluralization, deaths variants,
 *                          masteries, gem augmentations, burden line, and the
 *                          decompiled emit ORDER.
 *
 * Strings are registered as a synthetic StringTable keyed by the REAL token
 * hashes with the REAL DAT fragment arrays (captured from
 * client_local_English.dat), so the test exercises the same hash→resolve→
 * interleave pipeline the panel uses at runtime — no DAT files required.
 */
import { describe, it, expect } from 'vitest';
import {
  acStringHash, getString, getStringParts, getStringPartsFromTable, registerStringTable,
} from '@ac/dat-parser/file-types/LayoutDesc.js';
import type { StringTableData } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { buildCharacterInfoReport, resistTier, regenTier } from '@ac/renderer/ui/CharacterInfoReport.js';
import type { CharacterInfoSource } from '@ac/renderer/ui/CharacterInfoReport.js';

// ─── acStringHash — verified against decoded DAT entry ids ────────────────
describe('acStringHash (compute_str_hash)', () => {
  it('matches the live DAT entry ids for known tokens', () => {
    expect(acStringHash('ID_CharacterInfo_Birth')).toBe(135508168);
    expect(acStringHash('ID_CharacterInfo_Luminance_Header')).toBe(153985746);
    expect(acStringHash('ID_CharacterInfo_Innates')).toBe(118350547);
    expect(acStringHash('ID_CharacterInfo_Mastery_Melee')).toBe(135300613);
    expect(acStringHash('ID_CharacterInfo_Deaths_Many')).toBe(128202649);
  });
  it('returns 0 for the empty string', () => {
    expect(acStringHash('')).toBe(0);
  });
});

// ─── Register the real fragment arrays under their real token hashes ──────
function tok(name: string, strings: string[]) {
  return { id: acStringHash(name), varNames: [], vars: [], strings, comments: [], unknown: 0 };
}
const TABLE: StringTableData = {
  id: 0x23000001, language: 1, unknown: 0,
  entries: [
    tok('ID_CharacterInfo_Birth', ['You were born on ', '.\\n']),
    tok('ID_CharacterInfo_Played', ['You have played for ', '.\\n']),
    tok('ID_CharacterInfo_Deaths_None', ['You have never died!\\n']),
    tok('ID_CharacterInfo_Deaths_One', ['You have died only once!\\n']),
    tok('ID_CharacterInfo_Deaths_Two', ['You have died twice.\\n']),
    tok('ID_CharacterInfo_Deaths_Many', ['You have died ', ' times.\\n']),
    tok('ID_CharacterInfo_Innates', [
      'Innate Strength: ', '\\nInnate Endurance: ', '\\nInnate Coordination: ',
      '\\nInnate Quickness: ', '\\nInnate Focus: ', '\\nInnate Self: ', '\\n',
    ]),
    // EoL client_local_English.dat: 4 fragments, variable refs RESIST, RESIST, REGEN.
    tok('ID_CharacterInfo_Resists', [
      'Natural Resistances: ', '\\nDrain Resistances: ', '\\nRegeneration Bonus: ', '\\n',
    ]),
    tok('ID_CharacterInfo_Chess', ['Chess Rank: ', '\\n']),
    tok('ID_CharacterInfo_Fishing', ['Fishing Skill: ', '\\n']),
    tok('ID_CharacterInfo_Mastery_Melee', ['Your melee mastery is ', '.\\n']),
    tok('ID_CharacterInfo_Luminance_Header', ['Luminance Augmentations:\\n\\n']),
    tok('ID_CharacterInfo_Luminance_Base_Damage', ['Aura of Valor. Your Damage Rating is increased by ', '.\\n\\n']),
    tok('ID_CharacterInfo_Luminance_Spec_Damage', ['Aura of Destruction. Your Seer grants you an increase to Damage Rating of ', '.\\n\\n']),
    tok('ID_CharacterInfo_Augmentation_Attribute_Strength', ['You have augmented your Innate Strength ', ' {time[1]|times}.\\n\\n']),
    tok('ID_CharacterInfo_Augmentation_ExtraPackSlot', ['You have augmented your pack-carrying capacity.\\n\\n']),
    tok('ID_CharacterInfo_Load_None', ['You are not overburdened at this time.\\n']),
    tok('ID_CharacterInfo_Load_Burdened', [
      'You are currently overburdened by ', ' burden units. This is reducing your Run, Jump, Melee Defense and Missile Defense skills by ', '%.\\n',
    ]),
  ],
};
registerStringTable(TABLE);

describe('getStringParts', () => {
  it('returns the full fragment array with newlines unescaped', () => {
    const parts = getStringParts(acStringHash('ID_CharacterInfo_Innates'));
    expect(parts).not.toBeNull();
    expect(parts!.length).toBe(7);
    expect(parts![0]).toBe('Innate Strength: ');
    expect(parts![1]).toBe('\nInnate Endurance: ');
  });
  it('getString still returns only the first fragment', () => {
    expect(getString(acStringHash('ID_CharacterInfo_Birth'))).toBe('You were born on ');
  });
  it('getStringPartsFromTable is the table-bound twin (CORE.17.k.b.b.a.a.a): the fragments from that table only', () => {
    const id = acStringHash('ID_CharacterInfo_Load_Burdened');
    const parts = getStringPartsFromTable(TABLE.id, id);
    expect(parts).toHaveLength(3);
    expect(parts![2]).toBe('%.\n');
    expect(getStringPartsFromTable(TABLE.id + 1, id)).toBeNull();
    expect(getStringPartsFromTable(TABLE.id, 0x7fffffff)).toBeNull();
  });
});

// ─── Report builder ───────────────────────────────────────────────────────
function makeSource(
  props: Record<number, number>,
  innate: number[] = [100, 110, 120, 130, 140, 150],
  base: number[] = innate,
): CharacterInfoSource {
  return {
    prop: (id: number) => (id in props ? props[id] : undefined),
    attribute: (id: number) => base[id - 1] ?? 0,
    innateAttribute: (id: number) => innate[id - 1] ?? 0,
    strength: base[0],
  };
}

describe('buildCharacterInfoReport', () => {
  it('emits the innate-attribute line by interleaving fragments with the 6 values (Str/End/Coord/Quick/Focus/Self order)', () => {
    // attrs indexed by attribute id 1..6 = Str,End,Coord,Quick,Focus,Self
    const src = makeSource({ 43: 0 }, [100, 110, 120, 130, 140, 150]);
    const lines = buildCharacterInfoReport(src);
    const innate = lines.find(l => l.startsWith('Innate Strength'));
    // attrs are indexed by attribute id (1=Str,2=End,3=Quick,4=Coord,5=Focus,
    // 6=Self per ACE PropertyAttribute). The panel's display order is
    // Str,End,Coord,Quick — so Coordination shows id-4 (130) and Quickness
    // shows id-3 (120). This pins the FAITHFUL.601 Quick/Coord id ordering.
    expect(innate).toBe(
      'Innate Strength: 100\nInnate Endurance: 110\nInnate Coordination: 130\nInnate Quickness: 120\nInnate Focus: 140\nInnate Self: 150');
  });

  it('renders deaths variants and "never died" when count is 0', () => {
    expect(buildCharacterInfoReport(makeSource({ 43: 0 })).some(l => l === 'You have never died!')).toBe(true);
    expect(buildCharacterInfoReport(makeSource({ 43: 1 })).some(l => l === 'You have died only once!')).toBe(true);
    expect(buildCharacterInfoReport(makeSource({ 43: 2 })).some(l => l === 'You have died twice.')).toBe(true);
    expect(buildCharacterInfoReport(makeSource({ 43: 5 })).some(l => l === 'You have died 5 times.')).toBe(true);
  });

  it('shows melee mastery with the retail weapon-category name (2 = Swords)', () => {
    const lines = buildCharacterInfoReport(makeSource({ 43: 0, 354: 2 }));
    expect(lines.some(l => l === 'Your melee mastery is Swords.')).toBe(true);
  });

  it('splits a luminance rating into a base (≤5) line and a Seer-granted spec remainder', () => {
    const lines = buildCharacterInfoReport(makeSource({ 43: 0, 333: 7 })); // LumAugDamageRating = 7
    expect(lines.some(l => l === 'Aura of Valor. Your Damage Rating is increased by 5.')).toBe(true);
    expect(lines.some(l => l === 'Aura of Destruction. Your Seer grants you an increase to Damage Rating of 2.')).toBe(true);
  });

  it('does not emit a spec line when the rating is ≤ 5', () => {
    const lines = buildCharacterInfoReport(makeSource({ 43: 0, 333: 5 }));
    expect(lines.some(l => l === 'Aura of Valor. Your Damage Rating is increased by 5.')).toBe(true);
    expect(lines.some(l => l.includes('Your Seer grants'))).toBe(false);
  });

  it('pluralizes the augmentation count selector {time[1]|times}', () => {
    const one = buildCharacterInfoReport(makeSource({ 43: 0, 218: 1 }));
    expect(one.some(l => l === 'You have augmented your Innate Strength 1 time.')).toBe(true);
    const many = buildCharacterInfoReport(makeSource({ 43: 0, 218: 4 }));
    expect(many.some(l => l === 'You have augmented your Innate Strength 4 times.')).toBe(true);
  });

  it('shows binary (count-less) augmentations only when owned', () => {
    expect(buildCharacterInfoReport(makeSource({ 43: 0, 229: 1 }))
      .some(l => l === 'You have augmented your pack-carrying capacity.')).toBe(true);
    expect(buildCharacterInfoReport(makeSource({ 43: 0, 229: 0 }))
      .some(l => l.includes('pack-carrying'))).toBe(false);
  });

  it('shows "not overburdened" under capacity and a penalty line when overburdened', () => {
    // capacity = 150*strength = 150*100 = 15000; encumbrance(prop 5) below it
    expect(buildCharacterInfoReport(makeSource({ 43: 0, 5: 1000 }))
      .some(l => l === 'You are not overburdened at this time.')).toBe(true);
    // over capacity → burdened. ratio 30000/15000 = 2.0 → burdenMod 0 → 100%
    const over = buildCharacterInfoReport(makeSource({ 43: 0, 5: 30000 }));
    expect(over.some(l => l.startsWith('You are currently overburdened by 15000 burden units'))).toBe(true);
    expect(over.some(l => l.endsWith('skills by 100%.'))).toBe(true);
  });

  it('preserves the decompiled emit order: deaths before innates before masteries before luminance header', () => {
    const lines = buildCharacterInfoReport(makeSource({ 43: 5, 354: 2, 333: 3 }));
    const iDeaths = lines.findIndex(l => l.includes('died 5 times'));
    const iInnate = lines.findIndex(l => l.startsWith('Innate Strength'));
    const iMastery = lines.findIndex(l => l.includes('melee mastery'));
    const iLumHdr = lines.findIndex(l => l.startsWith('Luminance Augmentations'));
    expect(iDeaths).toBeGreaterThanOrEqual(0);
    expect(iDeaths).toBeLessThan(iInnate);
    expect(iInnate).toBeLessThan(iMastery);
    expect(iMastery).toBeLessThan(iLumHdr);
  });

  it('prints the INNATE (creation) attributes, not init + ranks (UpdateInnateAttributeInfo reads _init_level)', () => {
    const src = makeSource({ 43: 0 }, [10, 20, 30, 40, 50, 60], [200, 210, 220, 230, 240, 250]);
    const innate = buildCharacterInfoReport(src).find(l => l.startsWith('Innate Strength'));
    expect(innate).toBe(
      'Innate Strength: 10\nInnate Endurance: 20\nInnate Coordination: 40\nInnate Quickness: 30\nInnate Focus: 50\nInnate Self: 60');
  });

  it('emits the endurance block (Natural/Drain/Regeneration) between deaths and innates, from BASE Str/End', () => {
    // base Str 200 + End 200 = 400 → Resilient; Str + 2·End = 600 → Resilient.
    const src = makeSource({ 43: 0 }, [10, 10, 10, 10, 10, 10], [200, 200, 10, 10, 10, 10]);
    const lines = buildCharacterInfoReport(src);
    const i = lines.findIndex(l => l.startsWith('Natural Resistances'));
    expect(lines[i]).toBe('Natural Resistances: Resilient\nDrain Resistances: Resilient\nRegeneration Bonus: Resilient');
    expect(lines.findIndex(l => l === 'You have never died!')).toBeLessThan(i);
    expect(i).toBeLessThan(lines.findIndex(l => l.startsWith('Innate Strength')));
  });

  it('always emits the endurance block, even at the lowest tier', () => {
    const lines = buildCharacterInfoReport(makeSource({ 43: 0 }, [10, 10, 10, 10, 10, 10]));
    expect(lines).toContain('Natural Resistances: None\nDrain Resistances: None\nRegeneration Bonus: None');
  });

  it('fills RESIST twice and REGEN once with different tiers', () => {
    // Str 100 + End 100 = 200 → None; 100 + 200 = 300 → Poor.
    const lines = buildCharacterInfoReport(makeSource({ 43: 0 }, [1, 1, 1, 1, 1, 1], [100, 100, 1, 1, 1, 1]));
    expect(lines).toContain('Natural Resistances: None\nDrain Resistances: None\nRegeneration Bonus: Poor');
  });
});

describe('UpdateEnduranceInfo tier thresholds (disassembly @ 0x4b8eb0)', () => {
  it('resist tiers from Str+End', () => {
    expect([200, 201, 260, 261, 320, 321, 380, 381, 440, 441].map(resistTier)).toEqual([
      'None', 'Poor', 'Poor', 'Mediocre', 'Mediocre', 'Hardy', 'Hardy', 'Resilient', 'Resilient', 'Indomitable',
    ]);
  });
  it('regen tiers from Str+2·End', () => {
    expect([200, 201, 346, 347, 470, 471, 580, 581, 690, 691].map(regenTier)).toEqual([
      'None', 'Poor', 'Poor', 'Mediocre', 'Mediocre', 'Hardy', 'Hardy', 'Resilient', 'Resilient', 'Indomitable',
    ]);
  });
});
