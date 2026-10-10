/**
 * The 1999 portal.dat gameplay tables and strings, translated to the
 * end-of-retail formats our parsers read (packages/dat-parser/src/era1999/
 * Tables1999.ts): Region, CharGen, XpTable, SpellTable and the 0x31 strings.
 * Synthetic 1999 records run everywhere; the real 1999 DAT checks skip when
 * dat-sets/ac1999-retail is absent (CI).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatWriter } from '../packages/dat-parser/src/era1999/DatWriter.js';
import {
  REGION_1999_HARDWARE_ID,
  readCharGen1999Text,
  spellTargetType1999,
  transcodeCharGen1999,
  transcodePhysicsScriptTable1999,
  transcodeRegion1999,
  transcodeSpellTable1999,
  transcodeString1999,
  transcodeXpTable1999,
} from '../packages/dat-parser/src/era1999/Tables1999.js';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { CharacterGenerator } from '../packages/dat-parser/src/file-types/CharacterGenerator.js';
import { XpTable } from '../packages/dat-parser/src/file-types/XpTable.js';
import { SpellTable, computeSpellHash } from '../packages/dat-parser/src/file-types/SpellTable.js';
import { LanguageString } from '../packages/dat-parser/src/file-types/LanguageString.js';
import { PhysicsScriptTable } from '../packages/dat-parser/src/file-types/PhysicsScript.js';
import { SoundTable } from '../packages/dat-parser/src/file-types/SoundTable.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { PlayScript, Sound, playScript1999ToEoL, playScriptEoLTo1999 } from '@ac/shared';
import { openDat } from './_harness/dat.js';

/** Parse `buf` with `parse` and require every byte consumed. */
function parseAll<T>(buf: ArrayBuffer, parse: (r: DatReader) => T): T {
  const r = new DatReader(buf);
  const out = parse(r);
  expect(r.remaining).toBe(0);
  return out;
}

const bytesOf = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

/** 1999 AcString: u16 length incl. NUL, bytes, NUL, pad 4. */
function acString(w: DatWriter, s: string | Uint8Array): DatWriter {
  const b = typeof s === 'string' ? bytesOf(s) : s;
  w.writeUInt16(b.length + 1).writeBytes(b).writeUInt8(0);
  return w.align(4);
}

/** 1999 CharGen string: u32 length, bytes, pad 4. */
function u32String(w: DatWriter, s: string): DatWriter {
  return w.writeUInt32(s.length).writeBytes(bytesOf(s)).align(4);
}

const swapNibbles = (b: Uint8Array): Uint8Array => b.map((x) => ((x >> 4) | (x << 4)) & 0xff);

const plusEnd = (buf: ArrayBuffer, extra: number[]): ArrayBuffer => {
  const out = new Uint8Array(buf.byteLength + extra.length);
  out.set(new Uint8Array(buf));
  out.set(extra, buf.byteLength);
  return out.buffer;
};

describe('1999 strings (0x31) → EoL LanguageString', () => {
  it('drops the NUL and the pad and re-encodes the length', () => {
    const w = new DatWriter().writeUInt32(0x31000042);
    acString(w, 'Hello Dereth');
    const raw = w.toArrayBuffer();
    expect(raw.byteLength).toBe(20);
    const s = parseAll(transcodeString1999(raw), (r) => LanguageString.read(r));
    expect(s.id).toBe(0x31000042);
    expect(s.charBuffer).toBe('Hello Dereth');
  });

  it('uses the two-byte compressed length past 127 characters', () => {
    const text = 'x'.repeat(300);
    const raw = acString(new DatWriter().writeUInt32(0x31000001), text).toArrayBuffer();
    const out = transcodeString1999(raw);
    expect(out.byteLength).toBe(4 + 2 + 300);
    expect(parseAll(out, (r) => LanguageString.read(r)).charBuffer).toBe(text);
  });

  it('rejects trailing bytes and a missing NUL', () => {
    const raw = acString(new DatWriter().writeUInt32(0x31000001), 'abc').toArrayBuffer();
    expect(() => transcodeString1999(plusEnd(raw, [0, 0, 0, 0]))).toThrow();
    const noNul = new DatWriter().writeUInt32(0x31000001).writeUInt16(3).writeBytes(bytesOf('abc')).align(4);
    expect(() => transcodeString1999(noNul.toArrayBuffer())).toThrow();
  });
});

