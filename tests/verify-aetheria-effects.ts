/**
 * GAP.13 — Aetheria: DAT-driven surge/level-up visuals.
 *
 * Division of labor verified against ACE: surge PROCS are entirely
 * server-side (WorldObject_Weapon.cs:957 TryProcItem with
 * Aetheria.CalcProcRate — ~1%/item level, ×2 magic / ×1.5 missile,
 * Entity/Aetheria.cs:275) and the result reaches clients as spell effects
 * plus a broadcast PlayScript. The client's faithful job is resolving that
 * PlayScript through the target's SetupModel.DefaultScriptTable to the
 * REAL 0x33 PhysicsScript — which this suite pins for the human table:
 * 0xA1-0xA6 → 0x3300125A-5F, single-entry mod=1.0 each.
 * (Both ACE and ACViewer stub the weighted GetScript — multi-entry mod
 * semantics live only in the retail client; flagged residual.)
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');

const HUMAN_SCRIPT_TABLE = 0x34000004;
const AETHERIA_PSCRIPTS = [0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6]; // LevelUp + 5 surges

describe.skipIf(!existsSync(PORTAL))('GAP.13 — Aetheria PScripts resolve through the real DAT chain', () => {
  async function load() {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader');
    const { PhysicsScript, PhysicsScriptTable } = await import('../packages/dat-parser/src/file-types/PhysicsScript');
    const db = openDat(PORTAL);
    const table = PhysicsScriptTable.read(new DatReader(db.getFileData(HUMAN_SCRIPT_TABLE)!));
    return { db, DatReader, PhysicsScript, table };
  }

  it('human table 0x34000004 maps all six Aetheria PScripts to single mod=1.0 entries 0x3300125A-5F', async () => {
    const { table } = await load();
    for (let i = 0; i < AETHERIA_PSCRIPTS.length; i++) {
      const entries = table.scripts.get(AETHERIA_PSCRIPTS[i]);
      expect(entries, `PScript 0x${AETHERIA_PSCRIPTS[i].toString(16)}`).toBeDefined();
      expect(entries!.length).toBe(1);
      expect(entries![0].mod).toBeCloseTo(1.0, 6);
      expect(entries![0].scriptId).toBe(0x3300125a + i);
    }
  });

  it('each resolved PhysicsScript parses with real steps (particles/sounds)', async () => {
    const { db, DatReader, PhysicsScript, table } = await load();
    for (const ps of AETHERIA_PSCRIPTS) {
      const scriptId = table.scripts.get(ps)![0].scriptId;
      const data = db.getFileData(scriptId);
      expect(data, `script 0x${scriptId.toString(16)}`).toBeTruthy();
      const script = PhysicsScript.read(new DatReader(data!));
      expect(script.steps.length, `script 0x${scriptId.toString(16)}`).toBeGreaterThan(0);
      for (const step of script.steps) {
        expect(step.hook).toBeDefined();
        expect(Number.isFinite(step.startTime)).toBe(true);
      }
    }
  });

  it('player setups carry NO DefaultScriptTable — the wire PeTable is the resolution root', async () => {
    // The human player setup has DefaultScriptTable = 0; players receive
    // 0x34000004 via the weenie (world DB: weenie 1, weenie_properties_d_i_d
    // type 22 = PropertyDataId.PhysicsEffectTable), delivered on the wire in
    // the CreateObject physics description's PeTable field (flag 0x1000) —
    // which the parser now surfaces as peTableId instead of discarding.
    const { db } = await load();
    const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setup: any = new (SetupModel as any)(db.getReader(0x02000001));
    expect(setup.defaultScriptTable >>> 0).toBe(0);
  });
});
