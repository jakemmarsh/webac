/**
 * 1999 spellcasting data: the spell-component id → WCID map (a synthetic
 * DualDidMapper 0x27000002 built from the 1999 client's hardcoded
 * SpellComponentTable::SCIDtoWCID @ 0x5e41f0), the SpellComponentTable's
 * NUL-free names, and the formula version (the 1999 client and server always
 * personalize with RandomizeVersion1). Drives the real overlay, parsers,
 * getPlayerFormula and the retail CastSpell component pre-check.
 * Real-file checks skip when dat-sets/ac1999-retail (or dat/) is absent (CI).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { DatWriter } from '../packages/dat-parser/src/era1999/DatWriter.js';
import {
  SPELL_COMPONENT_MAPPER_ID,
  SPELL_COMPONENT_WCIDS_1999,
  SPELL_FORMULA_VERSION_1999,
  synthesizeSpellComponentMapper1999,
  transcodeSpellComponentTable1999,
  transcodeSpellTable1999,
} from '../packages/dat-parser/src/era1999/Tables1999.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { readDualDidMapper } from '../packages/dat-parser/src/file-types/DualDidMapper.js';
import { SpellComponentTable } from '../packages/dat-parser/src/file-types/SpellComponentTable.js';
import { SpellTable, computeSpellHash } from '../packages/dat-parser/src/file-types/SpellTable.js';
import { getPlayerFormula, spellComponentsSatisfied, SPELL_COMPONENT_DID_MAPPER_ID } from '@ac/shared';
import { characterMessageAccount } from '../packages/renderer/src/session/ServerAccountName.js';
import { openDat } from './_harness/dat.js';

/** WCIDtoSCID @ 0x5e46a0's blocks (reference/ac1999 SpellComponentTable.h). */
const BLOCKS_1999: Array<[number, number]> = [[625, 627], [686, 691], [740, 792], [1643, 1654]];
const inBlocks = (wcid: number) => BLOCKS_1999.some(([a, b]) => wcid >= a && wcid <= b);

const bytesOf = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
const swapNibbles = (b: Uint8Array): Uint8Array => b.map((x) => ((x >> 4) | (x << 4)) & 0xff);
/** 1999 AcString: u16 length incl. NUL, bytes, NUL, pad 4. */
const acString = (w: DatWriter, b: Uint8Array): DatWriter => w.writeUInt16(b.length + 1).writeBytes(b).writeUInt8(0).align(4);

describe('synthetic DualDidMapper 0x27000002 (1999 SCIDtoWCID)', () => {
  it('parses whole with readDualDidMapper and maps all 74 component ids, one wcid each, inside the 1999 blocks', () => {
    const r = new DatReader(synthesizeSpellComponentMapper1999());
    const m = readDualDidMapper(r);
    expect(r.remaining).toBe(0);
    expect(m.id).toBe(SPELL_COMPONENT_DID_MAPPER_ID);
    expect(SPELL_COMPONENT_MAPPER_ID).toBe(SPELL_COMPONENT_DID_MAPPER_ID);
    expect([...m.client.enumToId.keys()]).toEqual(Array.from({ length: 74 }, (_, i) => i + 1));
    const wcids = [...m.client.enumToId.values()];
    expect(new Set(wcids).size).toBe(74);
    for (const w of wcids) expect(inBlocks(w)).toBe(true);
    // The four blocks hold exactly 74 wcids: the map is a bijection onto them.
    expect(BLOCKS_1999.reduce((n, [a, b]) => n + b - a + 1, 0)).toBe(74);
    expect(m.client.enumToId.get(1)).toBe(691); // Lead Scarab
    expect(m.client.enumToId.get(61)).toBe(751); // Willow Talisman
    expect(m.client.enumToId.get(63)).toBe(1650); // Red Taper
    expect(m.server.enumToId.size).toBe(0);
  });

  it('the portal overlay serves it over any base (a raw 1999 portal or a streamed, already-translated set)', () => {
    for (const translatedBase of [false, true]) {
      const ov = ac1999PortalOverlay({ translatedBase });
      const bytes = ov.get(SPELL_COMPONENT_MAPPER_ID, () => null)!;
      expect(readDualDidMapper(new DatReader(bytes)).client.enumToId.size).toBe(74);
      expect(ov.has(SPELL_COMPONENT_MAPPER_ID, () => false)).toBe(true);
      expect(ov.extraIds(0x27, () => [])).toEqual([SPELL_COMPONENT_MAPPER_ID]);
      expect(ov.extraIds(undefined, () => [])).toContain(SPELL_COMPONENT_MAPPER_ID);
      expect(ov.extraIds(0x0e, () => [])).not.toContain(SPELL_COMPONENT_MAPPER_ID);
      expect(ov.getRaw!(SPELL_COMPONENT_MAPPER_ID, () => new ArrayBuffer(4))).toBeNull();
      // The ComponentPacks mapper (foci) stays absent: 1999 had no foci.
      expect(ov.has(0x27000003, () => false)).toBe(false);
    }
  });
});

