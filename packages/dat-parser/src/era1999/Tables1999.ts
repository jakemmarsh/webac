/**
 * Tables1999 — translate the 1999 retail portal.dat gameplay tables and
 * strings into the end-of-retail (EoL) byte formats our parsers read, so the
 * renderer, chargen UI and stats code read 1999 data unchanged. Each
 * transcoder consumes every input byte or throws.
 *
 * Layouts measured against dat-sets/ac1999-retail/portal.dat (all files
 * transcode to 0 leftover and our EoL parsers then read 0 leftover;
 * tests/verify-ac1999-tables.ts). Readers cross-checked with the AC1999
 * server (reference/ac1999/Server/Source/PhatSDK, AGPL).
 *
 * Strings: 1999 uses the AcString — u16 length COUNTING a trailing NUL, the
 * bytes, the NUL, pad to 4. EoL PStrings carry no NUL. CharGen alone uses a
 * u32 length (no NUL) + pad.
 *
 * String 0x31xxxxxx (27 files): id, AcString. → EoL LanguageString: id,
 *   CompressedUInt32 length, bytes (no NUL, no pad).
 *
 * XpTable 0x0E000018 (4312 B): id, max attribute/vital/trained/specialized
 *   level and max character level (190/196/208/220/126), then the four cost
 *   tables (max+1 u32 each), level XP (127 × u32 — EoL: u64), skill credits
 *   per level (127 × u32).
 *
 * Region 0x13000000 (software) / 0x130F0000 (hardware): EoL RegionDesc with
 *   AcStrings, and a 1999 SkyObject of 8 words — begin/end time, begin/end
 *   angle, tex velocity x/y, gfx id, properties (0/1) — where EoL has a
 *   particle-emitter id before properties (written 0). LandSurf: the hardware
 *   region carries a TexMerge (base tex size 128, 33 terrain textures incl.
 *   slots 27–31 → BarrenRock and 32 = road); the software region carries a
 *   PalShift, which our EoL reader cannot use (type 1 = no TexMerge), so it is
 *   consumed and dropped. Our renderer is the hardware path: serve the
 *   0x130F0000 transcode as 0x13000000 (REGION_1999_HARDWARE_ID), as the 1999
 *   client's CRegionDesc::SetRegion picks 0x130F0000 for hardware rendering.
 *
 * CharGen 0x0E000002 (18880 B): id; 8 × u32 LanguageString ids (EoL has no
 *   slot for any of the CharGen's 0x31 text ids: readCharGen1999Text returns them); u32 count of start areas {u32-string name, u32 count of
 *   Position (cell + origin + quaternion)}; u32 count of heritages, positional
 *   (Aluvian, Gharu'ndim, Sho → EoL keys 1..3): name, icon, setup,
 *   description string id (dropped), backdrop setup (→ environmentSetupId),
 *   primary / secondary start-area index lists (u32 counts), then a u32
 *   count of Sex_CG, positional [Female, Male] (→ Gender keys 2/1, written in
 *   key order). Sex_CG: name, setup, sound table, icon, description string id,
 *   ObjDesc, a setup + texture id, two name-particle string lists, attribute
 *   credits (330), skill credits (50), the heritage skill list and templates,
 *   0, base palette, skin palette set, then the hair/eye/face/clothing lists
 *   as in EoL (u32 counts; hair bald is a u32; no hair alternateSetup), and a
 *   trailer word. Templates: name, icon, description string id (EoL title
 *   written 0), a flag (1), six attributes, normal / primary skill lists, a
 *   trailing 0. 1999 ObjDescs use plain u16 ids (EoL: packed DataIDs, aligned
 *   to the file offset). Start areas map 1:1 (18 named areas of 2 positions;
 *   EoL groups 5 per town), so the heritages' index lists keep their meaning.
 *   Lossy: per-sex template icons (EoL templates are per heritage; the first
 *   sex's stand, as in the 1999 server), sex scale (100) and physics/motion/
 *   combat tables (0: 1999 takes them from the player weenie).
 *
 * SpellTable 0x0E00000E (1635 spells): u16 count + u16 buckets, then per
 *   spell the EoL SpellBase with nibble-swapped AcString name/description and
 *   without EoL's display order / non-component target type / mana mod; no
 *   SpellSet table. The formula uses EoL's obfuscation (name/description hash
 *   key) and is copied as-is. Written: display order 0, mana mod 0, and the
 *   non-component target type the 1999 client derives from the formula
 *   (CSpellBase::InqTargetType → SpellFormula::GetTargetingType), so
 *   targeted casts still resolve; an empty SpellSet table. Formula version
 *   0 → 1 (SPELL_FORMULA_VERSION_1999: the 1999 client and server always
 *   personalize with RandomizeVersion1).
 *
 * SpellComponentTable 0x0E00000F: the EoL layout with AcStrings; the NUL is
 *   dropped from each name / text.
 *
 * DualDidMapper 0x27000002 (synthetic: the 1999 portal has none): the
 *   spell-component id → WCID map the 1999 client hardcodes (SCIDtoWCID).
 */
