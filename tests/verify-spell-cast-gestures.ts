/**
 * GAP.11 — spell formula decryption + ACE-exact cast gesture choreography.
 *
 * ACE ground truth:
 *  - SpellBase.cs:121 DecryptFormula: the DAT stores formulas OBFUSCATED;
 *    key = (nameHash % 0x12107680) + (descHash % 0xBEADCF45) with
 *    SpellTable.ComputeHash (:32, CP-1252 signed-char shift-4 hash); values
 *    landing above component 198 mask to a byte. Pre-GAP.11 our parser kept
 *    the RAW values — every downstream consumer saw garbage.
 *  - SpellFormula.cs:245 WindupGestures (one gesture per scarab; Lead's is
 *    Invalid) + :271 CastGesture (talisman = last component; Ready
 *    fallback); Player_Magic.cs:603 CastSpeed = 2.0, :607 FastCast skips
 *    windups.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  computeSpellHash, decryptFormula,
} from '../packages/dat-parser/src/file-types/SpellTable.js';
import {
  getCastGestureSequence, getPlayerFormula, computeAccountHash, ComponentType,
} from '@ac/shared';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');

describe('GAP.11 — spell hash + formula decryption (SpellBase.cs:121)', () => {
  it('computeSpellHash matches the shared account-hash implementation (same ACE algorithm)', () => {
    for (const s of ['Strength Other I', 'Heal Self I', 'testacjs', '']) {
      expect(computeSpellHash(s)).toBe(computeAccountHash(s));
    }
  });

  it('decryptFormula applies key subtraction + byte-mask correction', () => {
    // Round-trip: encrypt a known formula with the ACE key derivation, decrypt back.
    const name = 'Strength Other I';
    const desc = 'x';
    const key = ((computeSpellHash(name) % 0x12107680) + (computeSpellHash(desc) % 0xbeadcf45)) >>> 0;
    const plain = [1, 7, 33, 44, 49];
    const raw = plain.map(c => (c + key) >>> 0);
    expect(decryptFormula(raw, name, desc)).toEqual(plain);
  });
});

describe('GAP.11 — cast gesture sequence (SpellFormula.cs:245/:271)', () => {
  const READY = 0x41000003;
  const comps = new Map([
    [1, { type: ComponentType.Scarab, gesture: 0x80000000 }],   // Lead — Invalid gesture
    [2, { type: ComponentType.Scarab, gesture: 0x10000070 }],   // Iron
    [7, { type: ComponentType.Herb, gesture: 0x80000000 }],
    [49, { type: ComponentType.Talisman, gesture: 0x4000002e }], // Poplar
    [188, { type: ComponentType.Taper, gesture: 0x80000000 }],
  ]);

  it('lead-scarab spell: no windup, talisman cast gesture only', () => {
    expect(getCastGestureSequence([1, 7, 49], comps, false)).toEqual([0x4000002e]);
  });

  it('iron-scarab spell: scarab windup then talisman cast gesture', () => {
    expect(getCastGestureSequence([2, 7, 49], comps, false)).toEqual([0x10000070, 0x4000002e]);
  });

  it('FastCast skips the windup', () => {
    expect(getCastGestureSequence([2, 7, 49], comps, true)).toEqual([0x4000002e]);
  });

  it('non-talisman last component falls back to Ready (ACE Invalid→Ready)', () => {
    expect(getCastGestureSequence([2, 7, 188], comps, false)).toEqual([0x10000070, READY]);
    expect(getCastGestureSequence([], comps, false)).toBe(null);
  });
});

describe.skipIf(!existsSync(PORTAL))('GAP.11 — real DAT: decrypted formulas + gestures', () => {
  async function load() {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase');
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable');
    const { SpellComponentTable } = await import('../packages/dat-parser/src/file-types/SpellComponentTable');
    const db = openDat(PORTAL);
    const spells = new SpellTable(db.getReader(0x0E00000E));
    const comps = new SpellComponentTable(db.getReader(0x0E00000F));
    return { spells, comps };
  }

  it('known spells decrypt to valid component ids (Strength Other I / Heal Self I)', async () => {
    const { spells } = await load();
    expect(spells.spells.get(1)!.formula).toEqual([1, 7, 33, 44, 49]);
    expect(spells.spells.get(6)!.formula).toEqual([1, 7, 26, 41, 61]);
  });

  it('EVERY spell formula decrypts into the valid component range 1..198', async () => {
    const { spells } = await load();
    let checked = 0;
    for (const [, sp] of spells.spells) {
      for (const c of sp.formula) {
        expect(c, `spell ${sp.name}`).toBeGreaterThanOrEqual(1);
        expect(c, `spell ${sp.name}`).toBeLessThanOrEqual(198);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10000); // thousands of spells × components
  });

  it('level-I spell end-to-end: player formula → talisman-only gesture; scarab tiers carry windups', async () => {
    const { spells, comps } = await load();
    const sp1 = spells.spells.get(1)!; // Strength Other I — Lead Scarab
    const f1 = getPlayerFormula(sp1.formula, sp1.formulaVersion, 'testacjs');
    const g1 = getCastGestureSequence(f1, comps.components, false)!;
    expect(g1).toEqual([0x4000002e]); // Poplar Talisman cast gesture, no windup

    // Iron Scarab windup gesture is a real motion in the components table.
    expect(comps.components.get(2)!.gesture >>> 0).toBe(0x10000070);
    expect(comps.components.get(1)!.gesture >>> 0).toBe(0x80000000); // Lead = Invalid

    // Acid Stream II (59): iron-scarab, NOT FastCast → windup + talisman.
    const sp59 = spells.spells.get(59)!;
    expect(sp59.bitfield & 0x4000).toBe(0);
    const f59 = getPlayerFormula(sp59.formula, sp59.formulaVersion, 'testacjs');
    expect(getCastGestureSequence(f59, comps.components, false)![0]).toBe(0x10000070);

    // Strength Self II (1328) IS FastCast in the EoL DAT (bitfield 0x400c) —
    // discovered live: the windup is correctly skipped for it.
    expect(spells.spells.get(1328)!.bitfield & 0x4000).toBe(0x4000);
  });
});
