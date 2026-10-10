/**
 * BUG.playscript-procedural-effects — every PlayScript resolves through the
 * target's PhysicsScriptTable to a DAT PhysicsScript (retail
 * CPhysicsObj::play_script → PhysicsScriptTableData::GetScript @ 00521a20),
 * picked by the wire intensity. Found live: a melee hit on a drudge (PeTable
 * 0x3400001A) drew our hand-made createWeaponImpact burst instead of the
 * table's Splatter* script.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatDatabase, DatReader, PhysicsScriptTable, PhysicsScript } from '@ac/dat-parser';
import { resolvePlayScript } from '../packages/renderer/src/effects/PlayScriptResolve.js';
import { openDat } from './_harness/dat.js';

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
const HAS_DAT = existsSync(PORTAL);

/** A table built from entries, for the unit cases. */
function table(scripts: Record<number, Array<{ mod: number; scriptId: number }>>): PhysicsScriptTable {
  const t = new PhysicsScriptTable();
  for (const [k, v] of Object.entries(scripts)) t.scripts.set(Number(k), v);
  return t;
}

describe('resolvePlayScript (unit)', () => {
  const tables = new Map<number, PhysicsScriptTable>([
    [0x34000001, table({ 0x5b: [{ mod: 0.3, scriptId: 0x33000010 }, { mod: 1, scriptId: 0x33000011 }] })],
    [0x34000002, table({ 0x5b: [{ mod: 1, scriptId: 0x33000020 }] })],
  ]);
  const load = (id: number) => tables.get(id) ?? null;
  const setupTable = (setup: number) => (setup === 0x02000099 ? 0x34000002 : 0);

  it('the PeTable wins, and the wire intensity picks the entry', () => {
    expect(resolvePlayScript({ peTableId: 0x34000001, setupId: 0x02000099 }, 0x5b, 0.2, load, setupTable))
      .toEqual({ tableId: 0x34000001, scriptId: 0x33000010 });
    expect(resolvePlayScript({ peTableId: 0x34000001, setupId: 0 }, 0x5b, 0.8, load, setupTable)?.scriptId).toBe(0x33000011);
  });
  it('no PeTable → the Setup DefaultScriptTable', () => {
    expect(resolvePlayScript({ peTableId: 0, setupId: 0x02000099 }, 0x5b, 1, load, setupTable)?.scriptId).toBe(0x33000020);
  });
  it('no entry, no table, or intensity above every threshold → null (the caller falls back)', () => {
    expect(resolvePlayScript({ peTableId: 0x34000001, setupId: 0 }, 0x66, 1, load, setupTable)).toBeNull();
    expect(resolvePlayScript({ peTableId: 0, setupId: 0 }, 0x5b, 1, load, setupTable)).toBeNull();
    expect(resolvePlayScript({ peTableId: 0x34000001, setupId: 0 }, 0x5b, 1.5, load, setupTable)).toBeNull();
  });
});

describe.skipIf(!HAS_DAT)('resolvePlayScript against the EoL portal.dat', () => {
  let db: DatDatabase;
  beforeAll(() => {
    db = openDat(PORTAL);
  });
  const load = (id: number) => { const d = db.getFileData(id); return d ? PhysicsScriptTable.read(new DatReader(d)) : null; };

  it('every drudge Splatter* (0x5B–0x66) resolves to a real DAT PhysicsScript', () => {
    for (let e = 0x5b; e <= 0x66; e++) {
      const r = resolvePlayScript({ peTableId: 0x3400001a, setupId: 0 }, e, 1, load, () => 0);
      expect(r, `enum 0x${e.toString(16)}`).not.toBeNull();
      const data = db.getFileData(r!.scriptId);
      expect(data).toBeTruthy();
      expect(PhysicsScript.read(new DatReader(data!)).steps.length).toBeGreaterThan(0);
    }
  });
});