import { DatReader } from '../DatReader.js';
import { DatWriter } from './DatWriter.js';
import { computeSpellHash } from '../file-types/SpellTable.js';
import { playScript1999ToEoL } from '@ac/shared';

/** Reads 1999 bytes and writes EoL bytes in lockstep. */
class Copier {
  readonly r: DatReader;
  readonly w = new DatWriter();
  constructor(raw: ArrayBuffer, readonly what: string) {
    this.r = new DatReader(raw);
  }
  u32(): number { const v = this.r.readUInt32(); this.w.writeUInt32(v); return v; }
  f32(): number { const v = this.r.readFloat32(); this.w.writeFloat32(v); return v; }
  f64(): number { const v = this.r.readFloat64(); this.w.writeFloat64(v); return v; }
  /** n raw u32s copied verbatim (keeps float bit patterns exact). */
  words(n: number): void { for (let i = 0; i < n; i++) this.u32(); }
  /** A u32 count then `fn` per element. */
  list(fn: (i: number) => void): number {
    const n = this.u32();
    for (let i = 0; i < n; i++) fn(i);
    return n;
  }
  /** 1999 AcString (u16 length incl. NUL, bytes, pad 4) → EoL PString (u16 length, no NUL, pad 4). */
  str(): Uint8Array {
    const bytes = readAcString1999(this.r);
    this.w.writePString(bytes).align(4);
    return bytes;
  }
  /** Every byte consumed, or throw. */
  finish(): ArrayBuffer {
    if (this.r.remaining !== 0) {
      throw new Error(`${this.what}: ${this.r.remaining} unread bytes at ${this.r.position}/${this.r.length}`);
    }
    return this.w.toArrayBuffer();
  }
}

/** The 1999 AcString: u16 length counting a trailing NUL, the bytes, NUL, pad to 4. Returns the bytes without the NUL. */
export function readAcString1999(r: DatReader): Uint8Array {
  const len = r.readUInt16();
  const all = r.readBytes(len);
  r.align(4);
  if (len === 0) return all;
  if (all[len - 1] !== 0) throw new Error(`1999 string at ${r.position} lacks its NUL terminator`);
  return all.subarray(0, len - 1);
}

// ─── Region (0x13000000 / 0x130F0000) ────────────────────────────────────────

/** The 1999 hardware-rendering region (TexMerge terrain); our renderer reads it as 0x13000000. */
export const REGION_1999_HARDWARE_ID = 0x130f0000;

export function transcodeRegion1999(raw: ArrayBuffer): ArrayBuffer {
  const c = new Copier(raw, 'Region1999');
  c.u32(); // id
  c.u32(); // region number
  const version = c.u32();
  if (version !== 3) throw new Error(`Region1999: version ${version}, expected 3`);
  c.str(); // region name
  c.words(8 + 256); // LandDefs + LandHeightTable
  // GameTime
  c.f64(); c.u32(); c.f32(); c.u32(); c.str();
  c.list(() => { c.f32(); c.u32(); c.str(); });
  c.list(() => { c.str(); });
  c.list(() => { c.u32(); c.str(); });
  const partsMask = c.u32();
  if (partsMask & 0x10) {
    // SkyDesc: tick size, light tick size, day groups.
    c.f64(); c.f64();
    c.list(() => {
      c.f32(); c.str();
      // SkyObject: 7 words, then properties; EoL inserts a particle-emitter id (none in 1999).
      c.list(() => { c.words(7); const properties = c.r.readUInt32(); c.w.writeUInt32(0).writeUInt32(properties); });
      c.list(() => { c.words(11); c.list(() => c.words(6)); });
    });
  }
  // SoundDesc, SceneDesc, then the terrain types (always present).
  if (partsMask & 0x01) c.list(() => { c.u32(); c.list(() => c.words(5)); });
  if (partsMask & 0x02) c.list(() => { c.u32(); c.list(() => c.u32()); });
  c.list(() => { c.str(); c.u32(); c.list(() => c.u32()); });
  // LandSurf: type 0 = TexMerge (hardware region), 1 = PalShift (software region).
  const landSurfType = c.r.readUInt32();
  c.w.writeUInt32(landSurfType);
  if (landSurfType === 0) {
    c.u32(); // base_tex_size
    c.list(() => c.words(2)); // corner terrain alpha maps
    c.list(() => c.words(2)); // side terrain alpha maps
    c.list(() => c.words(2)); // road alpha maps
    c.list(() => c.words(11)); // TMTerrainDesc: terrain type + TerrainTex (10 words)
  } else if (landSurfType === 1) {
    // PalShift (the software renderer's palette-shift land textures). Our
    // EoL reader takes type 1 as "no TexMerge" and reads no body, so it is
    // consumed here and dropped: nothing in our renderer draws PalShift.
    const r = c.r;
    const numTex = r.readUInt32();
    for (let i = 0; i < numTex; i++) {
      r.readUInt32(); // tex gid
      const numSubPal = r.readUInt32();
      r.skip(numSubPal * 8); // sub_pal_index, sub_pal_length
      const numRoadCode = r.readUInt32();
      r.skip(numRoadCode * 4 * (1 + numSubPal)); // road_code + PalType per sub palette
      const numTerrainPal = r.readUInt32();
      r.skip(numTerrainPal * 8); // terrain index, palette id
    }
  } else {
    throw new Error(`Region1999: LandSurf type ${landSurfType}`);
  }
  if (partsMask & 0x200) c.words(6); // RegionMisc
  return c.finish();
}

