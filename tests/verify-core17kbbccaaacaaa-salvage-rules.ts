/**
 * CORE.17.k.b.b.c.c.a.a.c.a.a.a — gmSalvageUI's acceptance rules.
 *
 * Retail (EoL acclient, decompiled):
 *  - DragItemAcceptable @ 004cb650: an object not IsOwnedByPlayer raises
 *    "You can only salvage items that you own!" (notice 0x1a); one already
 *    in m_salvageList is refused; a container with contents is accepted;
 *    anything else must pass IsItemSuitable.
 *  - IsItemSuitable @ 004cb040: TinkeringSystem::IsValidMaterialType(
 *    pwd._material_type), pwd._structure < 100, SalvageMultiple or the
 *    list's m_material (0 = empty) matching, and the bitfield's Retained
 *    bit (0x01000000) clear.
 *  - AddNewItem @ 004cb430 / _AddContainedItems @ 004cb4f0: a pack with
 *    contents prints "Adding contents of %s" (.rdata 0x7b7b10) and walks
 *    its children (a non-empty child container recursing) through
 *    _AddItem @ 004cb2d0, whose first add sets m_material.
 *  - IsValidMaterialType @ 005c9670: every ACE MaterialType except 0 and
 *    the generic categories Cloth 3 / Gem 9 / Metal 0x38 / Stone 0x41 /
 *    Wood 0x48 (and nothing past Oak 0x4b..0x4d).
 * Pre-fix the panel queued any inventory item and the wire's MaterialType
 * was read and discarded.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { parseCreateObject } from '../packages/network/src/MessageSerializer.js';
import { buildInventoryEntry } from '../packages/renderer/src/network/objectSubjectRouting.js';
import {
  isValidSalvageMaterialType, isSalvageItemSuitable, planSalvageDrop, salvageAddingContentsText,
  SALVAGE_NOT_OWNED_TEXT, SALVAGE_RETAINED_BIT, type SalvageCandidate, type SalvageDropState,
} from '../packages/renderer/src/ui/SalvagePanel.js';

const REPO = resolve(__dirname, '..');
const DECOMP_PATH = resolve(REPO, 'reference/client-eol/decomp/acclient-decompiled.c');
const EXE_PATH = resolve(REPO, 'reference/client-eol/acclient.exe');
const MATERIAL_ENUM = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/MaterialType.cs');
const hasDecomp = fs.existsSync(DECOMP_PATH) && fs.existsSync(EXE_PATH);
const hasAce = aceReferenceExists(MATERIAL_ENUM);

const IRON = 0x3d;
const STEEL = 0x40;
const LEATHER = 0x34;

class Writer {
  private bytes: number[] = [];
  u8(v: number): this { this.bytes.push(v & 0xff); return this; }
  u16(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  align(): this { while (this.bytes.length % 4 !== 0) this.u8(0); return this; }
  string16(s: string): this {
    this.u16(s.length);
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this.align();
  }
  out(): Uint8Array { return new Uint8Array(this.bytes); }
}

const FLAG_MATERIAL_TYPE = 0x80000000;
function createObjectBytes(weenieFlags: number, objectDescFlags: number, materialType: number): Uint8Array {
  const w = new Writer();
  w.u32(0x80036666);
  w.u8(0x11).u8(0).u8(0).u8(0);
  w.align();
  w.u32(0); w.u32(0);
  for (let i = 0; i < 9; i++) w.u16(0);
  w.align();
  w.u32(weenieFlags >>> 0);
  w.string16('Buckler');
  w.u16(6353); // weenieClassId (packed, 2-byte form)
  w.u16(1); // iconId
  w.u32(0); // itemType
  w.u32(objectDescFlags >>> 0);
  w.align();
  if (weenieFlags & FLAG_MATERIAL_TYPE) w.u32(materialType);
  w.align();
  return w.out();
}

describe('CORE.17.k.b.b.c.c.a.a.c.a.a.a — the wire carries what IsItemSuitable reads', () => {
  it('parseCreateObject keeps WeenieHeaderFlag.MaterialType (0x80000000) instead of discarding it', () => {
    const obj = parseCreateObject(createObjectBytes(FLAG_MATERIAL_TYPE, 0, IRON));
    expect(obj).not.toBeNull();
    expect(obj!.name).toBe('Buckler');
    expect(obj!.materialType).toBe(IRON);
  });

  it('no flag → materialType 0 (PublicWeenieDesc default)', () => {
    expect(parseCreateObject(createObjectBytes(0, 0, 0))!.materialType).toBe(0);
  });

  it('buildInventoryEntry puts the material type and the bitfield (Retained) on the inventory item', () => {
    const obj = parseCreateObject(createObjectBytes(FLAG_MATERIAL_TYPE, SALVAGE_RETAINED_BIT, STEEL))!;
    const entry = buildInventoryEntry(obj);
    expect(entry.materialType).toBe(STEEL);
    expect(entry.objectDescFlags).toBe(SALVAGE_RETAINED_BIT);
    expect(buildInventoryEntry(parseCreateObject(createObjectBytes(0, 0, 0))!).materialType).toBeUndefined();
  });
});

describe('CORE.17.k.b.b.c.c.a.a.c.a.a.a — IsValidMaterialType / IsItemSuitable', () => {
  it('IsValidMaterialType refuses 0 and the generic categories Cloth / Gem / Metal / Stone / Wood, accepts the specific materials', () => {
    for (const bad of [0, 3, 9, 0x38, 0x41, 0x48, 0x4e, 0x100]) expect(isValidSalvageMaterialType(bad)).toBe(false);
    for (const ok of [1, 2, 4, 8, 10, LEATHER, 0x37, 0x39, 0x40, 0x42, 0x47, 0x49, 0x4b, 0x4d]) expect(isValidSalvageMaterialType(ok)).toBe(true);
  });

  const buckler: SalvageCandidate = { id: 1, name: 'Buckler', materialType: IRON };

  it('a material-typed item is suitable; no material → not', () => {
    expect(isSalvageItemSuitable(buckler, 0, true)).toBe(true);
    expect(isSalvageItemSuitable({ id: 2, name: 'Ust' }, 0, true)).toBe(false);
  });

  it('_structure < 100 — a 100-use item is refused', () => {
    expect(isSalvageItemSuitable({ ...buckler, structure: 99 }, 0, true)).toBe(true);
    expect(isSalvageItemSuitable({ ...buckler, structure: 100 }, 0, true)).toBe(false);
  });

  it('a Retained item (bitfield 0x01000000) is refused', () => {
    expect(isSalvageItemSuitable({ ...buckler, objectDescFlags: SALVAGE_RETAINED_BIT | 0x10 }, 0, true)).toBe(false);
  });

  it('SalvageMultiple off: only the list\'s material (any while the list is empty); on: any material', () => {
    expect(isSalvageItemSuitable(buckler, STEEL, false)).toBe(false);
    expect(isSalvageItemSuitable(buckler, IRON, false)).toBe(true);
    expect(isSalvageItemSuitable(buckler, 0, false)).toBe(true);
    expect(isSalvageItemSuitable(buckler, STEEL, true)).toBe(true);
  });
});

describe('CORE.17.k.b.b.c.c.a.a.c.a.a.a — a drop on the list (AcceptDragObject → AddNewItem)', () => {
  const PACK = 10; const INNER = 11;
  const items: Record<number, SalvageCandidate> = {
    1: { id: 1, name: 'Buckler', materialType: IRON, containerId: 0 },
    2: { id: 2, name: 'Leather Cap', materialType: LEATHER, containerId: PACK },
    3: { id: 3, name: 'Pyreal', containerId: PACK },
    4: { id: 4, name: 'Steel Axe', materialType: STEEL, containerId: INNER },
    5: { id: 5, name: 'Iron Sword', materialType: IRON, containerId: PACK, objectDescFlags: SALVAGE_RETAINED_BIT },
    [PACK]: { id: PACK, name: 'Pack', containerId: 0 },
    [INNER]: { id: INNER, name: 'Pouch', containerId: PACK },
  };
  const state = (over: Partial<SalvageDropState> = {}): SalvageDropState => ({
    listed: [], listMaterial: 0, salvageMultiple: true, owned: true,
    contents: (g) => Object.values(items).filter((i) => i.containerId === g && i.id !== g),
    appropriateName: (i) => i.name,
    ...over,
  });

  it('a suitable item is added and becomes m_material', () => {
    const r = planSalvageDrop(items[1], state());
    expect(r).toEqual({ accepted: true, added: [items[1]], listMaterial: IRON, notices: [] });
  });

  it('not owned: "You can only salvage items that you own!", nothing added', () => {
    const r = planSalvageDrop(items[1], state({ owned: false }));
    expect(r.accepted).toBe(false);
    expect(r.notices).toEqual([SALVAGE_NOT_OWNED_TEXT]);
    expect(SALVAGE_NOT_OWNED_TEXT).toBe('You can only salvage items that you own!');
  });

  it('already listed → refused silently; unsuitable → refused silently', () => {
    expect(planSalvageDrop(items[1], state({ listed: [1], listMaterial: IRON }))).toMatchObject({ accepted: false, added: [], notices: [] });
    expect(planSalvageDrop(items[3], state())).toMatchObject({ accepted: false, added: [], notices: [] });
  });

  it('a pack adds its suitable contents, recursing into a nested pouch, with one "Adding contents of %s" notice per container', () => {
    const r = planSalvageDrop(items[PACK], state());
    expect(r.accepted).toBe(true);
    expect(r.added.map((i) => i.id)).toEqual([2, 4]); // pyreal (no material) + the Retained sword skipped
    expect(r.notices).toEqual(['Adding contents of Pack', 'Adding contents of Pouch']);
    expect(r.listMaterial).toBe(LEATHER);
    expect(salvageAddingContentsText('Pack')).toBe('Adding contents of Pack');
  });

  it('SalvageMultiple off: the first added item fixes the material for the rest of the walk', () => {
    const r = planSalvageDrop(items[PACK], state({ salvageMultiple: false }));
    expect(r.added.map((i) => i.id)).toEqual([2]);
    expect(r.listMaterial).toBe(LEATHER);
    expect(planSalvageDrop(items[1], state({ salvageMultiple: false, listed: [2], listMaterial: LEATHER })).accepted).toBe(false);
  });
});

describe.skipIf(!hasDecomp || !hasAce)('CORE.17.k.b.b.c.c.a.a.c.a.a.a — against the decompiled client + ACE MaterialType', () => {
  let validCases: Set<number>;
  let aceMaterials: number[];
  let exe: Buffer;
  beforeAll(() => {
    const src = fs.readFileSync(DECOMP_PATH, 'utf8');
    const start = src.indexOf('// ===== TinkeringSystem::IsValidMaterialType @ 005c9670');
    const body = src.slice(start, src.indexOf('// =====', start + 10));
    validCases = new Set([...body.matchAll(/case (0x[0-9a-f]+|\d+):/g)].map((m) => Number(m[1])));
    aceMaterials = [...fs.readFileSync(MATERIAL_ENUM, 'utf8').matchAll(/=\s*(0x[0-9A-Fa-f]+)/g)].map((m) => Number(m[1]));
    exe = fs.readFileSync(EXE_PATH);
  });

  it('isValidSalvageMaterialType agrees with IsValidMaterialType\'s switch for every value 0..0x100', () => {
    expect(validCases.size).toBeGreaterThan(60);
    for (let m = 0; m <= 0x100; m++) expect(isValidSalvageMaterialType(m)).toBe(validCases.has(m));
  });

  it('the refused ACE MaterialType values are exactly Unknown + the generic categories', () => {
    expect(aceMaterials.filter((m) => !isValidSalvageMaterialType(m))).toEqual([0, 3, 9, 0x38, 0x41, 0x48]);
  });

  it('the notice strings are the exe\'s wide literals', () => {
    const wide = (s: string): Buffer => Buffer.from(s, 'utf16le');
    expect(exe.indexOf(wide('Adding contents of %s\0'))).toBeGreaterThan(0);
    expect(exe.indexOf(wide(`${SALVAGE_NOT_OWNED_TEXT}\0`))).toBeGreaterThan(0);
  });
});
