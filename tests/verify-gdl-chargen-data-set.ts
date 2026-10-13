/**
 * Seedsow's launch-day create failure (2026-10-12): every create from
 * playwebac.com got CharGenVerificationResponse 5 ("The server cannot create
 * your new character at this time"). 5 is CG_VERIFICATION_RESPONSE_CORRUPT
 * (UNDEF = 0, OK = 1 … CORRUPT = 5, DATABASE_DOWN = 6;
 * reference/classic/ClassicDereth/Source/PhatSDK/GameEnums.h), not
 * DATABASE_DOWN. GDL's CClient::CreateCharacter sends Corrupt when a trained
 * or specialized skill id has no entry in the SERVER's SkillTable
 * (Client.cpp ~L467-501). Seedsow runs Classic Dereth 1.0 data (no
 * Salvaging, 40), like Snowreap on the same host, while the bridge mapped it
 * to the 1.1 era, whose chargen trains Salvaging for free.
 *
 * Live evidence (tools/probe-gdl-chargen.ts through wss://bridge.playwebac.com,
 * one throwaway account, minutes apart): the 1.1 array (41 skills, 40
 * trained) → 5; the same create on the 1.0 table (40 skills) → 1 (Ok). The two
 * payloads below are those exact bytes, with only the account name's digits
 * zeroed (same length).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BinaryReader, buildCharacterCreate, GameMessageOpcode } from '@ac/network';
import { SkillTable, CharacterGenerator, DatReader } from '../packages/dat-parser/src/index.js';
import { SkillAdvancementClass } from '@ac/shared';
import { defaultChargenSkillClasses, chargenTotalNumSkills, EOR_TOTAL_NUM_SKILLS } from '../packages/renderer/src/ui/chargenSkillDefaults';
import { ERA_PROFILES } from '../packages/renderer/src/era/EraProfiles';
import { eraPortalOverlay } from '../packages/renderer/src/era/EraBoot';
import { compatFor } from '../services/ws-tcp-bridge/src/serverCompat';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const CD10 = resolve(REPO, 'dat-sets/classic-dereth-1.0/client_portal.dat');
const CD11 = resolve(REPO, 'dat-sets/classic-dereth-1.1/client_portal.dat');
const hasSets = existsSync(CD10) && existsSync(CD11);

const SEEDSOW = '394c58d0-885d-466b-b17f-d7e0b96fe3e2';
const SNOWREAP = 'eea962c0-cf9f-481e-9736-0eb058acc1d8';

/** Seedsow refused this one with 5 (Corrupt): the 1.1 defaults, Salvaging trained. */
const REFUSED_HEX = '56f600000e0061636a7370726f62653030303030010000000100000001000000000000000000000000000000000000000000000000000000ffffffff00000000000000000000000000000000000000000000000000000000000000000000e03f000000000000e03f0000000000000000000000000000000000000000000000000000000000000000000000003c0000003c0000003c00000032000000320000003200000000000000010000002900000000000000010000000100000001000000020000000100000001000000010000000000000001000000010000000100000001000000010000000100000002000000010000000000000001000000020000000100000001000000020000000100000002000000000000000000000001000000010000000100000001000000010000000100000001000000010000000100000002000000010000000100000001000000020000000600446974757361000000000000000000000000';
/** Seedsow accepted this one (1, Ok): the same create on the 1.0 table. */
const ACCEPTED_HEX = '56f600000e0061636a7370726f62653030303030010000000100000001000000000000000000000000000000000000000000000000000000ffffffff00000000000000000000000000000000000000000000000000000000000000000000e03f000000000000e03f0000000000000000000000000000000000000000000000000000000000000000000000003c0000003c0000003c000000320000003200000032000000000000000100000028000000000000000100000001000000010000000200000001000000010000000100000000000000010000000100000001000000010000000100000001000000020000000100000000000000010000000200000001000000010000000200000001000000020000000000000000000000010000000100000001000000010000000100000001000000010000000100000001000000020000000100000001000000010000000600526962756b75000000000000000000000000';
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