describe('1999 XpTable → EoL XpTable', () => {
  function xp1999(): ArrayBuffer {
    const w = new DatWriter().writeUInt32(0x0e000018);
    w.writeUInt32(1).writeUInt32(1).writeUInt32(1).writeUInt32(1).writeUInt32(2);
    for (const v of [0, 10, 0, 20, 0, 30, 0, 40]) w.writeUInt32(v);
    for (const v of [0, 1000, 4000000000]) w.writeUInt32(v); // level XP (u32)
    for (const v of [0, 1, 1]) w.writeUInt32(v); // credits
    return w.toArrayBuffer();
  }

  it('widens the level XP to u64 and keeps every other table', () => {
    const t = parseAll(transcodeXpTable1999(xp1999()), (r) => new XpTable(r));
    expect(t.attributeXpList).toEqual([0, 10]);
    expect(t.vitalXpList).toEqual([0, 20]);
    expect(t.trainedSkillXpList).toEqual([0, 30]);
    expect(t.specializedSkillXpList).toEqual([0, 40]);
    expect(t.characterLevelXpList).toEqual([0n, 1000n, 4000000000n]);
    expect(t.characterLevelSkillCreditList).toEqual([0, 1, 1]);
  });

  it('rejects a truncated table', () => {
    expect(() => transcodeXpTable1999(xp1999().slice(0, 40))).toThrow();
  });
});

/** A 1999 spell record (nibble-swapped AcString name/desc, formula obfuscated with the name/desc key). */
function spell1999(w: DatWriter, id: number, name: string, desc: string, metaType: number, comps: number[]): void {
  w.writeUInt32(id);
  acString(w, swapNibbles(bytesOf(name)));
  acString(w, swapNibbles(bytesOf(desc)));
  w.writeUInt32(4).writeUInt32(0x0600138c).writeUInt32(1).writeUInt32(6).writeUInt32(10);
  w.writeFloat32(5).writeFloat32(1).writeUInt32(1).writeFloat32(1).writeUInt32(0).writeFloat32(0);
  w.writeUInt32(metaType).writeUInt32(id);
  if (metaType === 1) w.writeFloat64(150).writeFloat32(0).writeFloat32(-666);
  if (metaType === 7) w.writeFloat64(60);
  const key = ((computeSpellHash(name) % 0x12107680) + (computeSpellHash(desc) % 0xbeadcf45)) >>> 0;
  for (let i = 0; i < 8; i++) w.writeUInt32(comps[i] ? (comps[i] + key) >>> 0 : 0);
  w.writeUInt32(0).writeUInt32(6).writeUInt32(0).writeFloat64(0).writeFloat32(0);
}

describe('1999 SpellTable → EoL SpellTable', () => {
  function table(): ArrayBuffer {
    const w = new DatWriter().writeUInt32(0x0e00000e).writeUInt16(3).writeUInt16(0x800);
    spell1999(w, 1, 'Strength Other I', "Increases the target's Strength by 10 points.", 1, [1, 7, 33, 44, 49]);
    spell1999(w, 2, 'Strength Self I', "Increases the caster's Strength by 10 points.", 1, [1, 7, 33, 44, 60]);
    spell1999(w, 157, 'Summon Portal I', 'Summons a portal.', 7, [4, 68, 24, 64, 32, 42, 59]);
    return w.toArrayBuffer();
  }

  it('reads back plain names, the de-obfuscated formula and type-specific fields', () => {
    const st = parseAll(transcodeSpellTable1999(table()), (r) => new SpellTable(r));
    expect([...st.spells.keys()]).toEqual([1, 2, 157]);
    const s1 = st.spells.get(1)!;
    expect(s1.name).toBe('Strength Other I');
    expect(s1.desc).toBe("Increases the target's Strength by 10 points.");
    expect(s1.formula).toEqual([1, 7, 33, 44, 49]);
    expect(s1.duration).toBe(150);
    expect(s1.degradeLimit).toBe(-666);
    expect(s1.targetEffect).toBe(6);
    expect(s1.displayOrder).toBe(0);
    expect(s1.manaMod).toBe(0);
    expect(st.spells.get(157)!.portalLifetime).toBe(60);
    expect(st.spells.get(157)!.formula).toEqual([4, 68, 24, 64, 32, 42, 59]);
    expect(st.spellSets.size).toBe(0);
  });

  it('derives the target type the 1999 client computes from the formula', () => {
    const st = parseAll(transcodeSpellTable1999(table()), (r) => new SpellTable(r));
    expect(st.spells.get(1)!.nonComponentTargetType).toBe(0x10); // creature talisman 0x31
    expect(st.spells.get(2)!.nonComponentTargetType).toBe(0x10); // 0x3C
    expect(st.spells.get(157)!.nonComponentTargetType).toBe(0x10000); // 0x3B portal
    expect(spellTargetType1999([1, 7, 33, 44, 57, 0, 0, 0])).toBe(0xa090f); // item talisman
    expect(spellTargetType1999([1, 7, 33, 0, 49, 0, 0, 0])).toBe(0); // incomplete formula
    expect(spellTargetType1999([1, 7, 33, 44, 2, 3, 0, 0])).toBe(0); // last component not a talisman
  });

  it('rejects an unknown spell type and trailing bytes', () => {
    const bad = new DatWriter().writeUInt32(0x0e00000e).writeUInt16(1).writeUInt16(1);
    spell1999(bad, 9, 'X', 'Y', 99, [1, 2, 3, 4, 49]);
    expect(() => transcodeSpellTable1999(bad.toArrayBuffer())).toThrow();
    expect(() => transcodeSpellTable1999(plusEnd(table(), [1, 2, 3, 4]))).toThrow();
  });
});