describe('1999 SpellComponentTable → EoL', () => {
  it('drops the AcString NUL from names and text', () => {
    const w = new DatWriter().writeUInt32(0x0e00000f).writeUInt16(1).writeUInt16(64);
    w.writeUInt32(1);
    acString(w, swapNibbles(bytesOf('Lead Scarab')));
    w.writeUInt32(0).writeUInt32(0x06001234).writeUInt32(1).writeUInt32(0x13000080).writeFloat32(0.5);
    acString(w, swapNibbles(bytesOf('A scarab.')));
    w.writeFloat32(0.25);
    const out = transcodeSpellComponentTable1999(w.toArrayBuffer());
    const r = new DatReader(out);
    const t = new SpellComponentTable(r);
    expect(r.remaining).toBe(0);
    const c = t.components.get(1)!;
    expect(c.name).toBe('Lead Scarab');
    expect(c.text).toBe('A scarab.');
    expect(c.icon).toBe(0x06001234);
    expect(c.gesture).toBe(0x13000080);
    expect(c.cdm).toBeCloseTo(0.25);
  });
});

describe('1999 SpellTable formula version', () => {
  it('is served as RandomizeVersion1 (the 1999 client personalizes every formula)', () => {
    const name = 'Summon Portal I';
    const desc = 'Summons a portal.';
    const comps = [4, 68, 24, 64, 32, 42, 60];
    const w = new DatWriter().writeUInt32(0x0e00000e).writeUInt16(1).writeUInt16(64);
    w.writeUInt32(157);
    acString(w, swapNibbles(bytesOf(name)));
    acString(w, swapNibbles(bytesOf(desc)));
    w.writeUInt32(4).writeUInt32(0x0600138c).writeUInt32(1).writeUInt32(6).writeUInt32(10);
    w.writeFloat32(5).writeFloat32(1).writeUInt32(1).writeFloat32(1).writeUInt32(0).writeFloat32(0);
    w.writeUInt32(7).writeUInt32(157).writeFloat64(60);
    const key = ((computeSpellHash(name) % 0x12107680) + (computeSpellHash(desc) % 0xbeadcf45)) >>> 0;
    for (let i = 0; i < 8; i++) w.writeUInt32(comps[i] ? (comps[i] + key) >>> 0 : 0);
    w.writeUInt32(0).writeUInt32(6).writeUInt32(0).writeFloat64(0).writeFloat32(0);
    const st = new SpellTable(new DatReader(transcodeSpellTable1999(w.toArrayBuffer())));
    const s = st.spells.get(157)!;
    expect(SPELL_FORMULA_VERSION_1999).toBe(1);
    expect(s.formulaVersion).toBe(1);
    expect(s.formula).toEqual(comps);
    // Version 1 rewrites the taper slots 1 / 3 (a 7-component formula) from the account.
    const personal = getPlayerFormula(s.formula, s.formulaVersion, 'testacjs');
    expect([personal[0], personal[2], personal[4], personal[5], personal[6]]).toEqual([4, 24, 32, 42, 60]);
    for (const i of [1, 3]) expect(personal[i]).toBeGreaterThanOrEqual(63);
    for (const i of [1, 3]) expect(personal[i]).toBeLessThanOrEqual(74);
  });

  it('personalizes with the account the server named, not the name as typed', () => {
    expect(characterMessageAccount('testacjs', 'TestAcjs')).toBe('testacjs');
    expect(characterMessageAccount(null, 'TestAcjs')).toBe('testacjs');
  });
});

const AC1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail');
const HAS_1999 = existsSync(resolve(AC1999, 'portal.dat')) && existsSync(resolve(AC1999, 'client.exe'));

/** Read SCIDtoWCID @ 0x5e41f0's jump table out of the 1999 client.exe (PE32). */
function decodeScidToWcid(exe: Buffer): number[] {
  const pe = exe.readUInt32LE(0x3c);
  const sections = exe.readUInt16LE(pe + 6);
  const optSize = exe.readUInt16LE(pe + 20);
  const imageBase = exe.readUInt32LE(pe + 24 + 28);
  const at = (va: number): number => {
    for (let i = 0; i < sections; i++) {
      const o = pe + 24 + optSize + 40 * i;
      const vsize = exe.readUInt32LE(o + 8), vaddr = exe.readUInt32LE(o + 12) + imageBase, raw = exe.readUInt32LE(o + 20);
      if (va >= vaddr && va < vaddr + vsize) return raw + va - vaddr;
    }
    throw new Error(`va 0x${va.toString(16)} in no section`);
  };
  const fn = at(0x5e41f0);
  // sub ecx, 1; cmp [ebp-0xc], 0x49; ja default; jmp [4*edx + table]
  expect(exe.subarray(fn + 0x12, fn + 0x15)).toEqual(Buffer.from([0x83, 0xe9, 0x01]));
  expect(exe.subarray(fn + 0x18, fn + 0x1c)).toEqual(Buffer.from([0x83, 0x7d, 0xf4, 0x49]));
  expect(exe.subarray(fn + 0x25, fn + 0x28)).toEqual(Buffer.from([0xff, 0x24, 0x95]));
  const table = exe.readUInt32LE(fn + 0x28);
  const out: number[] = [];
  for (let k = 0; k <= 0x49; k++) {
    const target = at(exe.readUInt32LE(at(table) + 4 * k));
    expect(exe.subarray(target, target + 3)).toEqual(Buffer.from([0xc7, 0x45, 0xfc])); // mov [ebp-4], imm32
    out.push(exe.readUInt32LE(target + 3));
  }
  return out;
}

