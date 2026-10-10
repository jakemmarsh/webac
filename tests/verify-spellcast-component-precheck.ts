/**
 * BUG.spellcast-cost-components — the retail client's local component
 * pre-check (ClientMagicSystem::CastSpell @ 00568040): when PlayerDesc bool
 * 68 SpellComponentsRequired is set, every component of the account-
 * customized formula must be OWNED (ComponentTracker::ComponentIsOwned
 * @ 00586480) or the cast is dropped with the 0x1a spew
 * "You do not have all of this spell's components" (@ 350254).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import {
  spellComponentsSatisfied, SPELL_COMPONENTS_MISSING_TEXT, SPELL_COMPONENT_DID_MAPPER_ID,
  getPlayerFormula, appropriateSpellFormula, scarabOnlyFormula, componentPowerLevel,
  INFUSED_MAGIC_AUGMENTATION_INT, PRISMATIC_TAPER_COMPONENT_ID,
} from '../packages/shared/src/index';
import { CLIENT_NOTICES, raiseClientNotice } from '../packages/renderer/src/ui/ClientNotices';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase';
import { DatReader } from '../packages/dat-parser/src/DatReader';
import { readDualDidMapper } from '../packages/dat-parser/src/file-types/DualDidMapper';
import { readDidMapper } from '../packages/dat-parser/src/file-types/DidMapper';
import { SpellTable } from '../packages/dat-parser/src/file-types/SpellTable';
import { openDat } from './_harness/dat.js';

const LEAD_SCARAB = 1;
const LEAD_SCARAB_WCID = 691;

describe('spellComponentsSatisfied (retail CastSpell gate)', () => {
  const map = new Map<number, number>([[1, 691], [2, 689], [50, 7000]]);

  it('passes without looking at inventory when components are not required', () => {
    let asked = false;
    expect(spellComponentsSatisfied(false, [1, 2, 99], map, () => { asked = true; return false; })).toBe(true);
    expect(asked).toBe(false);
  });

  it('passes when every component WCID is owned (ownership, not counts)', () => {
    const owned = new Set([691, 689, 7000]);
    expect(spellComponentsSatisfied(true, [1, 2, 50, 50], map, (w) => owned.has(w))).toBe(true);
  });

  it('fails when any single component is not owned', () => {
    const owned = new Set([691, 7000]);
    expect(spellComponentsSatisfied(true, [1, 2, 50], map, (w) => owned.has(w))).toBe(false);
  });

  it('fails for an unmapped component id (SCIDtoWCID → INVALID_DID 0, never owned)', () => {
    expect(spellComponentsSatisfied(true, [1, 123], map, () => true)).toBe(false);
  });

  it('ignores empty formula slots', () => {
    expect(spellComponentsSatisfied(true, [1, 0, 0], map, (w) => w === 691)).toBe(true);
  });
});

describe('castMissingComponents notice', () => {
  it('uses the verbatim retail string and the spew sink', () => {
    expect(SPELL_COMPONENTS_MISSING_TEXT).toBe("You do not have all of this spell's components");
    const n = CLIENT_NOTICES.castMissingComponents;
    expect(n.text).toBe(SPELL_COMPONENTS_MISSING_TEXT);
    expect(n.sink).toBe('spew');
    const shown: string[] = [];
    const sink = raiseClientNotice({ displayErrorText: (t: string) => { shown.push(t); } } as never, n);
    expect(sink).toBe('spew');
    expect(shown).toEqual([SPELL_COMPONENTS_MISSING_TEXT]);
  });
});

/**
 * RELEASE.gdle-untested-surfaces — ClientMagicSystem::GetAppropriateSpellFormula
 * @ 00567d50: the gate walks CSpellBase::InqScarabOnlyFormula @ 00597050 when
 * the caster owns the school's foci or has its Infused augmentation. GDLE
 * sends SpellComponentsRequired = true, so a fresh Item-magic character
 * (Foci of Artifice + Prismatic Tapers, no herbs or powders) was refused
 * every cast locally.
 */