// ─── CharGen (0x0E000002) ─────────────────────────────────────────────────────

/** The 1999 CharGen string: u32 length (no NUL), the bytes, pad to 4. */
function readU32String1999(r: DatReader): Uint8Array {
  const len = r.readUInt32();
  if (len > 0x10000) throw new Error(`CharGen1999: string length ${len} at ${r.position - 4}`);
  const bytes = r.readBytes(len);
  r.align(4);
  return bytes;
}

/** .NET BinaryWriter.Write(string): 7-bit encoded length, then the bytes (DatReader.readString's inverse). */
function write7BitString(w: DatWriter, bytes: Uint8Array): void {
  let n = bytes.length;
  while (n >= 0x80) { w.writeUInt8((n & 0x7f) | 0x80); n >>>= 7; }
  w.writeUInt8(n);
  w.writeBytes(bytes);
}

/** EoL packed DataID (DatReader.readDataIdOfKnownType's inverse). */
function writeDataIdOfKnownType(w: DatWriter, id: number, knownType: number): void {
  const v = (id - knownType) >>> 0;
  if (v < 0x8000) { w.writeUInt16(v); return; }
  if (v >= 0x40000000) throw new Error(`packed DataID out of range: 0x${id.toString(16)}`);
  w.writeUInt16(((v >>> 16) & 0x3fff) | 0x8000).writeUInt16(v & 0xffff);
}

/** 1999 ObjDesc (plain u16 ids, no packed-DID escape) → EoL ObjDesc (align, packed DIDs, align). */
function copyObjDesc(r: DatReader, w: DatWriter): void {
  const magic = r.readUInt8();
  if (magic !== 0x11) throw new Error(`CharGen1999: ObjDesc magic 0x${magic.toString(16)} at ${r.position - 1}`);
  const nPal = r.readUInt8(), nTex = r.readUInt8(), nAnim = r.readUInt8();
  w.align(4);
  w.writeUInt8(0x11).writeUInt8(nPal).writeUInt8(nTex).writeUInt8(nAnim);
  if (nPal > 0) {
    writeDataIdOfKnownType(w, 0x04000000 | r.readUInt16(), 0x04000000);
    for (let i = 0; i < nPal; i++) {
      writeDataIdOfKnownType(w, 0x04000000 | r.readUInt16(), 0x04000000);
      w.writeUInt8(r.readUInt8()).writeUInt8(r.readUInt8()); // offset/8, numColors/8 (0 = 256)
    }
  }
  for (let i = 0; i < nTex; i++) {
    w.writeUInt8(r.readUInt8());
    writeDataIdOfKnownType(w, 0x05000000 | r.readUInt16(), 0x05000000);
    writeDataIdOfKnownType(w, 0x05000000 | r.readUInt16(), 0x05000000);
  }
  for (let i = 0; i < nAnim; i++) {
    w.writeUInt8(r.readUInt8());
    writeDataIdOfKnownType(w, 0x01000000 | r.readUInt16(), 0x01000000);
  }
  r.align(4);
  w.align(4);
}

