/**
 * webac#9 — item enchantments cast at a selected item said "You must select a
 * suitable target before casting this spell" (AC1999, Blood Drinker II on a
 * selected Yumi). Two faults:
 *
 *  1. Every era: the cast read only the world selection (currentTargetGuid),
 *     which an inventory / paperdoll click clears, instead of the one global
 *     selection retail reads (ACCWeenieObject::selectedID; the 1999 client's
 *     UI_CastSpell @ 0x4d1bd0 reads the global @ 0x6576f4 via 0x4c8300 at
 *     0x4d1d82 and refuses with 0x6000a4 only when it is 0). planSpellCast
 *     takes that selection.
 *  2. AC1999: the cast used end of retail's talisman table and self rule. The
 *     1999 client.exe's switch @ 0x5e4150 maps Ashwood to 0xa090f and Hazel to
 *     0x10000 (end of retail: 0x88b8f, 0x10010000; 0x3a 0 vs Creature), and its
 *     ObjectCompatibleWithSpellTargetType @ 0x4d20c0 has no 0x8107 exception.
 *     Both ride EraClientRules (talismanTargetTypes, spellSelfTargetableTypeMask).
 *
 * End of retail and the classic (Dark Majesty) eras keep their values, pinned here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  TALISMAN_TARGET_TYPES_1999, TALISMAN_TARGET_TYPES_EOR, inqSpellTargetType, spellFormulaTargetingType, targetTypeFromComponentId,
} from '../packages/shared/src/index.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { planSpellCast, objectCompatibleWithSpellTargetType, type SpellTargetObject } from '../packages/renderer/src/ui/SpellShortcutBar.js';
import { spellTargetType1999 } from '../packages/dat-parser/src/era1999/Tables1999.js';
import { AgentApi, isArmorRedirectBuff, spellCastsOnYou } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentSpell } from '../packages/renderer/src/agent/types.ts';
import { FakeHost } from './_harness/agentFake.ts';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { SpellTable, type SpellBase } from '../packages/dat-parser/src/file-types/SpellTable.js';

const EOR = eraClientRules(eraProfile('eor'));
const DM = eraClientRules(eraProfile('classicace-customdm'));
const CD = eraClientRules(eraProfile('classic-dereth'));
const R99 = eraClientRules(eraProfile('ac1999-retail'));

const ME = 0x50000001;
const BOW = 0x80000a01; // a Yumi in a side pack
const DRUDGE = 0x80000b02;
const PORTAL = 0x7a9b0001;
const LIFESTONE = 0x7a9b0002;
const ARROWS = 0x80000a03;
const objects = new Map<number, SpellTargetObject>([
  [ME, { isSelf: true, itemType: 0x10, isPlayer: true, objectDescFlags: 0x8, name: 'Kaine' }],
  [BOW, { isSelf: false, itemType: 0x100, stackSize: 1, isPlayer: false, objectDescFlags: 0x10, name: 'Yumi' }],
  [DRUDGE, { isSelf: false, itemType: 0x10, isPlayer: false, objectDescFlags: 0x10, name: 'Drudge Skulker' }],
  [PORTAL, { isSelf: false, itemType: 0x10000, isPlayer: false, objectDescFlags: 0x10, name: 'Portal to Arwic' }],
  [LIFESTONE, { isSelf: false, itemType: 0x10000000, isPlayer: false, objectDescFlags: 0x10, name: 'Life Stone' }],
  [ARROWS, { isSelf: false, itemType: 0x100, stackSize: 40, isPlayer: false, objectDescFlags: 0x10, name: 'Arrow' }],
]);
const targetObjectFor = (g: number) => objects.get(g) ?? null;

// Formulas from the 1999 portal.dat (component ids decimal; 57 = Ashwood 0x39, 59 = Hazel 0x3b).
const BLOOD_DRINKER_II = { bitfield: 0x4, formula: [2, 71, 7, 36, 43, 57], spellName: 'Blood Drinker II' };
const STRENGTH_OTHER_I = { bitfield: 0x6, formula: [1, 7, 33, 44, 49], spellName: 'Strength Other I' };
const STRENGTH_SELF_I = { bitfield: 0xc, formula: [1, 7, 33, 44, 60], spellName: 'Strength Self I' };
const FLAME_BOLT_I = { bitfield: 0x3, formula: [1, 15, 34, 46, 55], spellName: 'Flame Bolt I' };
const PORTAL_TIE = { bitfield: 0x0, formula: [3, 73, 21, 72, 32, 42, 59], spellName: 'Portal Tie' };
/** End of retail's untargeted shape (last talisman Elder 0x3a): untargeted there, Creature in 1999. */
const ELDER_LAST = { bitfield: 0x0, formula: [2, 0x42, 0x42, 0x42, 0x3f, 0x3f, 0x3a], spellName: 'Ring' };