/** A minimal 1999 RegionDesc (version 3) with every part, and the given LandSurf. */
function region1999(landSurf: (w: DatWriter) => void): ArrayBuffer {
  const w = new DatWriter().writeUInt32(0x130f0000).writeUInt32(0).writeUInt32(3);
  acString(w, 'Lands of Dereth');
  w.writeInt32(255).writeInt32(255).writeFloat32(24).writeInt32(8).writeInt32(1);
  w.writeFloat32(200).writeFloat32(1000).writeFloat32(5);
  for (let i = 0; i < 256; i++) w.writeFloat32(i * 2);
  // GameTime
  w.writeFloat64(1234.5).writeUInt32(10).writeFloat32(7620).writeUInt32(360);
  acString(w, 'P.Y.');
  w.writeUInt32(1).writeFloat32(0).writeUInt32(1);
  acString(w, 'Darktide');
  w.writeUInt32(1);
  acString(w, 'FirstDay');
  w.writeUInt32(1).writeUInt32(0);
  acString(w, 'Snowreap');
  w.writeUInt32(0x213); // sky, sound, scene, misc
  // SkyDesc: one day group, one sky object (8 words), one sky time with one replace
  w.writeFloat64(0.8).writeFloat64(15).writeUInt32(1);
  w.writeFloat32(16);
  acString(w, 'Sunny');
  w.writeUInt32(1);
  w.writeFloat32(0.04).writeFloat32(0.21).writeFloat32(-20).writeFloat32(190).writeFloat32(0).writeFloat32(0);
  w.writeUInt32(0x010015f4).writeUInt32(1); // gfx, properties
  w.writeUInt32(1);
  w.writeFloat32(0).writeFloat32(0.15).writeFloat32(90).writeFloat32(0.9).writeUInt32(0xffdcdcdc);
  w.writeFloat32(0.3).writeUInt32(0xffdcdcdc).writeFloat32(0).writeFloat32(0).writeUInt32(0xffffffff).writeUInt32(0);
  w.writeUInt32(1).writeUInt32(0).writeUInt32(0).writeFloat32(270).writeFloat32(-1).writeFloat32(11).writeFloat32(11);
  // SoundDesc
  w.writeUInt32(1).writeUInt32(0x20000001).writeUInt32(1);
  w.writeUInt32(5).writeFloat32(0.5).writeFloat32(0.1).writeFloat32(1).writeFloat32(2);
  // SceneDesc
  w.writeUInt32(1).writeUInt32(0).writeUInt32(1).writeUInt32(0x12000006);
  // Terrain types
  w.writeUInt32(1);
  acString(w, 'BarrenRock');
  w.writeUInt32(0xff808080).writeUInt32(1).writeUInt32(0);
  landSurf(w);
  // RegionMisc
  for (const v of [1, 0x0600127d, 0x06000261, 4, 0x010004de, 0x01000a12]) w.writeUInt32(v);
  return w.toArrayBuffer();
}

const texMerge = (w: DatWriter): void => {
  w.writeUInt32(0).writeUInt32(128);
  w.writeUInt32(1).writeUInt32(1).writeUInt32(0x05001400);
  w.writeUInt32(1).writeUInt32(2).writeUInt32(0x05001401);
  w.writeUInt32(1).writeUInt32(3).writeUInt32(0x05001402);
  w.writeUInt32(2);
  for (const [t, tex] of [[0, 0x0500145c], [32, 0x05001458]]) {
    w.writeUInt32(t).writeUInt32(tex).writeUInt32(1);
    for (let i = 0; i < 6; i++) w.writeUInt32(0);
    w.writeUInt32(2).writeUInt32(0x050012af);
  }
};

