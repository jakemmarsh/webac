/**
 * BUG.ac1999-skill-name-nul — the 1999 SkillTable's names carried their NUL
 * ("trained Item Enchantment\0", "Item Enchantment\0 68 → 78").
 *
 * The 1999 AcString's u16 length counts a trailing NUL (Pkt_ReadString @
 * 0x4b0cf0 copies `length` bytes and makes the last one the terminator), and
 * the 1999 overlay translated every string-bearing 0x0E table except the
 * SkillTable 0x0E000004, which parses as is with our end-of-retail reader.
 * Fixed twice over: the overlay translates 0x0E000004 (transcodeSkillTable1999),
 * and DatReader.readPString drops one trailing NUL (a streamed 1999 set
 * published before, the untranslated GeneratorTable), as the client's C string
 * ends there. End-of-retail / Dark Majesty strings carry none: unchanged.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { DatWriter } from '../packages/dat-parser/src/era1999/DatWriter.js';
import { transcodeSkillTable1999 } from '../packages/dat-parser/src/era1999/Tables1999.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { SkillTable } from '../packages/dat-parser/src/file-types/SkillTable.js';
import { GeneratorTable } from '../packages/dat-parser/src/file-types/GeneratorTable.js';
import { openDat } from './_harness/dat.js';

const bytesOf = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

/** A 1999 AcString: u16 length incl. NUL, bytes, NUL, pad 4. */
const acString = (w: DatWriter, s: string): DatWriter => w.writeUInt16(s.length + 1).writeBytes(bytesOf(s)).writeUInt8(0).align(4);

/** One 1999 SkillTable entry for `id`. */
function skill1999(w: DatWriter, id: number, name: string, description: string): void {
  w.writeUInt32(id);
  acString(w, description);
  acString(w, name);
  for (const v of [0x06000100 + id, 4, 8, 1, 0, 0]) w.writeUInt32(v); // icon, trained, specialized, category, chargen use, min level
  for (const v of [1, 1, 1, 3, 4, 0]) w.writeUInt32(v); // formula
  w.writeFloat64(999).writeFloat64(0).writeFloat64(1);
}

describe('BUG.ac1999-skill-name-nul: the 1999 SkillTable', () => {
  it('translates to the end-of-retail layout with each NUL dropped, every byte consumed', () => {
    const w = new DatWriter();
    w.writeUInt32(0x0e000004).writeUInt16(2).writeUInt16(64);
    skill1999(w, 32, 'Item Enchantment', 'Enchants items.');
    skill1999(w, 6, 'Melee Defense', 'Blocks.');
    const out = transcodeSkillTable1999(w.toArrayBuffer());
    const r = new DatReader(out);
    const t = new SkillTable(r);
    expect(r.remaining).toBe(0);
    expect(t.skills.get(32)?.name).toBe('Item Enchantment');
    expect(t.skills.get(32)?.description).toBe('Enchants items.');
    expect(t.skills.get(6)?.name).toBe('Melee Defense');
    expect(t.skills.get(32)?.iconId).toBe(0x06000120);
    expect(t.skills.get(32)?.formula).toEqual({ w: 1, x: 1, y: 1, z: 3, attr1: 4, attr2: 0 });
    expect(t.skills.get(32)?.upperBound).toBe(999);
  });

  it('readPString drops one trailing NUL, keeps the bytes consumed, and leaves NUL-free text alone', () => {
    const w = new DatWriter();
    w.writeUInt16(5).writeBytes(bytesOf('wave')).writeUInt8(0);
    w.writeUInt16(4).writeBytes(bytesOf('Axe!'));
    w.writeUInt16(0);
    const r = new DatReader(w.toArrayBuffer());
    expect(r.readPString()).toBe('wave');
    expect(r.position).toBe(7);
    expect(r.readPString()).toBe('Axe!');
    expect(r.readPString()).toBe('');
    expect(r.remaining).toBe(0);
    // The nibble-swapped AcString (1999 spell / generator names): its swapped NUL is 0 too.
    const o = new DatWriter();
    const swapped = Uint8Array.from([...bytesOf('Drudge'), 0], (b) => ((b >> 4) | (b << 4)) & 0xff);
    o.writeUInt16(swapped.length).writeBytes(swapped);
    expect(new DatReader(o.toArrayBuffer()).readObfuscatedString()).toBe('Drudge');
  });
});

const ROOT = resolve(__dirname, '..');
const PORTAL_1999 = resolve(ROOT, 'dat/sets/ac1999-retail/portal.dat');
const PORTAL_EOR = resolve(ROOT, 'dat/client_portal.dat');
const PORTAL_DM = resolve(ROOT, 'dat/sets/classic-dereth/client_portal.dat');

describe.skipIf(!existsSync(PORTAL_1999))('BUG.ac1999-skill-name-nul: the real 1999 portal.dat', () => {
  it('the overlay serves every skill name and description without a NUL; the raw table reads clean too', () => {
    const portal = openDat(PORTAL_1999);
    const overlay = ac1999PortalOverlay();
    const served = overlay.get(0x0e000004, (i) => portal.getFileData(i))!;
    const r = new DatReader(served);
    const t = new SkillTable(r);
    expect(r.remaining).toBe(0);
    expect(t.skills.size).toBe(35);
    expect(t.skills.get(32)?.name).toBe('Item Enchantment');
    for (const [id, s] of t.skills) {
      expect(s.name, `skill ${id}`).not.toMatch(/\0/);
      expect(s.description, `skill ${id}`).not.toMatch(/\0/);
    }
    // A streamed 1999 set published before the overlay translated 0x0E000004 serves the raw bytes.
    const raw = new SkillTable(new DatReader(portal.getFileData(0x0e000004)!));
    expect([...raw.skills.values()].map((s) => s.name)).toEqual([...t.skills.values()].map((s) => s.name));
  });

  it('the untranslated GeneratorTable names read without a NUL', () => {
    const portal = openDat(PORTAL_1999);
    const g = GeneratorTable.read(new DatReader(portal.getFileData(0x0e00000d)!));
    expect(g.totalNodes).toBeGreaterThan(0);
    expect(JSON.stringify(g)).not.toContain('\\u0000');
  });
});

describe.skipIf(!existsSync(PORTAL_EOR))('end of retail and Dark Majesty skill names are unchanged', () => {
  it('the same names as the raw bytes say, none ending in a NUL', () => {
    for (const path of [PORTAL_EOR, PORTAL_DM]) {
      if (!existsSync(path)) continue;
      const t = new SkillTable(new DatReader(openDat(path).getFileData(0x0e000004)!));
      expect(t.skills.get(32)?.name, path).toBe('Item Enchantment');
      expect(t.skills.get(6)?.name, path).toBe('Melee Defense');
      for (const [id, s] of t.skills) expect(s.name, `${path} ${id}`).toMatch(/^[A-Za-z][A-Za-z ]*[a-z]$/);
    }
  });
});
