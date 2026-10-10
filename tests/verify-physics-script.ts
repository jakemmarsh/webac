/**
 * FAITHFUL.175 — PhysicsScript (0x33) + PhysicsScriptTable (0x34) parsers.
 *
 * PhysicsScripts are time-ordered AnimationHook sequences used throughout AC
 * for spell visual effects, item glows, container open animations, portal
 * cinematic flashes, death decay, and ambient creature emotes. The
 * PhysicsScriptTable adds a weighted-random indirection so a single trigger
 * key (e.g. "ambient script for a wisp") can resolve to one of several
 * PhysicsScript files.
 *
 * Pins:
 *   1) PhysicsScript binary layout: id + uint32 count + N × (double startTime + AnimationHook).
 *   2) PhysicsScriptTable binary layout: id + uint16 total + uint16 bucket + N × (uint32 key + uint32 count + count × (float mod + uint32 scriptId)).
 *   3) AnimationHook sub-records reuse the existing parser (Sound hook smoke-tested).
 *   4) Module exports.
 *
 * Reference: ACE.DatLoader/FileTypes/PhysicsScript.cs
 *            ACE.DatLoader/FileTypes/PhysicsScriptTable.cs
 *            ACE.DatLoader/Entity/PhysicsScriptData.cs
 *            ACE.DatLoader/Entity/PhysicsScriptTableData.cs
 *            ACE.DatLoader/Entity/ScriptAndModData.cs
 */
import { describe, it, expect } from 'vitest';
import { PhysicsScript, PhysicsScriptTable, AnimationHookType } from '@ac/dat-parser';
import { DatReader } from '@ac/dat-parser/DatReader.js';

/**
 * Builds a minimal PhysicsScript buffer with one Sound-hook step. The
 * AnimationHook layout for type=1 (Sound) is: uint32 hookType + uint32
 * direction + uint32 soundId.
 */
function buildPhysicsScriptDat(id: number, steps: Array<{ t: number; soundId: number }>): ArrayBuffer {
  // Per step: 8 bytes double + 4 hookType + 4 direction + 4 soundId = 20 bytes
  const buf = new ArrayBuffer(8 + steps.length * 20);
  const view = new DataView(buf);
  let off = 0;
  view.setUint32(off, id, true); off += 4;
  view.setUint32(off, steps.length, true); off += 4;
  for (const step of steps) {
    view.setFloat64(off, step.t, true); off += 8;
    view.setUint32(off, AnimationHookType.Sound, true); off += 4;
    view.setUint32(off, 0, true); off += 4; // direction
    view.setUint32(off, step.soundId, true); off += 4;
  }
  return buf;
}

describe('PhysicsScript — binary parser', () => {
  it('decodes id + 0 steps', () => {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setUint32(0, 0x33000042, true);
    new DataView(buf).setUint32(4, 0, true);
    const s = PhysicsScript.read(new DatReader(buf));
    expect(s.id).toBe(0x33000042);
    expect(s.steps.length).toBe(0);
  });

  it('decodes a single Sound-hook step with the correct startTime', () => {
    const buf = buildPhysicsScriptDat(0x33000042, [{ t: 0.5, soundId: 0x20000001 }]);
    const s = PhysicsScript.read(new DatReader(buf));
    expect(s.id).toBe(0x33000042);
    expect(s.steps.length).toBe(1);
    expect(s.steps[0].startTime).toBeCloseTo(0.5);
    expect(s.steps[0].hook).not.toBeNull();
    expect(s.steps[0].hook!.hookType).toBe(AnimationHookType.Sound);
  });

  it('decodes multiple steps with monotonically increasing times', () => {
    const buf = buildPhysicsScriptDat(0x33000099, [
      { t: 0.0, soundId: 0x20000001 },
      { t: 0.25, soundId: 0x20000002 },
      { t: 0.5, soundId: 0x20000003 },
    ]);
    const s = PhysicsScript.read(new DatReader(buf));
    expect(s.steps.map(x => x.startTime)).toEqual([0.0, 0.25, 0.5]);
  });
});