describe('1999 Region → EoL RegionDesc', () => {
  it('converts strings and the 8-word sky object, keeping the TexMerge terrain', () => {
    const rd = parseAll(transcodeRegion1999(region1999(texMerge)), (r) => new RegionDesc(r));
    expect(rd.regionName).toBe('Lands of Dereth');
    expect(rd.landDefs.landHeightTable[255]).toBe(510);
    expect(rd.gameTime.yearSpec).toBe('P.Y.');
    expect(rd.gameTime.timesOfDay[0].name).toBe('Darktide');
    expect(rd.gameTime.seasons[0].name).toBe('Snowreap');
    const obj = rd.skyInfo!.dayGroups[0].skyObjects[0];
    expect(rd.skyInfo!.dayGroups[0].dayName).toBe('Sunny');
    expect(obj.defaultGFXObjectId).toBe(0x010015f4);
    expect(obj.defaultPESObjectId).toBe(0);
    expect(obj.properties).toBe(1);
    expect(rd.skyInfo!.dayGroups[0].skyTime[0].skyObjReplace[0].luminosity).toBe(11);
    expect(rd.soundInfo!.stbDesc[0].ambientSounds[0].sType).toBe(5);
    expect(rd.sceneInfo!.sceneTypes[0].scenes).toEqual([0x12000006]);
    expect(rd.terrainInfo.terrainTypes[0].terrainName).toBe('BarrenRock');
    const tm = rd.terrainInfo.landSurfaces.texMerge!;
    expect(tm.baseTexSize).toBe(128);
    expect(tm.terrainDesc.map((d) => d.terrainType)).toEqual([0, 32]);
    expect(tm.roadMaps[0].roadTexGID).toBe(0x05001402);
    expect(rd.regionMisc!.clearMonsterId).toBe(0x01000a12);
  });

  it('consumes and drops a software-region PalShift', () => {
    const palShift = (w: DatWriter): void => {
      w.writeUInt32(1).writeUInt32(1); // type PalShift, one texture
      w.writeUInt32(0x05000001).writeUInt32(2); // tex gid, 2 sub palettes
      w.writeUInt32(0).writeUInt32(8).writeUInt32(8).writeUInt32(8);
      w.writeUInt32(1).writeUInt32(0x10).writeInt32(1).writeInt32(2); // one road code, a PalType per sub palette
      w.writeUInt32(1).writeUInt32(3).writeUInt32(0x04000010); // one terrain palette
    };
    const rd = parseAll(transcodeRegion1999(region1999(palShift)), (r) => new RegionDesc(r));
    expect(rd.terrainInfo.landSurfaces.type).toBe(1);
    expect(rd.terrainInfo.landSurfaces.texMerge).toBeNull();
    expect(rd.regionMisc!.version).toBe(1);
  });

  it('rejects another region version', () => {
    const raw = region1999(texMerge);
    new DataView(raw).setUint32(8, 4, true);
    expect(() => transcodeRegion1999(raw)).toThrow(/version/);
  });
});

/** A 1999 ObjDesc with one sub palette, one texture change, one part change. */
function objDesc1999(w: DatWriter, part: number): void {
  w.writeUInt8(0x11).writeUInt8(1).writeUInt8(1).writeUInt8(1);
  w.writeUInt16(0x007e).writeUInt16(0x0100).writeUInt8(1).writeUInt8(0);
  w.writeUInt8(16).writeUInt16(0x0098).writeUInt16(0x8001);
  w.writeUInt8(0).writeUInt16(part);
  w.align(4);
}

function sex1999(w: DatWriter, name: string, setup: number, templateIcon: number, description = 0x3100000d): void {
  u32String(w, name);
  w.writeUInt32(setup).writeUInt32(0x20000001).writeUInt32(0x060004da).writeUInt32(description);
  objDesc1999(w, 0x004e);
  w.writeUInt32(0x02000001).writeUInt32(0x05000001);
  w.writeUInt32(1); u32String(w, 'al-');
  w.writeUInt32(0);
  w.writeUInt32(330).writeUInt32(0).writeUInt32(50).writeUInt32(0);
  w.writeUInt32(1).writeUInt32(0x10).writeInt32(4).writeInt32(8); // one heritage skill
  w.writeUInt32(1); // one template
  u32String(w, 'Archer');
  w.writeUInt32(templateIcon).writeUInt32(0x31000005).writeUInt32(1);
  for (const a of [50, 40, 90, 80, 40, 30]) w.writeUInt32(a);
  w.writeUInt32(2).writeUInt32(9).writeUInt32(28);
  w.writeUInt32(1).writeUInt32(2);
  w.writeUInt32(0);
  w.writeUInt32(0).writeUInt32(0x0400007e).writeUInt32(0x0f000013);
  w.writeUInt32(2).writeUInt32(0x04000001).writeUInt32(0x04000002); // hair colors
  w.writeUInt32(1).writeUInt32(0x06001234).writeUInt32(1); objDesc1999(w, 0x0123); // hair style, bald
  w.writeUInt32(1).writeUInt32(0x04000003); // eye colors
  w.writeUInt32(1).writeUInt32(0x06000001).writeUInt32(0x06000002); objDesc1999(w, 1); objDesc1999(w, 2);
  w.writeUInt32(1).writeUInt32(0x06000003); objDesc1999(w, 3); // nose
  w.writeUInt32(0); // mouth
  w.writeUInt32(1); u32String(w, 'Cloth Cap'); w.writeUInt32(0x10000001).writeUInt32(0x1234);
  w.writeUInt32(0); w.writeUInt32(0); w.writeUInt32(0);
  w.writeUInt32(1).writeUInt32(0x04000009); // clothing colors
  w.writeUInt32(0); // trailer
}

