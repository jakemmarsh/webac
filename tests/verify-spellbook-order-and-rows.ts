/**
 * VISUAL.spellbook-scrollbar-and-order — the spellbook list order.
 * gmSpellbookUI::GetSortedInsertionPlace @ 0048b440 inserts a spell before
 * the first row whose CSpellBase._display_order is greater than its own,
 * so the list runs in SpellTable DisplayOrder, and equal orders keep their
 * insertion order. It was level-then-name, which put Imperil Other I
 * before Flame Bolt VI (retail-ab spellbook).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spellbookOrder } from '../packages/renderer/src/ui/spellbookFilter.js';
import { openDat } from './_harness/dat.js';

describe('spellbookOrder (GetSortedInsertionPlace)', () => {
  it('sorts by display order; ties keep insertion order', () => {
    const order = new Map([[1, 30], [2, 10], [3, 20], [4, 10]]);
    const out = spellbookOrder([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], (id) => order.get(id) ?? 0);
    expect(out.map((s) => s.id)).toEqual([2, 4, 3, 1]);
  });
});

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
describe.skipIf(!existsSync(PORTAL))('spellbookOrder on the EoL SpellTable (needs DAT files)', () => {
  let displayOrder: (id: number) => number;
  let idOf: (name: string) => number;
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const db = openDat(PORTAL);
    const table = new SpellTable(new DatReader(db.getFileData(0x0e00000e)!));
    displayOrder = (id) => table.spells.get(id)?.displayOrder ?? 0;
    idOf = (name) => [...table.spells].find(([, s]) => s.name === name)![0];
  });

  it('retail-ab spellbook: Flame Bolt VI, Heal Self VI, Imperil Other I', () => {
    const spells = ['Imperil Other I', 'Flame Bolt VI', 'Heal Self VI'].map((name) => ({ id: idOf(name), name }));
    expect(spellbookOrder(spells, displayOrder).map((s) => s.name)).toEqual(['Flame Bolt VI', 'Heal Self VI', 'Imperil Other I']);
  });
});