describe.skipIf(!HAS_1999)('the 1999 retail client + portal.dat', () => {
  let portal: DatDatabase;
  let spells: SpellTable;
  let comps: SpellComponentTable;
  let wcidOf: ReadonlyMap<number, number>;
  beforeAll(() => {
    // Our own instance: openDat's cached one is shared and read raw by other tests.
    portal = new DatDatabase(new FileDatBytes(resolve(AC1999, 'portal.dat')));
    portal.setOverlay(ac1999PortalOverlay());
    spells = new SpellTable(new DatReader(portal.getFileData(0x0e00000e)!));
    comps = new SpellComponentTable(new DatReader(portal.getFileData(0x0e00000f)!));
    wcidOf = readDualDidMapper(new DatReader(portal.getFileData(SPELL_COMPONENT_DID_MAPPER_ID)!)).client.enumToId;
  });

  it('SPELL_COMPONENT_WCIDS_1999 is exactly what SCIDtoWCID @ 0x5e41f0 returns, one entry per portal component', () => {
    expect(decodeScidToWcid(readFileSync(resolve(AC1999, 'client.exe')))).toEqual(SPELL_COMPONENT_WCIDS_1999);
    expect([...comps.components.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: 74 }, (_, i) => i + 1));
    expect(portal.listFileIds(0x27)).toEqual([SPELL_COMPONENT_DID_MAPPER_ID]);
  });

  it('component names come through without a NUL', () => {
    expect(comps.components.get(1)!.name).toBe('Lead Scarab');
    for (const c of comps.components.values()) expect(c.name).toMatch(/^[\x20-\x7e]+$/);
  });

  it.skipIf(!existsSync(resolve(__dirname, '..', 'dat', 'client_portal.dat')))('matches end of retail\'s 0x27000002 for the same 74 ids and names', () => {
    const eol = openDat('dat/client_portal.dat');
    const eolMap = readDualDidMapper(new DatReader(eol.getFileData(SPELL_COMPONENT_DID_MAPPER_ID)!)).client.enumToId;
    const eolComps = new SpellComponentTable(new DatReader(eol.getFileData(0x0e00000f)!));
    for (let scid = 1; scid <= 74; scid++) {
      expect(wcidOf.get(scid)).toBe(eolMap.get(scid));
      expect(comps.components.get(scid)!.name).toBe(eolComps.components.get(scid)!.name);
    }
  });

  it('every spell formula is version 1 and every personalized component maps into the 1999 blocks', () => {
    for (const s of spells.spells.values()) {
      expect(s.formulaVersion).toBe(1);
      for (const c of getPlayerFormula(s.formula, s.formulaVersion, 'testacjs')) expect(inBlocks(wcidOf.get(c) ?? 0)).toBe(true);
    }
  });

  it('a Life Mage\'s starter pack passes the cast pre-check for Heal Self I; missing a component fails it', () => {
    const heal = [...spells.spells.values()].find((s) => s.name === 'Heal Self I')!;
    const formula = getPlayerFormula(heal.formula, heal.formulaVersion, 'testacjs');
    const names = formula.map((c) => comps.components.get(c)!.name);
    expect(names).toEqual(['Lead Scarab', 'Hyssop', 'Powdered Amber', 'Colcothar', 'Willow Talisman']);
    const wcidByName = new Map([...comps.components].map(([id, c]) => [c.name, wcidOf.get(id)!]));
    const starter = ['Lead Scarab', 'Yew Talisman', 'Willow Talisman', 'Ebony Talisman', 'Cinnabar', 'Mugwort', 'Colcothar',
      'Powdered Amber', 'Hyssop', 'Cobalt', 'Powdered Onyx', 'Wormwood'];
    const pack = new Set(starter.map((n) => wcidByName.get(n)!));
    expect(spellComponentsSatisfied(true, formula, wcidOf, (w) => pack.has(w))).toBe(true);
    pack.delete(wcidByName.get('Willow Talisman')!);
    expect(spellComponentsSatisfied(true, formula, wcidOf, (w) => pack.has(w))).toBe(false);
    // Before the synthetic mapper: no map, every component unowned (the live bug).
    expect(spellComponentsSatisfied(true, formula, new Map(), () => true)).toBe(false);
  });
});
