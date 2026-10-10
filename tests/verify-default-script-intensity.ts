/**
 * SWEEP.8 — PhysicsDesc.DefaultScriptIntensity parsed/stored but never used.
 *
 * ACE server: PhysicsDesc.DefaultScript is a `PlayScript` enum (not a raw
 * PhysicsScript DID) and PhysicsObj.play_default_script() resolves it via
 * `PhysicsScriptTable.GetScript(DefaultScript, DefaultScriptIntensity)`
 * (reference/ACE/Source/ACE.Server/Physics/PhysicsObj.cs:3058). ACE's own
 * PhysicsScriptTable.GetScript is a stub (`return 0`) — the real selection
 * algorithm was never reimplemented server-side, so it had to come from the
 * decompiled retail client.
 *
 * PhysicsScriptTableData::GetScript (reference/client-eol decompiled,
 * @ 00521a20) walks a trigger key's ScriptAndModData array in stored order
 * and returns the first entry whose `mod` threshold is >= the requested
 * intensity (Ghidra reconstructs the float compare as `(a<b) != (a==b)`,
 * which collapses to `a<=b` since the two conditions are mutually
 * exclusive). This is a deterministic threshold walk, NOT the
 * random-probability/weight interpretation the codebase previously
 * (unverified) assumed.
 *
 * Pre-fix, packages/renderer/src/main.ts's onObjectCreated handler took the
 * wire's DefaultScript override (obj.defaultScriptOverride) and passed it
 * straight into loadPhysicsScript() as though it were a raw 0x33xxxxxx
 * PhysicsScript DID — real PlayScript enum values (0x04, 0x05, ...) never
 * match a real portal.dat file ID at that address, so the override silently
 * no-opped and DefaultScriptIntensity was dead data alongside it.
 *
 * This suite drives the real, exported `selectPhysicsScriptByIntensity`
 * (the extracted, testable core of the fix) with concrete threshold
 * scenarios, plus citations of the ACE C# call convention it replicates.
 * The main.ts wiring (onObjectCreated / playScriptType routing through
 * this function) is covered separately in
 * tests/verify-default-script-override.ts, which already carries the
 * source-grep-baseline exemption for reading that monolith — see CLAUDE.md
 * "Never Break Tests" on why NEW test files must not fs-read packages/*.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectPhysicsScriptByIntensity, type PhysicsScriptModEntry } from '@ac/dat-parser';

const REPO = resolve(__dirname, '..');

describe('selectPhysicsScriptByIntensity — retail threshold-walk algorithm', () => {
  it('returns 0 for undefined entries (no table match)', () => {
    expect(selectPhysicsScriptByIntensity(undefined, 1.0)).toBe(0);
  });

  it('returns 0 for an empty entry list', () => {
    expect(selectPhysicsScriptByIntensity([], 1.0)).toBe(0);
  });

  it('single-entry table: intensity exactly at mod threshold selects it (inclusive <=)', () => {
    const entries: PhysicsScriptModEntry[] = [{ mod: 1.0, scriptId: 0x33000042 }];
    expect(selectPhysicsScriptByIntensity(entries, 1.0)).toBe(0x33000042);
  });

  it('single-entry table: intensity below mod threshold still selects it', () => {
    const entries: PhysicsScriptModEntry[] = [{ mod: 1.0, scriptId: 0x33000042 }];
    expect(selectPhysicsScriptByIntensity(entries, 0.1)).toBe(0x33000042);
  });

  it('single-entry table: intensity above mod threshold selects nothing', () => {
    const entries: PhysicsScriptModEntry[] = [{ mod: 1.0, scriptId: 0x33000042 }];
    expect(selectPhysicsScriptByIntensity(entries, 1.5)).toBe(0);
  });

  it('multi-entry table: picks the first qualifying (lowest-threshold) entry in array order', () => {
    const entries: PhysicsScriptModEntry[] = [
      { mod: 0.33, scriptId: 0x33000001 }, // small
      { mod: 0.66, scriptId: 0x33000002 }, // medium
      { mod: 1.0, scriptId: 0x33000003 },  // large
    ];
    expect(selectPhysicsScriptByIntensity(entries, 0.0)).toBe(0x33000001);
    expect(selectPhysicsScriptByIntensity(entries, 0.33)).toBe(0x33000001);
    expect(selectPhysicsScriptByIntensity(entries, 0.5)).toBe(0x33000002);
    expect(selectPhysicsScriptByIntensity(entries, 0.66)).toBe(0x33000002);
    expect(selectPhysicsScriptByIntensity(entries, 0.9)).toBe(0x33000003);
    expect(selectPhysicsScriptByIntensity(entries, 1.0)).toBe(0x33000003);
  });

  it('multi-entry table: intensity exceeding every threshold selects nothing (matches retail INVALID_DID fallthrough)', () => {
    const entries: PhysicsScriptModEntry[] = [
      { mod: 0.33, scriptId: 0x33000001 },
      { mod: 0.66, scriptId: 0x33000002 },
    ];
    expect(selectPhysicsScriptByIntensity(entries, 2.0)).toBe(0);
  });

  it('out-of-order thresholds are walked in stored array order, not sorted', () => {
    // Retail's decompiled walk has no sort step — it trusts DAT authoring
    // order. A table authored high-to-low would return the first (highest)
    // qualifying entry, not the smallest.
    const entries: PhysicsScriptModEntry[] = [
      { mod: 1.0, scriptId: 0x33000003 },
      { mod: 0.5, scriptId: 0x33000002 },
    ];
    expect(selectPhysicsScriptByIntensity(entries, 0.2)).toBe(0x33000003);
  });
});

describe('ACE C# call convention this algorithm replicates', () => {
  const PHYSICS_OBJ_CS = readFileSync(
    resolve(REPO, 'reference/ACE/Source/ACE.Server/Physics/PhysicsObj.cs'),
    'utf8',
  );
  const PHYSICS_DESC_CS = readFileSync(
    resolve(REPO, 'reference/ACE/Source/ACE.Server/Physics/PhysicsDesc.cs'),
    'utf8',
  );

  it('ACE PhysicsDesc.DefaultScript is a PlayScript enum, not a raw script DID', () => {
    expect(PHYSICS_DESC_CS).toMatch(/public PlayScript DefaultScript;/);
    expect(PHYSICS_DESC_CS).toMatch(/public float DefaultScriptIntensity;/);
  });

  it('ACE resolves DefaultScript through PhysicsScriptTable.GetScript with DefaultScriptIntensity', () => {
    expect(PHYSICS_OBJ_CS).toMatch(
      /PhysicsScriptTable\.GetScript\(DefaultScript, DefaultScriptIntensity\)/,
    );
  });
});