/** ACCharGenResult::CG_UnPack as GDL reads it (after the opcode and account string). */
function gdlUnpack(msg: Uint8Array) {
  const r = new BinaryReader(msg);
  expect(r.readUInt32()).toBe(GameMessageOpcode.CharacterCreate);
  const account = r.readString16();
  expect(r.readUInt32()).toBe(1); // version
  const heritage = r.readUInt32(); const gender = r.readUInt32();
  for (let i = 0; i < 14; i++) r.readUInt32();
  for (let i = 0; i < 6; i++) r.readFloat64();
  const templateNum = r.readInt32();
  const attrs = Array.from({ length: 6 }, () => r.readInt32());
  r.readInt32(); r.readUInt32(); // slot, classID
  const n = r.readInt32();
  const skills = Array.from({ length: n }, () => r.readUInt32());
  const name = r.readString16();
  const startArea = r.readUInt32();
  r.readInt32(); r.readInt32(); // isAdmin, isEnvoy
  return { account, heritage, gender, templateNum, attrs, skills, name, startArea };
}

/**
 * GDL CClient::CreateCharacter's skill loop (reference/classic/ClassicDereth/
 * Source/Client.cpp ~L453-507): Corrupt for a class past Specialized, for a
 * trained/specialized id the server's SkillTable lacks, and past 50 credits.
 */
function gdlSkillVerdict(skills: number[], table: SkillTable, hgSkills: readonly { skillNum: number; normalCost: number; primaryCost: number }[]): 'ok' | 'corrupt' {
  let credits = 0;
  for (let i = 0; i < skills.length; i++) {
    const c = skills[i];
    if (c > SkillAdvancementClass.Specialized) return 'corrupt';
    const base = table.skills.get(i);
    if (!base) {
      if (c === SkillAdvancementClass.Trained || c === SkillAdvancementClass.Specialized) return 'corrupt';
      continue;
    }
    const hg = hgSkills.find((k) => k.skillNum === i);
    if (c === SkillAdvancementClass.Trained) credits += hg ? hg.normalCost : base.trainedCost;
    else if (c === SkillAdvancementClass.Specialized) credits += hg ? hg.primaryCost : base.specializedCost;
  }
  return credits > 50 ? 'corrupt' : 'ok';
}

describe('chargen skill defaults (retail CharGenState::ResetSkillLevels)', () => {
  it('length is one past the highest id; zero-cost skills trained, negative costs inactive, heritage overrides win', () => {
    const table = new Map([
      [1, { trainedCost: 6, specializedCost: 4 }],
      [3, { trainedCost: 0, specializedCost: 4 }],  // free → Trained
      [4, { trainedCost: 0, specializedCost: 0 }],  // free both → Specialized
      [5, { trainedCost: -1, specializedCost: 2 }], // untrainable → Inactive
      [7, { trainedCost: 4, specializedCost: 4 }],  // heritage makes it free
    ]);
    const out = defaultChargenSkillClasses(table, [{ skillNum: 7, normalCost: 0, primaryCost: 2 }]);
    expect(out).toEqual([0, 1, 0, 2, 3, 0, 0, 2]);
    expect(chargenTotalNumSkills(table)).toBe(8);
    expect(chargenTotalNumSkills(null)).toBe(EOR_TOTAL_NUM_SKILLS);
    expect(defaultChargenSkillClasses(null, null)).toEqual(new Array(55).fill(0));
  });
});

