/**
 * BUG.playscript-fallback-invented-art — a server PlayScript plays the
 * target's DAT PhysicsScript or NOTHING.
 *
 * Retail: PlayEffect (0xF755) → SmartBox::HandlePlayScriptType @ 00452070 →
 * CPhysicsObj::play_script(PScriptType, float) @ 00513260, which returns 0
 * without drawing anything when the object has no physics_script_table, and
 * otherwise plays PhysicsScriptTable::GetScript's pick via
 * play_script_internal @ 00510cd0. PlayScriptId (0xF754) →
 * HandlePlayScriptID @ 00452020 → play_script(DID) @ 00510d30: the DID plays
 * directly, no table. Pre-fix, main.ts's onPlayScript fell through to a
 * 60-arm switch of SpellEffects auras / flashes / impacts / translucency
 * (createAura, createHealGlow, createDebuffAura, createImpactFlash,
 * createWeaponImpact, …) whenever the table had no entry or the mesh was
 * missing — art retail never drew. The dispatch now lives in
 * effects/PlayScriptResolve.ts (playScriptType / playScriptDid) and main.ts
 * only supplies the sink.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatDatabase, DatReader, PhysicsScript, PhysicsScriptTable } from '@ac/dat-parser';
import { playScriptType, playScriptDid, type PlayScriptSink } from '../packages/renderer/src/effects/PlayScriptResolve.js';
import { openDat } from './_harness/dat.js';

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');

function script(id: number): PhysicsScript {
  const s = new PhysicsScript();
  s.id = id;
  s.steps.push({ startTime: 0, hook: { hookType: 0 } } as never);
  return s;
}

function table(scripts: Record<number, Array<{ mod: number; scriptId: number }>>): PhysicsScriptTable {
  const t = new PhysicsScriptTable();
  for (const [k, v] of Object.entries(scripts)) t.scripts.set(Number(k), v);
  return t;
}

interface Played { script: PhysicsScript; anchor: string }

function sink(opts: {
  objects: Record<number, { peTableId: number; setupId: number }>;
  tables?: Record<number, PhysicsScriptTable>;
  setupTables?: Record<number, number>;
  scripts?: Record<number, PhysicsScript>;
}): { sink: PlayScriptSink<string>; played: Played[]; tableLoads: number[] } {
  const played: Played[] = [];
  const tableLoads: number[] = [];
  return {
    played,
    tableLoads,
    sink: {
      target: (guid) => (opts.objects[guid] ? { ...opts.objects[guid], anchor: `mesh-${guid.toString(16)}` } : null),
      loadTable: (id) => { tableLoads.push(id); return opts.tables?.[id] ?? null; },
      setupScriptTable: (setupId) => opts.setupTables?.[setupId] ?? 0,
      loadScript: (id) => opts.scripts?.[id] ?? null,
      play: (s, anchor) => played.push({ script: s, anchor }),
    },
  };
}

const PLAYER = 0x50000001;
const DRUDGE = 0x80000abc;
const HEALTH_UP_RED = 31; // PlayScript.HealthUpRed — Heal Self's TargetEffect

describe('playScriptType — PlayEffect draws the DAT script or nothing', () => {
  it('a target whose table has no entry for the enum draws NOTHING (no substitute effect)', () => {
    const s = sink({
      objects: { [DRUDGE]: { peTableId: 0x3400001a, setupId: 0 } },
      tables: { 0x3400001a: table({ 0x5b: [{ mod: 1, scriptId: 0x33000100 }] }) },
      scripts: { 0x33000100: script(0x33000100) },
    });
    expect(playScriptType(s.sink, DRUDGE, HEALTH_UP_RED, 1)).toEqual({ played: false, reason: 'no-table-entry' });
    expect(s.played).toEqual([]);
  });

  it('a target with no table at all (no PeTable, Setup without DefaultScriptTable) draws nothing', () => {
    const s = sink({ objects: { [DRUDGE]: { peTableId: 0, setupId: 0x02000123 } } });
    expect(playScriptType(s.sink, DRUDGE, HEALTH_UP_RED, 1)).toEqual({ played: false, reason: 'no-table-entry' });
    expect(s.played).toEqual([]);
  });

  it('an object that is not in the world draws nothing (no player/camera-position substitute)', () => {
    const s = sink({ objects: {} });
    expect(playScriptType(s.sink, PLAYER, HEALTH_UP_RED, 1)).toEqual({ played: false, reason: 'no-object' });
    expect(s.played).toEqual([]);
  });

  it('a table entry whose script DID is missing from the DAT draws nothing', () => {
    const s = sink({
      objects: { [PLAYER]: { peTableId: 0x34000004, setupId: 0 } },
      tables: { 0x34000004: table({ [HEALTH_UP_RED]: [{ mod: 1, scriptId: 0x33000097 }] }) },
    });
    expect(playScriptType(s.sink, PLAYER, HEALTH_UP_RED, 1)).toEqual({ played: false, reason: 'no-script' });
    expect(s.played).toEqual([]);
  });

  it('with an entry, the intensity picks the script and it plays on the target anchor', () => {
    const lo = script(0x33000095);
    const hi = script(0x33000097);
    const s = sink({
      objects: { [PLAYER]: { peTableId: 0x34000004, setupId: 0 } },
      tables: { 0x34000004: table({ [HEALTH_UP_RED]: [{ mod: 0.3, scriptId: 0x33000095 }, { mod: 1, scriptId: 0x33000097 }] }) },
      scripts: { 0x33000095: lo, 0x33000097: hi },
    });
    expect(playScriptType(s.sink, PLAYER, HEALTH_UP_RED, 0.2)).toEqual({ played: true, scriptId: 0x33000095, tableId: 0x34000004 });
    expect(playScriptType(s.sink, PLAYER, HEALTH_UP_RED, 1)).toEqual({ played: true, scriptId: 0x33000097, tableId: 0x34000004 });
    expect(s.played).toEqual([{ script: lo, anchor: 'mesh-50000001' }, { script: hi, anchor: 'mesh-50000001' }]);
  });

  it('falls back to the Setup DefaultScriptTable when the object has no PeTable', () => {
    const sc = script(0x33000200);
    const s = sink({
      objects: { [DRUDGE]: { peTableId: 0, setupId: 0x02000099 } },
      setupTables: { 0x02000099: 0x34000077 },
      tables: { 0x34000077: table({ 5: [{ mod: 1, scriptId: 0x33000200 }] }) },
      scripts: { 0x33000200: sc },
    });
    expect(playScriptType(s.sink, DRUDGE, 5, 1).played).toBe(true);
    expect(s.played).toEqual([{ script: sc, anchor: 'mesh-80000abc' }]);
  });
});

describe('playScriptDid — PlayScriptId plays its DID directly', () => {
  it('plays the DID on the object without consulting any table', () => {
    const sc = script(0x33000046);
    const s = sink({ objects: { [DRUDGE]: { peTableId: 0x3400001a, setupId: 0 } }, scripts: { 0x33000046: sc } });
    expect(playScriptDid(s.sink, DRUDGE, 0x33000046)).toEqual({ played: true, scriptId: 0x33000046 });
    expect(s.played).toEqual([{ script: sc, anchor: 'mesh-80000abc' }]);
    expect(s.tableLoads).toEqual([]);
  });

  it('an unknown DID or DID 0 draws nothing', () => {
    const s = sink({ objects: { [DRUDGE]: { peTableId: 0, setupId: 0 } } });
    expect(playScriptDid(s.sink, DRUDGE, 0x33ffffff)).toEqual({ played: false, reason: 'no-script' });
    expect(playScriptDid(s.sink, DRUDGE, 0)).toEqual({ played: false, reason: 'no-script' });
    expect(s.played).toEqual([]);
  });
});

describe.skipIf(!existsSync(PORTAL))('Heal Self VI against the EoL portal.dat (BUG.heal-self-playscript-missing)', () => {
  let db: DatDatabase;
  beforeAll(() => {
    db = openDat(PORTAL);
  });

  it("the player's table 0x34000004 plays HealthUpRed as the DAT script 0x33000097 at ACE's scale 1", () => {
    const played: PhysicsScript[] = [];
    const realSink: PlayScriptSink<string> = {
      target: () => ({ anchor: 'player', peTableId: 0x34000004, setupId: 0x02000001 }),
      loadTable: (id) => { const d = db.getFileData(id); return d ? PhysicsScriptTable.read(new DatReader(d)) : null; },
      setupScriptTable: () => 0,
      loadScript: (id) => { const d = db.getFileData(id); return d ? PhysicsScript.read(new DatReader(d)) : null; },
      play: (sc) => played.push(sc),
    };
    // Live (fxprobe1, 2026-09-28): PlayEffect guid=self effectId=0x1f scale=1
    // → "PScript 0x1f → DAT script 0x33000097 via table 0x34000004".
    expect(playScriptType(realSink, PLAYER, HEALTH_UP_RED, 1)).toEqual({ played: true, scriptId: 0x33000097, tableId: 0x34000004 });
    expect(played).toHaveLength(1);
    expect(played[0].steps.length).toBeGreaterThan(0);
  });
});