/** A u32-counted list in 1999 → a CompressedUInt32-counted list in EoL. */
function copyList(r: DatReader, w: DatWriter, fn: () => void): number {
  const n = r.readUInt32();
  if (n > 0x10000) throw new Error(`CharGen1999: list count ${n} at ${r.position - 4}`);
  w.writeCompressedUInt32(n);
  for (let i = 0; i < n; i++) fn();
  return n;
}

function copyU32List(r: DatReader, w: DatWriter): number[] {
  const out: number[] = [];
  copyList(r, w, () => { const v = r.readUInt32(); out.push(v); w.writeUInt32(v); });
  return out;
}

interface Sex1999 {
  name: string;
  /** The sex's 0x31 description (the heritage's naming conventions). */
  description: number;
  /** Each template's 0x31 description, in template order. */
  templateDescriptions: number[];
  attribCap: number;
  skillCredits: number;
  /** EoL bytes of the heritage-level skill list and template list (both carry their count). */
  skills: ArrayBuffer;
  templates: ArrayBuffer;
}

function asciiOf(b: Uint8Array): string {
  let s = '';
  for (const c of b) s += String.fromCharCode(c);
  return s;
}

/**
 * Read one 1999 Sex_CG at r's position and write its EoL SexCG into `w`
 * (written in place: EoL ObjDescs align to the absolute file offset).
 */