function charGen1999(): ArrayBuffer {
  const w = new DatWriter().writeUInt32(0x0e000002);
  for (let i = 0; i < 8; i++) w.writeUInt32(0x31000010 + i);
  w.writeUInt32(2);
  for (const [name, cell] of [['Holtburg South', 0xa9b00014], ['Yaraq North', 0x7d680012]] as const) {
    u32String(w, name);
    w.writeUInt32(1).writeUInt32(cell);
    for (const f of [71.8, 94.5, 64.9, -0.98, 0, 0, -0.17]) w.writeFloat32(f);
  }
  w.writeUInt32(1);
  u32String(w, 'Aluvian');
  w.writeUInt32(0x060004c6).writeUInt32(0x02000054).writeUInt32(0x31000001).writeUInt32(0x020005a1);
  w.writeUInt32(1).writeUInt32(0);
  w.writeUInt32(1).writeUInt32(1);
  w.writeUInt32(2);
  sex1999(w, 'Female', 0x0200004e, 0x06001153);
  sex1999(w, 'Male', 0x02000001, 0x06001152, 0x31000011);
  return w.toArrayBuffer();
}

describe('1999 CharGen → EoL CharacterGenerator', () => {
  it('maps start areas 1:1 and the heritage fields', () => {
    const cg = parseAll(transcodeCharGen1999(charGen1999()), (r) => new CharacterGenerator(r));
    expect(cg.id).toBe(0x0e000002);
    expect(cg.starterAreas.map((a) => a.name)).toEqual(['Holtburg South', 'Yaraq North']);
    expect(cg.starterAreas[1].locations[0].objCellId).toBe(0x7d680012);
    expect(cg.starterAreas[0].locations[0].orientation.z).toBeCloseTo(-0.17, 5);
    const h = cg.heritageGroups.get(1)!;
    expect(h.name).toBe('Aluvian');
    expect(h.setupId).toBe(0x02000054);
    expect(h.environmentSetupId).toBe(0x020005a1);
    expect(h.attributeCredits).toBe(330);
    expect(h.skillCredits).toBe(50);
    expect(h.primaryStartAreas).toEqual([0]);
    expect(h.secondaryStartAreas).toEqual([1]);
    expect(h.skills).toEqual([{ skillNum: 0x10, normalCost: 4, primaryCost: 8 }]);
    expect(h.templates).toHaveLength(1);
    expect(h.templates[0]).toMatchObject({
      name: 'Archer', iconImage: 0x06001153, title: 0, strength: 50, self: 30,
      normalSkillsList: [9, 28], primarySkillsList: [2],
    });
  });

  it('keys the [Female, Male] sexes by the Gender enum, in key order, with their appearance lists', () => {
    const cg = parseAll(transcodeCharGen1999(charGen1999()), (r) => new CharacterGenerator(r));
    const g = cg.heritageGroups.get(1)!.genders;
    expect([...g.keys()]).toEqual([1, 2]);
    expect(g.get(1)!.name).toBe('Male');
    expect(g.get(2)!.name).toBe('Female');
    const male = g.get(1)!;
    expect(male.setupId).toBe(0x02000001);
    expect(male.scale).toBe(100);
    expect(male.basePalette).toBe(0x0400007e);
    expect(male.skinPalSet).toBe(0x0f000013);
    expect(male.baseObjDesc).toEqual({
      paletteId: 0x0400007e,
      subPalettes: [{ subId: 0x04000100, offset: 8, numColors: 256 * 8 }],
      textureChanges: [{ partIndex: 16, oldTexture: 0x05000098, newTexture: 0x05008001 }],
      animPartChanges: [{ partIndex: 0, partId: 0x0100004e }],
    });
    expect(male.hairColorList).toEqual([0x04000001, 0x04000002]);
    expect(male.hairStyleList[0]).toMatchObject({ iconImage: 0x06001234, bald: true, alternateSetup: 0 });
    expect(male.hairStyleList[0].objDesc.animPartChanges[0].partId).toBe(0x01000123);
    expect(male.eyeStripList[0].objDescBald.animPartChanges[0].partId).toBe(0x01000002);
    expect(male.noseStripList[0].objDesc.animPartChanges[0].partId).toBe(0x01000003);
    expect(male.mouthStripList).toEqual([]);
    expect(male.headgearList).toEqual([{ name: 'Cloth Cap', clothingTable: 0x10000001, weenieDefault: 0x1234 }]);
    expect(male.clothingColorsList).toEqual([0x04000009]);
  });

  it('rejects trailing bytes', () => {
    expect(() => transcodeCharGen1999(plusEnd(charGen1999(), [0, 0, 0, 0]))).toThrow();
  });

  it('readCharGen1999Text returns the 0x31 text ids the EoL format has no slot for, keyed as the transcode keys them', () => {
    const t = readCharGen1999Text(charGen1999());
    expect(t.pages).toEqual(Array.from({ length: 8 }, (_, i) => 0x31000010 + i));
    expect([...t.heritages.keys()]).toEqual([1]);
    const h = t.heritages.get(1)!;
    expect(h.description).toBe(0x31000001);
    expect(h.templates).toEqual([0x31000005]);
    expect([...h.sexes]).toEqual([[1, 0x31000011], [2, 0x3100000d]]); // [Female, Male] in the file → Gender 2 / 1
    // Collecting the text leaves the transcode's bytes as they were.
    const text = { pages: [], heritages: new Map() };
    expect(new Uint8Array(transcodeCharGen1999(charGen1999(), text))).toEqual(new Uint8Array(transcodeCharGen1999(charGen1999())));
  });
});