const plan = (spell: { bitfield: number; formula: number[]; spellName: string }, selectedGuid: number | null, rules = R99) =>
  planSpellCast({ ...spell, selectedGuid, selfGuid: ME, targetObjectFor, rules });

describe('the era talisman tables', () => {
  it('end of retail is unchanged (GetTargetTypeFromComponentID @ 005bbf50)', () => {
    for (let c = 0x31; c <= 0x38; c++) expect(targetTypeFromComponentId(c)).toBe(0x10);
    expect([0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0xbe, 0x30, 0x3f].map((c) => targetTypeFromComponentId(c)))
      .toEqual([0x88b8f, 0, 0x10010000, 0x10, 0x10, 0x10, 0x10, 0, 0]);
    expect(targetTypeFromComponentId(0x39, TALISMAN_TARGET_TYPES_EOR)).toBe(0x88b8f);
  });

  it('1999 is the client.exe switch @ 0x5e4150', () => {
    for (let c = 0x31; c <= 0x38; c++) expect(targetTypeFromComponentId(c, TALISMAN_TARGET_TYPES_1999)).toBe(0x10);
    expect([0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0xbe, 0x30, 0x3f].map((c) => targetTypeFromComponentId(c, TALISMAN_TARGET_TYPES_1999)))
      .toEqual([0xa090f, 0x10, 0x10000, 0x10, 0x10, 0x10, 0, 0, 0]);
    // The SpellTable transcoder writes the same as the 1999 NonComponentTargetType.
    expect(spellTargetType1999([2, 71, 7, 36, 43, 57, 0, 0])).toBe(0xa090f);
    expect(spellTargetType1999([3, 73, 21, 72, 32, 42, 59, 0])).toBe(0x10000);
    expect(spellFormulaTargetingType(ELDER_LAST.formula, TALISMAN_TARGET_TYPES_1999)).toBe(0x10);
    expect(spellFormulaTargetingType(ELDER_LAST.formula)).toBe(0);
  });

  const EXE = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'client.exe');
  describe.skipIf(!existsSync(EXE))('against the 1999 client.exe', () => {
    let exe: Buffer;
    beforeAll(() => { exe = readFileSync(EXE); });
    /** client.exe VA → file offset (.text: VA 0x401000 at raw 0x1000; image base 0x400000, file-aligned sections). */
    const vaToOffset = (va: number): number => {
      const pe = exe.readUInt32LE(0x3c);
      const nSections = exe.readUInt16LE(pe + 6);
      const optSize = exe.readUInt16LE(pe + 20);
      const base = exe.readUInt32LE(pe + 24 + 28);
      for (let i = 0; i < nSections; i++) {
        const s = pe + 24 + optSize + i * 40;
        const vaddr = exe.readUInt32LE(s + 12), vsize = exe.readUInt32LE(s + 8), raw = exe.readUInt32LE(s + 20);
        if (va - base >= vaddr && va - base < vaddr + vsize) return raw + (va - base - vaddr);
      }
      throw new Error(`VA 0x${va.toString(16)} not in a section`);
    };
    it('TALISMAN_TARGET_TYPES_1999 is what the switch @ 0x5e4150 returns for every component id', () => {
      // sub ecx,0x31; cmp 0xd; movzx index byte @ 0x5e41d5; jmp [index*4 + 0x5e41b9]; each case: mov [ebp-4], imm32.
      const off = vaToOffset(0x5e4150);
      expect(exe.subarray(off + 0x19, off + 0x23)).toEqual(Buffer.from([0x83, 0xe9, 0x31, 0x89, 0x4d, 0xf4, 0x83, 0x7d, 0xf4, 0x0d]));
      const jt = vaToOffset(0x5e41b9), ix = vaToOffset(0x5e41d5);
      const caseValue = (va: number): number => {
        const o = vaToOffset(va);
        expect(exe.subarray(o, o + 3)).toEqual(Buffer.from([0xc7, 0x45, 0xfc])); // mov dword ptr [ebp-4], imm32
        return exe.readUInt32LE(o + 3);
      };
      const decoded: Record<number, number> = {};
      for (let c = 0x31; c <= 0x3e; c++) {
        const v = caseValue(exe.readUInt32LE(jt + exe[ix + c - 0x31] * 4));
        if (v !== 0) decoded[c] = v;
      }
      expect(decoded).toEqual({ ...TALISMAN_TARGET_TYPES_1999 });
    });
  });
});