describe('PhysicsScriptTable — binary parser', () => {
  /**
   * Build a minimal PhysicsScriptTable: id + uint16 total + uint16 bucket +
   * for each entry: uint32 key + uint32 count + count×(float mod + uint32 scriptId).
   */
  function buildTableDat(
    id: number,
    entries: Array<{ key: number; scripts: Array<{ mod: number; scriptId: number }> }>,
  ): ArrayBuffer {
    const totalEntryBytes = entries.reduce((acc, e) => acc + 4 + 4 + e.scripts.length * 8, 0);
    const buf = new ArrayBuffer(4 + 2 + 2 + totalEntryBytes);
    const view = new DataView(buf);
    let off = 0;
    view.setUint32(off, id, true); off += 4;
    view.setUint16(off, entries.length, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    for (const e of entries) {
      view.setUint32(off, e.key, true); off += 4;
      view.setUint32(off, e.scripts.length, true); off += 4;
      for (const s of e.scripts) {
        view.setFloat32(off, s.mod, true); off += 4;
        view.setUint32(off, s.scriptId, true); off += 4;
      }
    }
    return buf;
  }

  it('decodes an empty table', () => {
    const buf = buildTableDat(0x34000000, []);
    const t = PhysicsScriptTable.read(new DatReader(buf));
    expect(t.id).toBe(0x34000000);
    expect(t.scripts.size).toBe(0);
  });

  it('decodes a single trigger key with one script entry', () => {
    const buf = buildTableDat(0x34000000, [
      { key: 0x1001, scripts: [{ mod: 1.0, scriptId: 0x33000042 }] },
    ]);
    const t = PhysicsScriptTable.read(new DatReader(buf));
    expect(t.scripts.size).toBe(1);
    expect(t.scripts.get(0x1001)).toEqual([{ mod: 1.0, scriptId: 0x33000042 }]);
  });

  it('decodes a single trigger with multiple weighted scripts', () => {
    const buf = buildTableDat(0x34000000, [
      {
        key: 0x2002,
        scripts: [
          { mod: 0.5, scriptId: 0x33000001 },
          { mod: 0.3, scriptId: 0x33000002 },
          { mod: 0.2, scriptId: 0x33000003 },
        ],
      },
    ]);
    const t = PhysicsScriptTable.read(new DatReader(buf));
    const list = t.scripts.get(0x2002);
    expect(list).toHaveLength(3);
    expect(list![0].mod).toBeCloseTo(0.5);
    expect(list![1].mod).toBeCloseTo(0.3);
    expect(list![2].mod).toBeCloseTo(0.2);
    expect(list!.map(e => e.scriptId)).toEqual([0x33000001, 0x33000002, 0x33000003]);
  });

  it('decodes multiple trigger keys', () => {
    const buf = buildTableDat(0x34000000, [
      { key: 0x1001, scripts: [{ mod: 1.0, scriptId: 0x33000010 }] },
      { key: 0x1002, scripts: [{ mod: 1.0, scriptId: 0x33000020 }] },
      { key: 0x1003, scripts: [{ mod: 1.0, scriptId: 0x33000030 }] },
    ]);
    const t = PhysicsScriptTable.read(new DatReader(buf));
    expect(t.scripts.size).toBe(3);
    expect(t.scripts.get(0x1001)![0].scriptId).toBe(0x33000010);
    expect(t.scripts.get(0x1002)![0].scriptId).toBe(0x33000020);
    expect(t.scripts.get(0x1003)![0].scriptId).toBe(0x33000030);
  });
});

describe('PhysicsScript / PhysicsScriptTable — module exports', () => {
  it('exposes both classes from @ac/dat-parser', () => {
    expect(typeof PhysicsScript).toBe('function');
    expect(typeof PhysicsScriptTable).toBe('function');
  });
});