describe('1999 PhysicsScriptTable → EoL PlayScript keys (meaning check)', () => {
  it('renumbers 1999 ordinals 30+ by one (1999 has no SkillDownBlack), below 30 unchanged', () => {
    expect([4, 29, 30, 80, 114, 117, 137, 140].map(playScript1999ToEoL))
      .toEqual([PlayScript.Launch, 29, PlayScript.HealthUpRed, PlayScript.Fizzle, PlayScript.PortalStorm,
        PlayScript.Hidden, PlayScript.LevelUp, PlayScript.WeddingBliss]);
    expect(playScriptEoLTo1999(PlayScript.SkillDownBlack)).toBeNull();
    for (const v of [4, 29, 31, 115, 141]) expect(playScript1999ToEoL(playScriptEoLTo1999(v)!)).toBe(v);
  });

  it('rewrites only the keys; mods and script ids keep their exact bits', () => {
    const w = new DatWriter().writeUInt32(0x34000004).writeUInt16(3).writeUInt16(0x40);
    w.writeUInt32(5).writeUInt32(1).writeFloat32(0).writeUInt32(0x33000001);
    w.writeUInt32(80).writeUInt32(1).writeFloat32(1).writeUInt32(0x33000002);
    w.writeUInt32(114).writeUInt32(2).writeFloat32(0).writeUInt32(0x330003db).writeFloat32(1).writeUInt32(0x330003dc);
    const t = parseAll(transcodePhysicsScriptTable1999(w.toArrayBuffer()), (r) => PhysicsScriptTable.read(r));
    expect([...t.scripts.keys()]).toEqual([PlayScript.Explode, PlayScript.Fizzle, PlayScript.PortalStorm]);
    expect(t.scripts.get(PlayScript.PortalStorm)).toEqual([{ mod: 0, scriptId: 0x330003db }, { mod: 1, scriptId: 0x330003dc }]);
  });
});

const AC1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail');
const HAS_1999 = existsSync(resolve(AC1999, 'portal.dat'));