describe('EraClientRules', () => {
  it('end of retail and the classic eras keep end of retail\'s table and 0x8107', () => {
    for (const r of [EOR, DM, CD, eraClientRules(null)]) {
      expect(r.talismanTargetTypes).toBe(TALISMAN_TARGET_TYPES_EOR);
      expect(r.spellSelfTargetableTypeMask).toBe(0x8107);
    }
  });
  it('AC1999 has the 1999 table and no self exception', () => {
    expect(R99.talismanTargetTypes).toBe(TALISMAN_TARGET_TYPES_1999);
    expect(R99.spellSelfTargetableTypeMask).toBe(0);
  });
});

describe('planSpellCast (ClientMagicSystem::CastSpell; 1999 UI_CastSpell @ 0x4d1bd0)', () => {
  it('webac#9: Blood Drinker II at a selected Yumi in a pack is sent at the bow, in every era', () => {
    for (const r of [R99, EOR, DM]) {
      expect(plan(BLOOD_DRINKER_II, BOW, r)).toEqual({ kind: 'send', targetGuid: BOW, castingText: 'Casting Blood Drinker II' });
    }
  });

  it('nothing selected: "You must select a suitable target" (no-target), every era', () => {
    for (const r of [R99, EOR]) {
      expect(plan(BLOOD_DRINKER_II, null, r)).toEqual({ kind: 'no-target' });
      expect(plan(BLOOD_DRINKER_II, 0, r)).toEqual({ kind: 'no-target' });
      expect(plan(STRENGTH_OTHER_I, null, r)).toEqual({ kind: 'no-target' });
      expect(plan(FLAME_BOLT_I, null, r)).toEqual({ kind: 'no-target' });
    }
  });

  it('item spell with yourself selected: 1999 refuses ("You cannot cast this spell upon yourself"); end of retail sends it (0x8107)', () => {
    expect(plan(BLOOD_DRINKER_II, ME, R99)).toEqual({ kind: 'refused', targetGuid: ME, refusal: 'self', text: 'You cannot cast this spell upon yourself' });
    expect(plan(BLOOD_DRINKER_II, ME, EOR)).toEqual({ kind: 'send', targetGuid: ME, castingText: 'Casting Blood Drinker II' });
  });

  it('item spell at a creature: 1999 refuses (bare T & InqType @ 0x4d21cd); end of retail lets 0x8107 through', () => {
    expect(plan(BLOOD_DRINKER_II, DRUDGE, R99)).toEqual({ kind: 'refused', targetGuid: DRUDGE, refusal: 'incompatible', text: 'This spell cannot be cast on Drudge Skulker' });
    expect(plan(BLOOD_DRINKER_II, DRUDGE, EOR).kind).toBe('send');
  });

  it('a stack is refused in both', () => {
    for (const r of [R99, EOR]) expect(plan(BLOOD_DRINKER_II, ARROWS, r)).toMatchObject({ kind: 'refused', refusal: 'stack', text: 'Cannot cast spell on a stack of items.' });
  });

  it('creature Other / war bolt: sent at a creature, refused at an item and at yourself, in both', () => {
    for (const r of [R99, EOR]) {
      for (const s of [STRENGTH_OTHER_I, FLAME_BOLT_I]) {
        expect(plan(s, DRUDGE, r)).toEqual({ kind: 'send', targetGuid: DRUDGE, castingText: `Casting ${s.spellName}` });
        expect(plan(s, BOW, r)).toMatchObject({ kind: 'refused', refusal: 'incompatible' });
        expect(plan(s, ME, r)).toMatchObject({ kind: 'refused', refusal: 'self' });
      }
    }
  });

  it('Self spells go at you whatever is selected, without a Casting line, in both', () => {
    for (const r of [R99, EOR]) for (const sel of [null, BOW, DRUDGE]) {
      expect(plan(STRENGTH_SELF_I, sel, r)).toEqual({ kind: 'send', targetGuid: ME, castingText: null });
    }
  });

  it('Portal Tie: a portal in both; a lifestone only where the Hazel mask has the lifestone bit (end of retail)', () => {
    for (const r of [R99, EOR]) expect(plan(PORTAL_TIE, PORTAL, r).kind).toBe('send');
    expect(plan(PORTAL_TIE, LIFESTONE, R99)).toMatchObject({ kind: 'refused', refusal: 'incompatible' });
    expect(plan(PORTAL_TIE, LIFESTONE, EOR).kind).toBe('send');
  });

  it('an Elder-last formula: untargeted in end of retail, a Creature spell in 1999', () => {
    expect(plan(ELDER_LAST, DRUDGE, EOR)).toEqual({ kind: 'send', targetGuid: null, castingText: null });
    expect(plan(ELDER_LAST, null, R99)).toEqual({ kind: 'no-target' });
    expect(plan(ELDER_LAST, DRUDGE, R99).kind).toBe('send');
  });

  it('the Cast button\'s quiet check takes the era mask (end of retail default unchanged)', () => {
    expect(objectCompatibleWithSpellTargetType(0x88b8f, objects.get(ME)!)).toBe(true);
    expect(objectCompatibleWithSpellTargetType(0xa090f, objects.get(ME)!, 0)).toBe(false);
    expect(objectCompatibleWithSpellTargetType(0xa090f, objects.get(BOW)!, 0)).toBe(true);
  });
});

