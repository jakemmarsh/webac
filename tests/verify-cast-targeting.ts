/**
 * GAP.17 — Tie spells + DAT-driven cast-target resolution.
 *
 * ACE ground truth:
 *  - Player_Magic.cs:436 IsInvalidTarget: a SpellFlags.SelfTargeted (0x8)
 *    spell sent via CastTargetedSpell with target ≠ caster is REJECTED
 *    ("X cannot be cast on Y."); Player_Magic.cs:235 maps a wire target of
 *    the caster's own guid to TargetCategory.Self. Retail always sends self
 *    spells that way (ClientMagicSystem::CastSpell @ 00568040).
 *  - WorldObject_Magic.cs:268: "NonComponentTargetType should be 0 for
 *    untargeted spells" — the ring/blast war spells.
 *  - WorldObject_Magic.cs:955 HandleCastSpell_PortalLink: the Tie spells
 *    are ordinary targeted casts at the portal/lifestone WORLD OBJECT;
 *    linking state (LinkedLifestone / LinkedPortalOneDID) is server-side.
 *
 * Premise correction (task GAP.17 said "no separate 'Lifestone Tie Other'
 * (binding another player) handling"): NO such spell exists. The EoL DAT
 * contains exactly three Tie spells — Primary Portal Tie (47), Lifestone
 * Tie (2644), Secondary Portal Tie (2646) — all SpellType.PortalLink,
 * none self-targeted, no player-target variant. Pinned below.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveCastTarget, SPELL_FLAG_SELF_TARGETED, inqSpellTargetType, spellFormulaTargetingType, targetTypeFromComponentId } from '@ac/shared';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');

const SELF_GUID = 0x50000001;
const COW_GUID = 0x80001234;
const LIFESTONE_GUID = 0x70003333;

describe('GAP.17 — resolveCastTarget (ACE Player_Magic.cs semantics)', () => {
  const SELF = SPELL_FLAG_SELF_TARGETED; // 0x8

  // BUG.heal-self-playscript-missing — retail ClientMagicSystem::CastSpell
  // @ 00568040 sends every SelfTargeted spell as CastTargetedSpell at the
  // player's own id (FreeHandsAndCastSpell @ 00566ef0), never untargeted and
  // never at the selection. ACE's untargeted path drops the TargetEffect
  // PlayScript (DoSpellEffects with a null target).
  it('SelfTargeted spell with a creature selected goes targeted at SELF, never at the selection', () => {
    expect(resolveCastTarget(SELF, 16, COW_GUID, SELF_GUID)).toEqual({ kind: 'targeted', targetGuid: SELF_GUID });
  });

  it('SelfTargeted spell with self explicitly selected goes targeted-at-self (TargetCategory.Self)', () => {
    expect(resolveCastTarget(SELF, 16, SELF_GUID, SELF_GUID))
      .toEqual({ kind: 'targeted', targetGuid: SELF_GUID });
  });

  it('SelfTargeted spell with nothing selected still goes targeted at self', () => {
    expect(resolveCastTarget(SELF, 16, null, SELF_GUID)).toEqual({ kind: 'targeted', targetGuid: SELF_GUID });
  });

  it('untargeted ring/wave (formula target type 0) is always untargeted, selection or not', () => {
    expect(resolveCastTarget(0x3, 0, COW_GUID, SELF_GUID)).toEqual({ kind: 'untargeted' });
    expect(resolveCastTarget(0x3, 0, null, SELF_GUID)).toEqual({ kind: 'untargeted' });
  });

  it('targeted spell (Tie / Other buff / bolt) uses the selection', () => {
    expect(resolveCastTarget(0x0, 0x100, LIFESTONE_GUID, SELF_GUID))
      .toEqual({ kind: 'targeted', targetGuid: LIFESTONE_GUID });
  });

  it('targeted spell with no selection fails locally (retail TargetNotAcquired)', () => {
    expect(resolveCastTarget(0x0, 0x100, null, SELF_GUID)).toEqual({ kind: 'no-target' });
  });

  it('self spell with no player id yet falls back to untargeted (FreeHandsAndCastSpell with id 0)', () => {
    expect(resolveCastTarget(SELF, 16, COW_GUID, null)).toEqual({ kind: 'untargeted' });
    expect(resolveCastTarget(SELF, 16, COW_GUID, 0)).toEqual({ kind: 'untargeted' });
  });
});

describe.skipIf(!existsSync(PORTAL))('GAP.17 — EoL DAT pins: the Tie/Recall spell family', () => {
  async function loadSpellTable() {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader');
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable');
    const db = openDat(PORTAL);
    return new SpellTable(new DatReader(db.getFileData(0x0e00000e)!));
  }

  it('exactly three Tie spells exist — no "Lifestone Tie Other" (premise correction)', async () => {
    const table = await loadSpellTable();
    const ties = [...table.spells.entries()].filter(([, s]) => /\bTie\b/.test(s.name));
    expect(ties.map(([id]) => id).sort((a, b) => a - b)).toEqual([47, 2644, 2646]);
    for (const [, s] of ties) {
      expect(s.metaSpellType).toBe(5); // SpellType.PortalLink
      expect(s.bitfield & SPELL_FLAG_SELF_TARGETED).toBe(0); // world-object targeted
    }
  });

  it('Lifestone Tie (2644) resolves to a targeted cast at the selected lifestone', async () => {
    const table = await loadSpellTable();
    const tie = table.spells.get(2644)!;
    expect(tie.name).toBe('Lifestone Tie');
    expect(resolveCastTarget(tie.bitfield, inqSpellTargetType(tie.formula), LIFESTONE_GUID, SELF_GUID))
      .toEqual({ kind: 'targeted', targetGuid: LIFESTONE_GUID });
    expect(resolveCastTarget(tie.bitfield, inqSpellTargetType(tie.formula), null, SELF_GUID))
      .toEqual({ kind: 'no-target' });
  });

  it('the recall family is SelfTargeted → targeted-at-self wire casts even with a selection', async () => {
    const table = await loadSpellTable();
    // Primary Portal Recall, Lifestone Recall, Lifestone Sending,
    // Portal Recall, Secondary Portal Recall — all PortalRecall type + 0x8.
    for (const id of [48, 1635, 1636, 2645, 2647]) {
      const s = table.spells.get(id)!;
      expect(s.metaSpellType).toBe(6); // SpellType.PortalRecall
      expect(s.bitfield & SPELL_FLAG_SELF_TARGETED).toBe(SPELL_FLAG_SELF_TARGETED);
      expect(resolveCastTarget(s.bitfield, inqSpellTargetType(s.formula), COW_GUID, SELF_GUID))
        .toEqual({ kind: 'targeted', targetGuid: SELF_GUID });
    }
  });

  it('Heal Self VI (1161) is SelfTargeted with TargetEffect 31 (HealthUpRed) → cast at self so ACE broadcasts it', async () => {
    const table = await loadSpellTable();
    const heal = table.spells.get(1161)!;
    expect(heal.name).toBe('Heal Self VI');
    expect(heal.targetEffect).toBe(31);
    expect(heal.bitfield & SPELL_FLAG_SELF_TARGETED).toBe(SPELL_FLAG_SELF_TARGETED);
    expect(resolveCastTarget(heal.bitfield, inqSpellTargetType(heal.formula), null, SELF_GUID))
      .toEqual({ kind: 'targeted', targetGuid: SELF_GUID });
  });

  // SWEEP1006B.magic-casting.cast-targeting-uses-dat-noncomponenttargettype —
  // retail CastSpell @ 00568040 reads CSpellBase::InqTargetType @ 00597230
  // (the base formula's last talisman via GetTargetTypeFromComponentID @
  // 005bbf50), never NonComponentTargetType. The two disagree for 46
  // non-self spells in both directions.
  it('Frost Blast VI (110): NCT says untargeted, the formula says Creature → needs a selection', async () => {
    const table = await loadSpellTable();
    const s = table.spells.get(110)!;
    expect(s.name).toBe('Frost Blast VI');
    expect(s.nonComponentTargetType).toBe(0);
    expect(inqSpellTargetType(s.formula)).toBe(0x10);
    expect(resolveCastTarget(s.bitfield, inqSpellTargetType(s.formula), null, SELF_GUID)).toEqual({ kind: 'no-target' });
    expect(resolveCastTarget(s.bitfield, inqSpellTargetType(s.formula), COW_GUID, SELF_GUID)).toEqual({ kind: 'targeted', targetGuid: COW_GUID });
  });

  it('Acid Wave (3946): NCT says Creature, the formula says untargeted → cast untargeted', async () => {
    const table = await loadSpellTable();
    const s = table.spells.get(3946)!;
    expect(s.nonComponentTargetType).toBe(0x10);
    expect(inqSpellTargetType(s.formula)).toBe(0);
    expect(resolveCastTarget(s.bitfield, inqSpellTargetType(s.formula), null, SELF_GUID)).toEqual({ kind: 'untargeted' });
  });

  it('Blade Bane I (37) → 0x88b8f item mask; Primary Portal Tie (47) → 0x10010000', async () => {
    const table = await loadSpellTable();
    expect(inqSpellTargetType(table.spells.get(37)!.formula)).toBe(0x88b8f);
    expect(inqSpellTargetType(table.spells.get(47)!.formula)).toBe(0x10010000);
  });
});

describe('SWEEP1006B — formula targeting type (SpellFormula::GetTargetingType @ 005bc910)', () => {
  it('GetTargetTypeFromComponentID @ 005bbf50 maps the talismans', () => {
    for (const id of [0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x3c, 0x3d, 0x3e, 0xbe]) expect(targetTypeFromComponentId(id)).toBe(0x10);
    expect(targetTypeFromComponentId(0x39)).toBe(0x88b8f);
    expect(targetTypeFromComponentId(0x3b)).toBe(0x10010000);
    expect(targetTypeFromComponentId(0x3a)).toBe(0);
    expect(targetTypeFromComponentId(0x3f)).toBe(0);
  });

  it('reads the last non-zero of comps[5..7], or comps[4] when comps[5] is empty', () => {
    expect(spellFormulaTargetingType([1, 2, 3, 4, 0x39])).toBe(0x88b8f); // comps[5] = 0 → comps[4]
    expect(spellFormulaTargetingType([1, 2, 3, 4, 5, 0x31])).toBe(0x10);
    expect(spellFormulaTargetingType([1, 2, 3, 4, 5, 6, 0x3b])).toBe(0x10010000);
    expect(spellFormulaTargetingType([1, 2, 3, 4, 5, 6, 7, 0x3a])).toBe(0);
  });

  it('InqTargetType is 0 for an incomplete formula (SpellFormula::Complete @ 005bc880: comps[0..4] all set); GetTargetingType alone is not', () => {
    expect(inqSpellTargetType([1, 2, 3, 0x31])).toBe(0);
    expect(spellFormulaTargetingType([1, 2, 3, 0x31])).toBe(0); // comps[4] = 0 → id 0 → 0
    expect(inqSpellTargetType([1, 2, 3, 4, 0x31])).toBe(0x10);
  });
});