describe.skipIf(!HAS_1999)('the 1999 retail portal.dat tables', () => {
  let portal: DatDatabase;
  beforeAll(() => {
    portal = openDat(resolve(AC1999, 'portal.dat'));
  });
  const raw = (id: number): ArrayBuffer => {
    const b = portal.getFileData(id);
    if (!b) throw new Error(`missing 0x${id.toString(16)}`);
    return b;
  };

  it('PhysicsScriptTables: every one translates whole; the player\'s answers our EoL PlayScript lookups', () => {
    const overlay = ac1999PortalOverlay();
    const served = (id: number) => overlay.get(id, (i) => portal.getFileData(i))!;
    const ids = portal.listFileIds(0x34);
    expect(ids.length).toBe(67);
    for (const id of ids) parseAll(served(id), (r) => PhysicsScriptTable.read(r));
    const player = parseAll(served(0x34000004), (r) => PhysicsScriptTable.read(r));
    const raw1999 = PhysicsScriptTable.read(new DatReader(raw(0x34000004)));
    // The 1999 client's hardcoded storm ordinal 0x72 (two candidates, mod 0 brewing / 1 imminent)
    // is what our client's PlayScript.PortalStorm (0x73) now finds.
    expect(player.scripts.get(PlayScript.PortalStorm)).toEqual(raw1999.scripts.get(0x72));
    expect(player.scripts.get(PlayScript.PortalStorm)!.map((e) => e.mod)).toEqual([0, 1]);
    for (const k of [PlayScript.Fizzle, PlayScript.Hidden, PlayScript.UnHide, PlayScript.LevelUp]) {
      expect(player.scripts.get(k)).toEqual(raw1999.scripts.get(playScriptEoLTo1999(k)!));
    }
    expect(player.scripts.has(PlayScript.SkillDownBlack)).toBe(false);
    expect(player.scripts.size).toBe(raw1999.scripts.size);
  });

  it('SpellTable effects come out in EoL PlayScript numbering', () => {
    const st = parseAll(transcodeSpellTable1999(raw(0x0e00000e)), (r) => new SpellTable(r));
    const effects = new Set([...st.spells.values()].map((s) => s.targetEffect));
    expect(effects.has(PlayScript.SkillDownBlack)).toBe(false);
    // Every target effect names a key the 1999 creature/player tables carry, renumbered.
    const player = PhysicsScriptTable.read(new DatReader(ac1999PortalOverlay().get(0x34000004, (i) => portal.getFileData(i))!));
    for (const e of effects) if (e !== 0) expect(player.scripts.has(e), `effect ${e}`).toBe(true);
  });

  it('SoundTables are NOT renumbered: the server, the DAT hooks and the tables all speak 1999 SoundTypes', () => {
    // The KB's 1999↔EoL shift (EoL 0x8B–0x97 = 1999 0x76–0x82) is about labels. Every key our client
    // looks up in a 1999 world comes from a 1999 source: the AC1999 server's 0xF750 (it emits
    // UI_DarkWhispers1/2 0x7A/0x7B for pickup/drop and UI_Bell 0x77 for wield, Monster.cpp /
    // Player.cpp), animation and PhysicsScript sound hooks (1999 DAT files). So the overlay serves
    // SoundTables as stored, and the player's table answers the server's values directly.
    const overlay = ac1999PortalOverlay();
    expect(overlay.get(0x20000001, (i) => portal.getFileData(i))).toBeUndefined(); // untranslated
    const human = SoundTable.read(new DatReader(raw(0x20000001)));
    for (const k of [0x7a, 0x7b, 0x77]) expect(human.data.has(k), `0x${k.toString(16)}`).toBe(true);
    // The EoL values of the same events are absent: renumbering only the tables would break the
    // server's sounds without fixing anything (no client-local sound is in the shifted block).
    for (const k of [Sound.PickUpItem, Sound.DropItem, Sound.WieldObject]) expect(human.data.has(k)).toBe(false);
  });

  it('CharGen: 3 heritages, 18 start areas of 2 positions', () => {
    const cg = parseAll(transcodeCharGen1999(raw(0x0e000002)), (r) => new CharacterGenerator(r));
    expect(cg.starterAreas).toHaveLength(18);
    expect(cg.starterAreas[0].name).toBe('Holtburg South');
    for (const a of cg.starterAreas) expect(a.locations).toHaveLength(2);
    expect([...cg.heritageGroups.keys()]).toEqual([1, 2, 3]);
    expect([...cg.heritageGroups.values()].map((h) => h.name)).toEqual(['Aluvian', "Gharu'ndim", 'Sho']);
    for (const h of cg.heritageGroups.values()) {
      expect(h.attributeCredits).toBe(330);
      expect(h.skillCredits).toBe(50);
      expect([...h.genders.keys()]).toEqual([1, 2]);
      expect(h.genders.get(1)!.name).toBe('Male');
      expect(h.genders.get(2)!.name).toBe('Female');
      expect(h.templates.length).toBeGreaterThan(0);
      for (const i of [...h.primaryStartAreas, ...h.secondaryStartAreas]) expect(i).toBeLessThan(18);
      expect(h.genders.get(1)!.hairStyleList.length).toBeGreaterThan(0);
    }
    expect(cg.heritageGroups.get(1)!.environmentSetupId).toBe(0x020005a1);
  });

  it('CharGen text: heritage, template and sex descriptions are the 0x31 Strings on the CD', () => {
    const t = readCharGen1999Text(raw(0x0e000002));
    expect(t.pages).toEqual([0x3100001f, 0x31000013, 0x31000014, 0x31000015, 0x31000016, 0x31000017, 0x31000018, 0x31000019]);
    expect([...t.heritages.keys()]).toEqual([1, 2, 3]);
    expect([...t.heritages.values()].map((h) => h.description)).toEqual([0x31000001, 0x31000002, 0x31000003]);
    // Adventurer (the custom template), Archer, Blademaster, Enchanter, Life Mage, Sorcerer, Vagabond, Warrior.
    for (const h of t.heritages.values()) {
      expect(h.templates).toEqual([0x3100000b, 0x31000005, 0x31000006, 0x31000007, 0x31000008, 0x31000009, 0x3100000a, 0x31000004]);
    }
    expect([...t.heritages.get(1)!.sexes]).toEqual([[1, 0x31000011], [2, 0x3100000d]]);
    const text = (id: number): string => parseAll(transcodeString1999(raw(id)), (r) => LanguageString.read(r)).charBuffer;
    expect(text(0x31000004).startsWith('WARRIORS are characters trained')).toBe(true);
    expect(text(0x3100000b).startsWith('If you choose a CUSTOM CHARACTER')).toBe(true);
    expect(text(0x31000011).startsWith('Many Aluvian men')).toBe(true);
  });

  it('XpTable: levels 0..126, monotonic', () => {
    const t = parseAll(transcodeXpTable1999(raw(0x0e000018)), (r) => new XpTable(r));
    expect(t.characterLevelXpList).toHaveLength(127);
    expect(t.characterLevelXpList.slice(0, 2)).toEqual([0n, 0n]); // levels 0 and 1 cost nothing
    for (let i = 2; i < t.characterLevelXpList.length; i++) {
      expect(t.characterLevelXpList[i]).toBeGreaterThan(t.characterLevelXpList[i - 1]);
    }
    expect(t.characterLevelSkillCreditList).toHaveLength(127);
  });

  it('SpellTable: 1635 spells with readable names and valid components', () => {
    const st = parseAll(transcodeSpellTable1999(raw(0x0e00000e)), (r) => new SpellTable(r));
    expect(st.spells.size).toBe(1635);
    for (const s of st.spells.values()) {
      expect(s.name).toMatch(/^[\x20-\x7e]+$/);
      expect(s.formula.length).toBeGreaterThan(0);
      for (const c of s.formula) {
        expect(c).toBeGreaterThanOrEqual(1);
        expect(c).toBeLessThanOrEqual(198);
      }
    }
    const str = st.spells.get(2)!;
    expect(str.name).toBe('Strength Self I');
    expect(str.desc).toBe("Increases the caster's Strength by 10 points.");
    expect(str.formula).toEqual([1, 7, 33, 44, 60]);
    expect(st.spells.get(1)!.name).toBe('Strength Other I');
    expect(st.spells.get(1)!.nonComponentTargetType).toBe(0x10);
  });

  it('Region: both regions transcode; the hardware one carries the terrain', () => {
    for (const id of [0x13000000, REGION_1999_HARDWARE_ID]) {
      const rd = parseAll(transcodeRegion1999(raw(id)), (r) => new RegionDesc(r));
      expect(rd.regionName).toBe('Lands of Dereth');
      expect(rd.landDefs.landHeightTable[0]).toBe(0);
      for (let i = 1; i < 256; i++) {
        expect(rd.landDefs.landHeightTable[i]).toBeGreaterThan(rd.landDefs.landHeightTable[i - 1]);
      }
      expect(rd.terrainInfo.terrainTypes.map((t) => t.terrainName).slice(0, 3)).toEqual(['BarrenRock', 'Grassland', 'Ice']);
      expect(rd.skyInfo!.dayGroups.length).toBeGreaterThan(0);
      expect(rd.gameTime.timesOfDay).toHaveLength(16);
    }
    const hw = parseAll(transcodeRegion1999(raw(REGION_1999_HARDWARE_ID)), (r) => new RegionDesc(r));
    const tm = hw.terrainInfo.landSurfaces.texMerge!;
    expect(tm.baseTexSize).toBe(128);
    expect(tm.terrainDesc.map((d) => d.terrainType)).toEqual(Array.from({ length: 33 }, (_, i) => i));
    expect(tm.terrainDesc.every((d) => (d.terrainTex.texGID >>> 24) === 0x05)).toBe(true);
    const sw = parseAll(transcodeRegion1999(raw(0x13000000)), (r) => new RegionDesc(r));
    expect(sw.terrainInfo.landSurfaces.texMerge).toBeNull();
  });

  it('Strings: all 27 decode to readable text', () => {
    const ids = portal.listFileIds(0x31);
    expect(ids).toHaveLength(27);
    for (const id of ids) {
      const s = parseAll(transcodeString1999(raw(id)), (r) => LanguageString.read(r));
      expect(s.id).toBe(id);
      expect(s.charBuffer.length).toBeGreaterThan(0);
      expect(s.charBuffer).toMatch(/^[\x20-\x7e\n\xa0-\xff]+$/);
    }
    const aluvian = parseAll(transcodeString1999(raw(0x31000001)), (r) => LanguageString.read(r));
    expect(aluvian.charBuffer.startsWith('ALUVIANS are a fiercely individualistic')).toBe(true);
  });
});