describe('the agent tools follow the era\'s self rule', () => {
  const BD2_99: AgentSpell = { id: 1, name: 'Blood Drinker II', school: 'Item Enchantment', level: 2, buff: true, targetType: 0xa090f };
  const IMPEN_EOR: AgentSpell = { id: 1483, name: 'Impenetrability V', school: 'Item Enchantment', level: 5, buff: true, targetType: 0x6 };
  it('end of retail unchanged; 1999 never casts an item spell at you or redirects it to your armor', () => {
    expect(spellCastsOnYou(IMPEN_EOR)).toBe(true);
    expect(isArmorRedirectBuff(IMPEN_EOR)).toBe(true);
    expect(spellCastsOnYou(BD2_99, 0)).toBe(false);
    expect(isArmorRedirectBuff(BD2_99, 0)).toBe(false);
    expect(isArmorRedirectBuff(IMPEN_EOR, 0)).toBe(false);
    expect(spellCastsOnYou({ ...BD2_99, self: true }, 0)).toBe(true);
  });
  it('AgentApi reads the host\'s mask (absent = end of retail)', async () => {
    const host = new FakeHost();
    host.spells = () => [BD2_99];
    const api = new AgentApi(host);
    expect(api.selfTargetableTypeMask()).toBe(0x8107);
    expect(api.castsOnYou(BD2_99)).toBe(true);
    host.spellSelfTargetableTypeMask = () => R99.spellSelfTargetableTypeMask;
    expect(api.castsOnYou(BD2_99)).toBe(false);
    const r = await api.cast('Blood Drinker II', 'self');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/can't be cast on yourself/);
    expect(host.sent.filter((s) => s.startsWith('cast'))).toEqual([]);
    const none = await api.cast('Blood Drinker II', null);
    expect(none.ok).toBe(false);
    expect(none.message).toMatch(/the weapon or armor to cast it on/);
  });
});

const AC1999_PORTAL = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'portal.dat');
describe.skipIf(!existsSync(AC1999_PORTAL))('the real 1999 SpellTable', () => {
  let spells: SpellBase[];
  beforeAll(() => {
    const portal = new DatDatabase(new FileDatBytes(AC1999_PORTAL));
    portal.setOverlay(ac1999PortalOverlay());
    spells = [...new SpellTable(new DatReader(portal.getFileData(0x0e00000e)!)).spells.values()];
  });

  it('every spell\'s formula target type through the 1999 table is its transcoded NonComponentTargetType', () => {
    expect(spells.length).toBeGreaterThan(1000);
    for (const s of spells) expect(inqSpellTargetType(s.formula, R99.talismanTargetTypes), s.name).toBe(s.nonComponentTargetType >>> 0);
    // 168 item spells, the one Portal Tie, the rest Creature; no untargeted spell in 1999.
    const byType = new Map<number, number>();
    for (const s of spells) byType.set(s.nonComponentTargetType >>> 0, (byType.get(s.nonComponentTargetType >>> 0) ?? 0) + 1);
    expect(byType.get(0xa090f)).toBe(168);
    expect(byType.get(0x10000)).toBe(1);
    expect(byType.has(0)).toBe(false);
  });

  it('every 1999 item enchantment (Ashwood) plans a send at a selected bow and a refusal at yourself', () => {
    const items = spells.filter((s) => (s.nonComponentTargetType >>> 0) === 0xa090f);
    for (const s of items) {
      const p = planSpellCast({ bitfield: s.bitfield, formula: s.formula, spellName: s.name, selectedGuid: BOW, selfGuid: ME, targetObjectFor, rules: R99 });
      expect(p, s.name).toEqual({ kind: 'send', targetGuid: BOW, castingText: `Casting ${s.name}` });
      expect(planSpellCast({ bitfield: s.bitfield, formula: s.formula, spellName: s.name, selectedGuid: ME, selfGuid: ME, targetObjectFor, rules: R99 }).kind, s.name).toBe('refused');
    }
    expect(items.some((s) => s.name === 'Blood Drinker II')).toBe(true);
  });
});