describe('Seedsow runs Classic Dereth 1.0 (2026-10-12)', () => {
  it('the bridge names the 1.0 era for Seedsow and Snowreap, and that era serves the SkillTable without Salvaging', () => {
    expect(compatFor(SEEDSOW, 'GDL').era).toBe('classic-dereth-1-0');
    expect(compatFor(SNOWREAP, 'GDL').era).toBe('classic-dereth-1-0');
    expect(ERA_PROFILES['classic-dereth-1-0'].dropSkills).toEqual([40]);
    expect(eraPortalOverlay(ERA_PROFILES['classic-dereth-1-0'])).not.toBeNull();
  });

  it('the live payloads differ only in the skill array and the name: 41 skills with Salvaging trained vs 40', () => {
    const refused = gdlUnpack(bytes(REFUSED_HEX));
    const accepted = gdlUnpack(bytes(ACCEPTED_HEX));
    expect(refused.skills.length).toBe(41);
    expect(refused.skills[40]).toBe(SkillAdvancementClass.Trained);
    expect(accepted.skills.length).toBe(40);
    expect(accepted.skills).toEqual(refused.skills.slice(0, 40));
    expect({ ...refused, skills: null, name: null }).toEqual({ ...accepted, skills: null, name: null });
    expect(accepted).toMatchObject({ account: 'acjsprobe00000', heritage: 1, gender: 1, startArea: 0 });
  });

  describe.skipIf(!hasSets)('on the real Classic Dereth sets', () => {
    let t10: SkillTable; let t11: SkillTable; let t11as10: SkillTable; let cg: CharacterGenerator;
    beforeAll(() => {
      const p10 = openDat(CD10); const p11 = openDat(CD11);
      t10 = new SkillTable(new DatReader(p10.getFileData(0x0e000004)!));
      t11 = new SkillTable(new DatReader(p11.getFileData(0x0e000004)!));
      // What the client reads in the 1.0 era: the hosted 1.1 file through the era's overlay.
      const served = eraPortalOverlay(ERA_PROFILES['classic-dereth-1-0'])!.get(0x0e000004, (id) => p11.getFileData(id)!)!;
      t11as10 = new SkillTable(new DatReader(served));
      cg = new CharacterGenerator(new DatReader(p10.getFileData(0x0e000002)!));
    });

    it("GDL's skill check on 1.0 data refuses the 1.1 payload and accepts the 1.0 one (Seedsow's answers)", () => {
      const hg = cg.heritageGroups.get(1)!.skills;
      expect(gdlSkillVerdict(gdlUnpack(bytes(REFUSED_HEX)).skills, t10, hg)).toBe('corrupt');
      expect(gdlSkillVerdict(gdlUnpack(bytes(ACCEPTED_HEX)).skills, t10, hg)).toBe('ok');
      // On 1.1 data (GDL-Classic's README set, our local server) both pass.
      expect(gdlSkillVerdict(gdlUnpack(bytes(REFUSED_HEX)).skills, t11, hg)).toBe('ok');
    });

    it('our builder with each era\'s table reproduces the live bytes exactly', () => {
      const params = (skills: number[], name: string) => ({
        accountName: 'acjsprobe00000', heritage: 1, gender: 1,
        appearance: { eyes: 0, nose: 0, mouth: 0, hairColor: 0, eyeColor: 0, hairStyle: 0, headgearStyle: 0xffffffff, headgearColor: 0,
          shirtStyle: 0, shirtColor: 0, pantsStyle: 0, pantsColor: 0, footwearStyle: 0, footwearColor: 0,
          skinHue: 0.5, hairHue: 0.5, headgearHue: 0, shirtHue: 0, pantsHue: 0, footwearHue: 0 },
        templateOption: 0, strength: 60, endurance: 60, coordination: 60, quickness: 50, focus: 50, self: 50,
        characterSlot: 0, classId: 1, skills, name, startArea: 0,
      });
      const hg = cg.heritageGroups.get(1)!.skills;
      expect(Buffer.from(buildCharacterCreate(params(defaultChargenSkillClasses(t11.skills, hg), 'Ditusa'))).toString('hex')).toBe(REFUSED_HEX);
      expect(Buffer.from(buildCharacterCreate(params(defaultChargenSkillClasses(t11as10.skills, hg), 'Ribuku'))).toString('hex')).toBe(ACCEPTED_HEX);
      // The 1.0 era's served table is the real 1.0 file's.
      expect(defaultChargenSkillClasses(t11as10.skills, hg)).toEqual(defaultChargenSkillClasses(t10.skills, hg));
    });
  });
});