describe('GetAppropriateSpellFormula (foci and Infused augmentations)', () => {
  const TAPER = PRISMATIC_TAPER_COMPONENT_ID;
  // Lead Scarab, a herb, a powder, a potion, a talisman, two tapers.
  const BASE = [1, 0x2a, 0x20, 0x31, 0x50, 0x3f, 0x40];
  const FOCI = new Map([[1, 15271], [2, 15270], [3, 15269], [4, 15268], [5, 43173]]);
  const customized = () => [1, 0x2a, 0x20, 0x31, 0x50, 0x45, 0x46];

  it('keeps the scarabs and adds Prismatic Tapers by the strongest scarab\'s power', () => {
    expect(scarabOnlyFormula(BASE)).toEqual([1, TAPER]);
    expect(scarabOnlyFormula([2, 0x2a, 0x3f])).toEqual([2, TAPER, TAPER]);
    expect(scarabOnlyFormula([4, 0x2a])).toEqual([4, TAPER, TAPER, TAPER]);
    expect(scarabOnlyFormula([0x6e, 0x2a])).toEqual([0x6e, TAPER, TAPER, TAPER]); // Diamond, power 7
    expect(scarabOnlyFormula([0xc1, 0x2a])).toEqual([0xc1, TAPER, TAPER, TAPER, TAPER]); // Mana, power 10
    // Stops at the first empty slot, as the decomp's loop does.
    expect(scarabOnlyFormula([0, 3])).toEqual([]);
    expect([1, 2, 3, 4, 5, 6, 0x6e, 0x70, 0xc0, 0xc1, 0x6f, 0x2a].map(componentPowerLevel)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 0]);
  });

  it('owning the school\'s foci (or its Infused augmentation) picks the scarab-only formula', () => {
    const base = { baseFormula: BASE, customizedFormula: customized, fociWcidBySchool: FOCI };
    // Item magic (school 3) with Foci of Artifice in the pack.
    expect(appropriateSpellFormula({ ...base, school: 3, ownsWcid: (w) => w === 15269, intProperty: () => undefined })).toEqual([1, TAPER]);
    // Another school's foci does not count.
    expect(appropriateSpellFormula({ ...base, school: 1, ownsWcid: (w) => w === 15269, intProperty: () => undefined })).toEqual(customized());
    // Infused War Magic (int 0x129) without a foci.
    expect(INFUSED_MAGIC_AUGMENTATION_INT[1]).toBe(0x129);
    expect(appropriateSpellFormula({ ...base, school: 1, ownsWcid: () => false, intProperty: (k) => (k === 0x129 ? 1 : undefined) })).toEqual([1, TAPER]);
    expect(appropriateSpellFormula({ ...base, school: 5, ownsWcid: () => false, intProperty: (k) => (k === 0x148 ? 1 : 0) })).toEqual([1, TAPER]);
    // Neither: the account-customized formula, as before.
    expect(appropriateSpellFormula({ ...base, school: 3, ownsWcid: () => false, intProperty: () => 0 })).toEqual(customized());
  });

  it('a foci caster with tapers passes the gate; without the foci the herbs are still required', () => {
    const scid = new Map([[1, 691], [0x2a, 7001], [0x20, 7002], [0x31, 7003], [0x50, 7004], [0x45, 7005], [0x46, 7006], [TAPER, 20631]]);
    const owned = new Set([691, 20631, 15269]);
    const pick = (ownsFoci: boolean) => appropriateSpellFormula({
      school: 3, baseFormula: BASE, customizedFormula: customized, fociWcidBySchool: FOCI,
      ownsWcid: (w) => (w === 15269 ? ownsFoci : owned.has(w)), intProperty: () => undefined,
    });
    expect(spellComponentsSatisfied(true, pick(true), scid, (w) => owned.has(w))).toBe(true);
    expect(spellComponentsSatisfied(true, pick(false), scid, (w) => owned.has(w))).toBe(false);
  });
});

const PORTAL = 'dat/client_portal.dat';
describe.skipIf(!existsSync(PORTAL))('component pre-check against the EoL portal DAT', () => {
  let wcids: ReadonlyMap<number, number>;
  let spells: SpellTable;
  beforeAll(() => {
    const db = openDat(PORTAL);
    wcids = readDualDidMapper(new DatReader(db.getFileData(SPELL_COMPONENT_DID_MAPPER_ID)!)).client.enumToId;
    spells = new SpellTable(new DatReader(db.getFileData(0x0E00000E)!));
  });

  it('SchoolOfMagic2WCID: master 0x25000005 [4] is the foci map 0x27000003', () => {
    const db = openDat(PORTAL);
    const master = readDidMapper(new DatReader(db.getFileData(0x25000005)!));
    expect(master.client.enumToName.get(4)).toBe('SchoolOfMagic');
    expect(master.client.enumToId.get(4)).toBe(0x27000003);
    const foci = readDualDidMapper(new DatReader(db.getFileData(0x27000003)!)).client.enumToId;
    expect([1, 2, 3, 4, 5].map((s) => foci.get(s))).toEqual([15271, 15270, 15269, 15268, 43173]);
    // Prismatic Taper is component 0xbc.
    expect(wcids.get(PRISMATIC_TAPER_COMPONENT_ID)).toBeGreaterThan(0);
  });

  it('maps Lead Scarab (component 1) to WCID 691, like ACE Spell.GetComponentWCID', () => {
    expect(wcids.get(LEAD_SCARAB)).toBe(LEAD_SCARAB_WCID);
  });

  it('Strength Other I: blocked with an empty pack, allowed once every formula component is owned', () => {
    const spell = spells.spells.get(1)!; // Strength Other I
    const formula = getPlayerFormula(spell.formula, spell.formulaVersion, 'testacjs');
    expect(formula.filter(Boolean).length).toBeGreaterThan(0);
    expect(spellComponentsSatisfied(true, formula, wcids, () => false)).toBe(false);
    const owned = new Set(formula.map((c) => wcids.get(c)!));
    expect(spellComponentsSatisfied(true, formula, wcids, (w) => owned.has(w))).toBe(true);
    // One component short → blocked.
    const firstWcid = wcids.get(formula[0])!;
    expect(spellComponentsSatisfied(true, formula, wcids, (w) => w !== firstWcid && owned.has(w))).toBe(false);
  });
});