function readSex1999(r: DatReader, w: DatWriter): Sex1999 {
  const nameBytes = readU32String1999(r);
  const setup = r.readUInt32();
  const soundTable = r.readUInt32();
  const icon = r.readUInt32();
  const description = r.readUInt32(); // a 0x31 LanguageString id (no EoL slot; readCharGen1999Text)
  const objDescAt = r.position;
  copyObjDesc(r, new DatWriter()); // skip; written below once the palettes are known

  // Pre-template header: a setup + a texture id, two name-particle string
  // lists (e.g. Gharu'ndim "al-"/"ibn"), attribute cap, skill credits.
  r.readUInt32(); r.readUInt32();
  for (let k = 0; k < 2; k++) {
    const n = r.readUInt32();
    for (let i = 0; i < n; i++) readU32String1999(r);
  }
  const attribCap = r.readUInt32();
  r.readUInt32();
  const skillCredits = r.readUInt32();
  r.readUInt32();

  const skills = new DatWriter();
  copyList(r, skills, () => { skills.writeUInt32(r.readUInt32()).writeInt32(r.readInt32()).writeInt32(r.readInt32()); });

  const templates = new DatWriter();
  const templateDescriptions: number[] = [];
  copyList(r, templates, () => {
    write7BitString(templates, readU32String1999(r));
    templates.writeUInt32(r.readUInt32()); // icon
    templateDescriptions.push(r.readUInt32()); // a 0x31 LanguageString id (the template's description), no EoL slot
    templates.writeUInt32(0); // title: 1999 templates grant none
    r.readUInt32(); // 1999 flag (1), no EoL slot
    for (let i = 0; i < 6; i++) templates.writeUInt32(r.readUInt32()); // str end coord quick focus self
    copyU32List(r, templates); // normal skills
    copyU32List(r, templates); // primary skills
    r.readUInt32(); // 1999 trailing word (0)
  });

  r.readUInt32(); // unknown (0)
  const basePalette = r.readUInt32();
  const skinPalSet = r.readUInt32();

  write7BitString(w, nameBytes);
  w.writeUInt32(100); // scale: not in the 1999 data (the server uses 100)
  w.writeUInt32(setup).writeUInt32(soundTable).writeUInt32(icon);
  w.writeUInt32(basePalette).writeUInt32(skinPalSet);
  w.writeUInt32(0).writeUInt32(0).writeUInt32(0); // physics/motion/combat tables: not in the 1999 data
  const resume = r.position;
  r.position = objDescAt;
  copyObjDesc(r, w);
  r.position = resume;
  copyU32List(r, w); // hair colors
  copyList(r, w, () => { // hair styles
    w.writeUInt32(r.readUInt32());
    w.writeUInt8(r.readUInt32() ? 1 : 0); // bald: u32 in 1999, u8 in EoL
    w.writeUInt32(0); // alternate setup: not in 1999
    copyObjDesc(r, w);
  });
  copyU32List(r, w); // eye colors
  copyList(r, w, () => { // eye strips
    w.writeUInt32(r.readUInt32()).writeUInt32(r.readUInt32());
    r.align(4); copyObjDesc(r, w);
    r.align(4); copyObjDesc(r, w);
  });
  for (let k = 0; k < 2; k++) { // nose strips, mouth strips
    copyList(r, w, () => { w.writeUInt32(r.readUInt32()); r.align(4); copyObjDesc(r, w); });
  }
  for (let k = 0; k < 4; k++) { // headgear, shirt, pants, footwear
    copyList(r, w, () => {
      write7BitString(w, readU32String1999(r));
      w.writeUInt32(r.readUInt32()).writeUInt32(r.readUInt32());
    });
  }
  copyU32List(r, w); // clothing colors
  r.readUInt32(); // trailer word

  return {
    name: asciiOf(nameBytes), description, templateDescriptions, attribCap, skillCredits,
    skills: skills.toArrayBuffer(), templates: templates.toArrayBuffer(),
  };
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** EoL / ACE Gender: Male = 1, Female = 2. */
const GENDER_BY_NAME: Record<string, number> = { Male: 1, Female: 2 };

/**
 * The chargen text the EoL CharacterGenerator has no slot for: the 1999
 * CharGen's 0x31 String ids (served as EoL LanguageStrings by the overlay).
 * Keys follow the transcode: heritages 1..3, Gender 1 Male / 2 Female, and
 * templates in the transcoded heritage's order (the first sex's, as there).
 */
export interface CharGen1999Text {
  /**
   * The eight page help strings, in file order. On the retail CD: the sex,
   * appearance, clothing, heraldry, attributes, skills, (unfinished) and name
   * pages' help (0x3100001f, 0x31000013–0x31000019).
   */
  pages: number[];
  heritages: Map<number, {
    /** The heritage's description (0x31000001 Aluvian …). */
    description: number;
    /** Each template's description, in the transcoded template order. */
    templates: number[];
    /** Per Gender: the sex's description (the heritage's naming conventions). */
    sexes: Map<number, number>;
  }>;
}

/** The 1999 CharGen's text ids (CharGen1999Text), read from the raw 1999 file. */
export function readCharGen1999Text(raw: ArrayBuffer): CharGen1999Text {
  const text: CharGen1999Text = { pages: [], heritages: new Map() };
  transcodeCharGen1999(raw, text);
  return text;
}

export function transcodeCharGen1999(raw: ArrayBuffer, text?: CharGen1999Text): ArrayBuffer {
  const r = new DatReader(raw);
  const w = new DatWriter();
  const id = r.readUInt32();
  for (let i = 0; i < 8; i++) {
    const page = r.readUInt32(); // 0x31 ids (chargen page help), no EoL slot
    text?.pages.push(page);
  }
  w.writeUInt32(id).writeUInt32(id); // EoL: id, then a word ACE skips (the EoL DAT repeats the id)

  // Start areas: 1:1 (the heritages' start-area lists index this array, as
  // the 1999 server's do), each a named area with its positions.
  copyList(r, w, () => {
    write7BitString(w, readU32String1999(r));
    copyList(r, w, () => { for (let i = 0; i < 8; i++) w.writeUInt32(r.readUInt32()); }); // cell + origin + quaternion
  });

  w.writeUInt8(0); // the byte ACE skips before the heritage dictionary
  const nHeritage = r.readUInt32();
  if (nHeritage > 64) throw new Error(`CharGen1999: ${nHeritage} heritages`);
  w.writeCompressedUInt32(nHeritage);
  for (let h = 0; h < nHeritage; h++) {
    w.writeUInt32(h + 1); // HeritageGroup enum: Aluvian 1, Gharu'ndim 2, Sho 3 (the 1999 array order)
    const name = readU32String1999(r);
    const icon = r.readUInt32();
    const setup = r.readUInt32();
    const description = r.readUInt32(); // a 0x31 LanguageString id (the heritage description), no EoL slot
    const envSetup = r.readUInt32(); // the chargen backdrop setup (EoL's 0x020005A1.. ids match)
    const primary = new DatWriter();
    copyU32List(r, primary);
    const secondary = new DatWriter();
    copyU32List(r, secondary);
    const nSex = r.readUInt32();
    if (nSex > 4) throw new Error(`CharGen1999: ${nSex} sexes`);
    // Pass 1: the heritage-level fields EoL writes before the sexes.
    const sexes: Sex1999[] = [];
    const sexStarts: number[] = [];
    for (let s = 0; s < nSex; s++) {
      sexStarts.push(r.position);
      sexes.push(readSex1999(r, new DatWriter()));
    }
    const heritageEnd = r.position;
    const first = sexes[0];
    // 1999 keeps skills, templates and credits per sex; EoL keeps them per
    // heritage. The sexes agree on skills and credits; their templates
    // differ only in icon and skill-list order, so the first sex's (Female,
    // as the 1999 server uses) stand for the heritage.
    for (const s of sexes) {
      if (!sameBytes(s.skills, first.skills) || s.attribCap !== first.attribCap || s.skillCredits !== first.skillCredits) {
        throw new Error(`CharGen1999: heritage ${asciiOf(name)} sexes disagree on skills/credits`);
      }
    }

    write7BitString(w, name);
    w.writeUInt32(icon).writeUInt32(setup).writeUInt32(envSetup);
    w.writeUInt32(first?.attribCap ?? 0).writeUInt32(first?.skillCredits ?? 0);
    w.writeBytes(new Uint8Array(primary.toArrayBuffer()));
    w.writeBytes(new Uint8Array(secondary.toArrayBuffer()));
    if (first) {
      w.writeBytes(new Uint8Array(first.skills)).writeBytes(new Uint8Array(first.templates));
    } else {
      w.writeCompressedUInt32(0).writeCompressedUInt32(0);
    }
    w.writeUInt8(0); // the byte ACE skips before the gender dictionary
    w.writeCompressedUInt32(nSex);
    // Pass 2: the sexes, written in place, keyed by the Gender enum and in
    // EoL's key order (1999 stores [Female, Male] positionally).
    const order = sexes.map((s, i) => ({ key: GENDER_BY_NAME[s.name] ?? i + 1, i })).sort((a, b) => a.key - b.key);
    text?.heritages.set(h + 1, {
      description,
      templates: first?.templateDescriptions ?? [],
      sexes: new Map(order.map(({ key, i }) => [key, sexes[i].description])),
    });
    for (const { key, i } of order) {
      w.writeInt32(key);
      r.position = sexStarts[i];
      readSex1999(r, w);
    }
    r.position = heritageEnd;
  }
  if (r.remaining !== 0) throw new Error(`CharGen1999: ${r.remaining} unread bytes at ${r.position}`);
  return w.toArrayBuffer();
}

// ─── XpTable (0x0E000018) ─────────────────────────────────────────────────────

export function transcodeXpTable1999(raw: ArrayBuffer): ArrayBuffer {
  const c = new Copier(raw, 'XpTable1999');
  c.u32(); // id
  const maxAttr = c.u32(), maxVital = c.u32(), maxTrained = c.u32(), maxSpec = c.u32(), maxLevel = c.u32();
  if (maxLevel > 1000 || maxAttr > 1000 || maxVital > 1000 || maxTrained > 1000 || maxSpec > 1000) {
    throw new Error(`XpTable1999: implausible maxima ${[maxAttr, maxVital, maxTrained, maxSpec, maxLevel]}`);
  }
  c.words(maxAttr + 1 + maxVital + 1 + maxTrained + 1 + maxSpec + 1);
  for (let i = 0; i <= maxLevel; i++) c.w.writeUInt64(c.r.readUInt32()); // level XP: u32 in 1999, u64 in EoL
  c.words(maxLevel + 1); // skill credits per level
  return c.finish();
}

// ─── String (0x31xxxxxx) ──────────────────────────────────────────────────────

export function transcodeString1999(raw: ArrayBuffer): ArrayBuffer {
  const r = new DatReader(raw);
  const w = new DatWriter();
  w.writeUInt32(r.readUInt32()); // id
  const text = readAcString1999(r); // AcString: u16 length incl. NUL, pad to 4
  w.writeCompressedUInt32(text.length).writeBytes(text); // EoL LanguageString: compressed length, no NUL, no pad
  if (r.remaining !== 0) throw new Error(`String1999: ${r.remaining} unread bytes`);
  return w.toArrayBuffer();
}

// ─── SpellTable (0x0E00000E) ──────────────────────────────────────────────────

/** 1999 SpellFormula::GetTargetingType: target component id → ItemType. */
function targetTypeOfComponent(comp: number): number {
  switch (comp) {
    case 0x31: case 0x32: case 0x33: case 0x34: case 0x35: case 0x36:
    case 0x37: case 0x38: case 0x3a: case 0x3c: case 0x3d: case 0x3e:
      return 0x10; // TYPE_CREATURE
    case 0x39:
      return 0xa090f; // TYPE_ITEM_ENCHANTABLE_TARGET
    case 0x3b:
      return 0x10000; // TYPE_PORTAL_MAGIC_TARGET
    default:
      return 0; // TYPE_UNDEF
  }
}

/**
 * The 1999 client's CSpellBase::InqTargetType: 0 unless the first five
 * components are present, else the target type of the last component in
 * slots 4..7 (the first empty slot from 5 on ends the formula).
 */
export function spellTargetType1999(comps: readonly number[]): number {
  for (let i = 0; i < 5; i++) if (!comps[i]) return 0;
  let i = 5;
  while (i < 8 && comps[i]) i++;
  return targetTypeOfComponent(comps[i - 1]);
}

export function transcodeSpellTable1999(raw: ArrayBuffer): ArrayBuffer {
  const c = new Copier(raw, 'SpellTable1999');
  const { r, w } = c;
  c.u32(); // id
  const count = r.readUInt16();
  const buckets = r.readUInt16();
  w.writeUInt16(count).writeUInt16(buckets);
  for (let n = 0; n < count; n++) {
    c.u32(); // spell id
    // Name and description: nibble-swapped AcStrings (u16 length incl. NUL)
    // → EoL obfuscated strings (u16 length, no NUL), still nibble-swapped.
    const name = c.str();
    const desc = c.str();
    c.words(9); // school, icon, category, bitfield, base mana, range const/mod, power, economy mod
    // Formula version: 0 in every 1999 spell, but the 1999 client personalizes
    // EVERY formula with RandomizeVersion1 (CSpellBase personalized-formula @
    // 0x540140 calls SpellFormula::RandomizeVersion1 @ 0x5d8f40 directly: no
    // version dispatch existed yet), and so does the AC1999 server when it
    // reserves components (SpellcastingManager ReserveSpellComponents). EoL's
    // field picks the randomizer (RandomizeForName @ 005bd050): write 1.
    r.readUInt32();
    w.writeUInt32(SPELL_FORMULA_VERSION_1999);
    c.u32(); // component loss
    const metaType = c.u32();
    c.u32(); // meta spell id
    if (metaType === 1 || metaType === 12) { c.f64(); c.f32(); c.f32(); } // (Fellow)Enchantment: duration, degrade mod/limit
    else if (metaType === 7) c.f64(); // PortalSummon: portal lifetime
    else if (metaType < 1 || metaType > 15) throw new Error(`SpellTable1999: spell type ${metaType}`);
    // The formula keeps its obfuscation: EoL uses the same name/description
    // key, so our parser's decryptFormula recovers the components.
    const rawComps: number[] = [];
    for (let i = 0; i < 8; i++) rawComps.push(c.u32());
    // Caster, target, fizzle effects: PScriptType ordinals, renumbered to EoL's (PhysicsScriptTable below).
    for (let i = 0; i < 3; i++) w.writeUInt32(playScript1999ToEoL(r.readUInt32()));
    c.f64(); c.f32(); // recovery interval, amount
    // EoL-only trailing fields.
    w.writeUInt32(0); // display order: 1999 has none
    w.writeUInt32(spellTargetType1999(decodeFormula1999(rawComps, unswap(name), unswap(desc))));
    w.writeUInt32(0); // mana mod: 1999 has none
  }
  w.writeUInt16(0).writeUInt16(0); // SpellSet table: none in 1999
  return c.finish();
}

function unswap(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(((x >> 4) | (x << 4)) & 0xff);
  return s;
}

/** Component ids from the obfuscated formula words (0 stays 0), as the 1999 InqSpellFormula computes them. */
function decodeFormula1999(raw: readonly number[], name: string, desc: string): number[] {
  const key = ((computeSpellHash(name) % 0x12107680) + (computeSpellHash(desc) % 0xbeadcf45)) >>> 0;
  return raw.map((v) => (v ? (v - key) >>> 0 : 0));
}

/** The EoL formula version (SpellFormula::RandomizeForName) every 1999 spell is served with: RandomizeVersion1. */
export const SPELL_FORMULA_VERSION_1999 = 1;

// ─── SpellComponentTable (0x0E00000F) ─────────────────────────────────────────

/**
 * Same layout as EoL (u32 id, u16 count, u16 buckets, count × {u32 key, name,
 * category, icon, type, gesture, f32 time, text, f32 cdm}), but the name and
 * text are nibble-swapped AcStrings whose length counts a trailing NUL: read
 * as is, every component name ends in "\0". Drop the NUL (EoL obfuscated
 * strings carry none); the bytes stay nibble-swapped.
 */
export function transcodeSpellComponentTable1999(raw: ArrayBuffer): ArrayBuffer {
  const c = new Copier(raw, 'SpellComponentTable1999');
  const { r, w } = c;
  c.u32(); // id
  const count = r.readUInt16();
  w.writeUInt16(count).writeUInt16(r.readUInt16()); // count, buckets
  for (let i = 0; i < count; i++) {
    c.u32(); // key (component id)
    c.str(); // name
    c.words(5); // category, icon, type, gesture, time
    c.str(); // text
    c.u32(); // cdm (f32 bits)
  }
  return c.finish();
}

// ─── Spell-component DualDidMapper (synthetic 0x27000002) ─────────────────────

/** The DualDidMapper end of retail keeps the spell-component id → WCID map in (ACE Spell.SpellComponentDIDs). */
export const SPELL_COMPONENT_MAPPER_ID = 0x27000002;

/**
 * The 1999 client's spell-component id → weenie class map, by component id
 * (index 0 = component 1). The 1999 portal has no DualDidMapper: the client
 * hardcodes it in SpellComponentTable::SCIDtoWCID @ 0x5e41f0, a switch on
 * (scid - 1) through the 74-entry jump table at 0x5e4578, each case
 * `mov [ebp-4], wcid` (default 0); WCIDtoSCID @ 0x5e46a0 is its inverse over
 * the wcid blocks 625-627, 686-691, 740-792, 1643-1654. Decoded from
 * dat-sets/ac1999-retail/client.exe (tests/verify-ac1999-spell-components.ts
 * re-decodes it). Identical, for all 74 ids, to end of retail's 0x27000002.
 */
export const SPELL_COMPONENT_WCIDS_1999: readonly number[] = [
  691, 689, 686, 688, 687, 690, // 1-6 scarabs: lead, iron, copper, silver, gold, pyreal
  774, 775, 778, 768, 776, 766, 780, 625, 772, 765, 779, 777, 770, 771, 769, 773, 767, 781, // 7-24 herbs
  782, 783, 784, 785, 786, 626, 787, 788, 789, 790, 791, 792, // 25-36 powders
  753, 754, 755, 756, 757, 758, 759, 760, 761, 762, 763, 764, // 37-48 potions
  749, 742, 752, 747, 627, 744, 741, 748, 740, 745, 746, 750, 751, 743, // 49-62 talismans
  1650, 1649, 1648, 1653, 1645, 1654, 1643, 1647, 1651, 1644, 1652, 1646, // 63-74 tapers
];

/**
 * The end-of-retail DualDidMapper 0x27000002 built from the 1999 client's
 * SCIDtoWCID, so the cast pre-check, spell examination and component lists
 * read the 1999 map exactly as they read end of retail's. Client side: id
 * numbering Bitfield32 (3) as in EoL, no names (the 1999 client had none);
 * server side empty, as in EoL.
 */
export function synthesizeSpellComponentMapper1999(): ArrayBuffer {
  const w = new DatWriter().writeUInt32(SPELL_COMPONENT_MAPPER_ID);
  w.writeUInt8(3).writeCompressedUInt32(SPELL_COMPONENT_WCIDS_1999.length);
  SPELL_COMPONENT_WCIDS_1999.forEach((wcid, i) => w.writeUInt32(i + 1).writeUInt32(wcid));
  w.writeUInt8(3).writeCompressedUInt32(0); // client names
  w.writeUInt8(1).writeCompressedUInt32(0); // server ids
  w.writeUInt8(1).writeCompressedUInt32(0); // server names
  return w.toArrayBuffer();
}

// ─── PhysicsScriptTable (0x34xxxxxx) ──────────────────────────────────────────

/**
 * Byte-identical layout (u32 id, u16 count, u16 buckets, count × {u32 key, u32 n,
 * n × {f32 mod, u32 script}}), but the KEY is a PScriptType ordinal and 1999's
 * enum lacks EoL's SkillDownBlack (30): every 1999 key from 30 up is one lower
 * than EoL's (@ac/shared PlayScript1999). Keys are renumbered to EoL's so our
 * client's own PlayScript lookups (PortalStorm, Fizzle, Hidden/UnHide) find the
 * 1999 scripts; the 0xF755 codec renumbers the server's ordinals the same way.
 */
export function transcodePhysicsScriptTable1999(raw: ArrayBuffer): ArrayBuffer {
  const c = new Copier(raw, 'PhysicsScriptTable1999');
  const { r, w } = c;
  c.u32(); // id
  const count = r.readUInt16();
  w.writeUInt16(count);
  w.writeUInt16(r.readUInt16()); // buckets
  for (let i = 0; i < count; i++) {
    w.writeUInt32(playScript1999ToEoL(r.readUInt32()));
    c.list(() => { c.u32(); c.u32(); }); // mod (f32 bits), script id
  }
  return c.finish();
}
