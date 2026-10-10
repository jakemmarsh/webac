/**
 * FAITHFUL.376 — PhysicsDesc.DefaultScript + DefaultScriptIntensity
 *  actually override the SetupModel's defaultScript.
 *
 * Pre-fix parseCreateObject read both the PhysicsScript ID
 * (PhysicsDescFlag.DefaultScript = 0x002000) and intensity float
 * (PhysicsDescFlag.DefaultScriptIntensity = 0x004000) and discarded
 * them — every spawned object ran setup.defaultScript even when ACE
 * sent a per-instance override (admin-spawned glow, custom particle).
 *
 * Now:
 *  - CreateObjectData carries defaultScript: number + defaultScriptIntensity: number.
 *  - ServerObject carries defaultScriptOverride + defaultScriptIntensity.
 *  - main.ts's serverObjectManager.onObjectCreated prefers the wire
 *    override (when non-zero) over the setup's defaultScript.
 *
 * SWEEP.8 correction (2026-07-28): the "override" framing above was itself
 * wrong. PhysicsDesc.DefaultScript is a PlayScript enum key (ACE
 * PhysicsDesc.cs:31 `PlayScript DefaultScript`), not a raw PhysicsScript
 * DID — treating it as one meant obj.defaultScriptOverride never resolved
 * to a real 0x33xxxxxx file, silently no-opping, and DefaultScriptIntensity
 * went unused entirely. It must resolve through the object's own
 * PhysicsScriptTable via an intensity-threshold walk, exactly like ACE
 * PhysicsObj.cs:3058's `PhysicsScriptTable.GetScript(DefaultScript,
 * DefaultScriptIntensity)` (a stub server-side; the real algorithm comes
 * from the decompiled retail client — see selectPhysicsScriptByIntensity in
 * packages/dat-parser/src/file-types/PhysicsScript.ts and
 * tests/verify-default-script-intensity.ts for the behavioral coverage).
 *
 * CONVERTED (source-pin census, 2026-08-13) from a source-text pin
 * (readFileSync + regex against MessageSerializer.ts / ServerObjectManager.ts
 * source, never executing either module — CLAUDE.md's "Never Break Tests")
 * to a behavioral test, following the FAITHFUL.574 /
 * verify-trade-burden-value-propagation.ts conversion shape:
 *  1. Drive the real `parseCreateObject` (from `@ac/network`) with a
 *     hand-built binary CreateObject payload that sets/clears the
 *     DefaultScript (0x002000) and DefaultScriptIntensity (0x004000)
 *     PhysicsDescFlag bits, and assert on the *parsed* defaultScript /
 *     defaultScriptIntensity fields.
 *  2. Drive the real `ServerObjectManager.createObject()` with that parsed
 *     (or hand-built) CreateObjectData and assert the returned ServerObject
 *     actually carries `defaultScriptOverride` / `defaultScriptIntensity`.
 *
 * The table resolution (creation script, the missile-contact default
 * script, the PlayEffect dispatch playScriptType) is driven through the shipped seam
 * effects/PlayScriptResolve.ts below — BUG.spell-projectile-physics
 * converted the last main.ts source pins.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { parseCreateObject } from '@ac/network';
import type { CreateObjectData } from '@ac/network';
import { resolvePlayScript, creationScriptId, physicsDescDefaultScriptId } from '../packages/renderer/src/effects/PlayScriptResolve.js';


/* ================================================================ */
/*  Synthetic CreateObject payload builder                          */
/*  Mirrors the exact read order of parseCreateObject               */
/*  (packages/network/src/MessageSerializer.ts): model header (no    */
/*  sub-blocks), physics header with only the DefaultScript (0x2000) */
/*  and/or DefaultScriptIntensity (0x4000) bits optionally set, 9    */
/*  zeroed sequence u16s, then a zero-flags weenie header (no        */
/*  optional weenie fields, empty name) so every downstream          */
/*  conditional read is skipped and the payload ends deterministically. */
/*  Same shape as tests/verify-faithful-574-create-object-parent-location.ts. */
/* ================================================================ */

function u32(n: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return Array.from(b);
}
function u16(n: number): number[] {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return Array.from(b);
}
function f32(n: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, n, true);
  return Array.from(b);
}

function buildCreateObjectPayload(opts: {
  guid: number;
  hasDefaultScript?: boolean;
  defaultScript?: number;
  hasDefaultScriptIntensity?: boolean;
  defaultScriptIntensity?: number;
}): Uint8Array {
  const DEFAULT_SCRIPT_BIT = 0x002000; // PhysicsDescFlag.DefaultScript
  const DEFAULT_SCRIPT_INTENSITY_BIT = 0x004000; // PhysicsDescFlag.DefaultScriptIntensity
  let physFlags = 0;
  if (opts.hasDefaultScript) physFlags |= DEFAULT_SCRIPT_BIT;
  if (opts.hasDefaultScriptIntensity) physFlags |= DEFAULT_SCRIPT_INTENSITY_BIT;

  const bytes: number[] = [
    ...u32(opts.guid),
    0x11, 0, 0, 0, // modelByte=0x11, numSubPalettes/numTexChanges/numAnimParts=0
    ...u32(physFlags),
    ...u32(0), // physicsState
  ];
  if (opts.hasDefaultScript) {
    bytes.push(...u32(opts.defaultScript ?? 0));
  }
  if (opts.hasDefaultScriptIntensity) {
    bytes.push(...f32(opts.defaultScriptIntensity ?? 0));
  }
  bytes.push(...Array(18).fill(0)); // 9x u16 sequence timestamps
  bytes.push(0, 0); // align(4) pad
  bytes.push(...u32(0)); // weenieFlags = 0 (no optional weenie fields)
  bytes.push(...u16(0)); // name length = 0
  bytes.push(0, 0); // readString16 pad (2 + 0 = 2, pad to 4)
  bytes.push(...u16(1)); // weenieClassId (packed dword, <= 0x7FFF => 2 bytes)
  bytes.push(...u16(2)); // iconId (packed dword, <= 0x7FFF => 2 bytes)
  bytes.push(...u32(0)); // itemType
  bytes.push(...u32(0)); // objectDescFlags = 0 (no second header, no house restrictions)
  return new Uint8Array(bytes);
}

describe('FAITHFUL.376 — parseCreateObject captures defaultScript/defaultScriptIntensity from the wire', () => {
  it('neither bit set: defaultScript defaults to 0, defaultScriptIntensity defaults to 0.0 (CPhysicsDesc::UnPack :277285)', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({ guid: 0x50001001 }));
    expect(obj).not.toBeNull();
    expect(obj!.defaultScript).toBe(0);
    expect(obj!.defaultScriptIntensity).toBe(0);
  });

  it('DefaultScript bit set: returns the real wire PlayScript key', () => {
    const obj = parseCreateObject(
      buildCreateObjectPayload({ guid: 0x50001002, hasDefaultScript: true, defaultScript: 42 }),
    );
    expect(obj!.defaultScript).toBe(42);
    // Intensity bit not set alongside it — stays at its own default.
    expect(obj!.defaultScriptIntensity).toBe(0);
  });

  it('DefaultScriptIntensity bit set: returns the real wire float', () => {
    const obj = parseCreateObject(
      buildCreateObjectPayload({ guid: 0x50001003, hasDefaultScriptIntensity: true, defaultScriptIntensity: 0.75 }),
    );
    expect(obj!.defaultScript).toBe(0);
    expect(obj!.defaultScriptIntensity).toBeCloseTo(0.75);
  });

  it('both bits set together: the two fields round-trip independently (not aliased to each other)', () => {
    const obj = parseCreateObject(
      buildCreateObjectPayload({
        guid: 0x50001004,
        hasDefaultScript: true,
        defaultScript: 7,
        hasDefaultScriptIntensity: true,
        defaultScriptIntensity: 2.5,
      }),
    );
    expect(obj!.defaultScript).toBe(7);
    expect(obj!.defaultScriptIntensity).toBeCloseTo(2.5);
  });

  it('a different guid + values still parses correctly (not hardcoded to one fixture)', () => {
    const obj = parseCreateObject(
      buildCreateObjectPayload({
        guid: 0x5000abcd,
        hasDefaultScript: true,
        defaultScript: 0x99,
        hasDefaultScriptIntensity: true,
        defaultScriptIntensity: 0.1,
      }),
    );
    expect(obj!.guid).toBe(0x5000abcd);
    expect(obj!.defaultScript).toBe(0x99);
    expect(obj!.defaultScriptIntensity).toBeCloseTo(0.1);
  });
});

describe('FAITHFUL.376 — ServerObjectManager.createObject() propagates the override onto the ServerObject', () => {
  function baseCreateObjectData(overrides: Partial<CreateObjectData> = {}): CreateObjectData {
    return {
      guid: 0x80005555,
      name: 'Test Object',
      weenieClassId: 300,
      itemType: 0,
      position: null,
      setupId: 0,
      peTableId: 0,
      motionTableId: 0,
      iconId: 0x06000001,
      physicsState: 0,
      objectDescFlags: 0,
      radarColor: 0,
      radarBehavior: 0,
      basePalette: 0,
      subPalettes: [],
      textureChanges: [],
      animPartChanges: [],
      containerId: 0,
      wielderId: 0,
      currentWieldedLocation: 0,
      parentLocation: 0,
      validLocations: 0,
      stackSize: 0,
      maxStackSize: 0,
      value: 0,
      burden: 0,
      uiEffects: 0,
      usable: 0,
      useRadius: 0.6,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      soundTableId: 0,
      objScale: 1.0,
      translucency: 0,
      defaultScript: 0,
      defaultScriptIntensity: 1.0,
      iconOverlayId: 0,
      iconUnderlayId: 0,
      cooldownId: 0,
      cooldownDuration: 0,
      ...overrides,
    };
  }

  async function makeSOM() {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    const scene = { add: () => {}, remove: () => {} };
    const setupModelRenderer = {
      createSetupMeshWithOverrides: () => new THREE.Group(),
      loadSetupModel: () => null,
    };
    const appearanceManager = { loadPaletteColors: () => null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager(setupModelRenderer as any, appearanceManager as any, scene as any);
    return som;
  }

  it('a real CreateObject wire-decoded payload lands defaultScript/Intensity as defaultScriptOverride/defaultScriptIntensity', async () => {
    const som = await makeSOM();
    const wire = parseCreateObject(
      buildCreateObjectPayload({
        guid: 0x80006001,
        hasDefaultScript: true,
        defaultScript: 13,
        hasDefaultScriptIntensity: true,
        defaultScriptIntensity: 0.5,
      }),
    );
    expect(wire).not.toBeNull();
    const obj = som.createObject(wire!);
    expect(obj).not.toBeNull();
    expect(obj!.defaultScriptOverride).toBe(13);
    expect(obj!.defaultScriptIntensity).toBeCloseTo(0.5);
  });

  it('defaultScript=0 on the wire yields defaultScriptOverride=0 (no override — falls back to setup.defaultScript downstream)', async () => {
    const som = await makeSOM();
    const data = baseCreateObjectData({ guid: 0x80006002, defaultScript: 0 });
    const obj = som.createObject(data);
    expect(obj!.defaultScriptOverride).toBe(0);
  });

  it('missing defaultScriptIntensity on the data defaults to 0.0 (CPhysicsObj ctor), not undefined/NaN', async () => {
    const som = await makeSOM();
    const data = baseCreateObjectData({ guid: 0x80006003 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (data as any).defaultScriptIntensity;
    const obj = som.createObject(data);
    expect(obj!.defaultScriptIntensity).toBe(0);
  });
});

/*
 * BUG.spell-projectile-physics (2026-09-28) — converted from source pins of
 * main.ts's onObjectCreated to the shipped seam (effects/PlayScriptResolve.ts),
 * and CORRECTED: retail never plays the PhysicsDesc DefaultScript when an
 * object appears. CPhysicsObj::set_description (decomp :267624) only stores
 * default_script + intensity; CPhysicsObj::play_default_script's callers are
 * the DefaultScript[Part]Hook animation hooks and ACCWeenieObject::DoCollision
 * (a ScriptedCollision missile's contact). Creation plays the Setup's
 * DefaultScript only — playing the override there fired every spell
 * projectile's ProjectileCollision burst at the caster on launch.
 */
describe('FAITHFUL.376 / SWEEP.8 — the PhysicsDesc DefaultScript resolves through the object\'s PhysicsScriptTable by intensity', () => {
  const entries = [{ mod: 0.5, scriptId: 0x33000011 }, { mod: 1, scriptId: 0x33000012 }];
  const tables: Record<number, unknown> = {
    0x34000005: { scripts: new Map([[0x0a, entries]]) },
    0x34000009: { scripts: new Map([[0x0a, [{ mod: 1, scriptId: 0x33000099 }]]]) },
  };
  const loadTable = (id: number) => (tables[id] ?? null) as never;
  const setupTable = (setupId: number) => (setupId === 0x0200040d ? 0x34000009 : 0);

  it('uses the object\'s own PeTable, selecting by DefaultScriptIntensity', () => {
    const obj = { peTableId: 0x34000005, setupId: 0x0200040d, defaultScriptOverride: 0x0a };
    expect(physicsDescDefaultScriptId({ ...obj, defaultScriptIntensity: 0.4 }, loadTable, setupTable)).toBe(0x33000011);
    expect(physicsDescDefaultScriptId({ ...obj, defaultScriptIntensity: 1.0 }, loadTable, setupTable)).toBe(0x33000012);
  });

  it('falls back to the Setup\'s DefaultScriptTable when there is no PeTable', () => {
    expect(physicsDescDefaultScriptId({ peTableId: 0, setupId: 0x0200040d, defaultScriptOverride: 0x0a }, loadTable, setupTable)).toBe(0x33000099);
  });

  it('a missing DefaultScriptIntensity is 0.0 (CPhysicsDesc::UnPack :277285): the lowest threshold wins', () => {
    const obj = { peTableId: 0x34000005, setupId: 0, defaultScriptOverride: 0x0a };
    expect(physicsDescDefaultScriptId(obj, loadTable, setupTable)).toBe(0x33000011);
  });

  it('no override (0) or no table entry → nothing to play', () => {
    expect(physicsDescDefaultScriptId({ peTableId: 0x34000005, setupId: 0, defaultScriptOverride: 0 }, loadTable, setupTable)).toBeUndefined();
    expect(physicsDescDefaultScriptId({ peTableId: 0x34000005, setupId: 0, defaultScriptOverride: 0x0b }, loadTable, setupTable)).toBeUndefined();
  });

  it('creation plays only the Setup DefaultScript (the PhysicsDesc one waits for a hook / collision)', () => {
    expect(creationScriptId(0x33000123)).toBe(0x33000123);
    expect(creationScriptId(0)).toBeUndefined();
    expect(creationScriptId(undefined)).toBeUndefined();
  });
});

describe('playScriptType (GAP.13) resolves through the shared intensity selector (SWEEP.8)', () => {
  // The resolution seam (effects/PlayScriptResolve.ts) — was a source-text pin.
  const table = { scripts: new Map([[0x5b, [{ mod: 0.5, scriptId: 0x33000001 }, { mod: 1, scriptId: 0x33000002 }]]]) };
  const resolve = (intensity: number) =>
    resolvePlayScript({ peTableId: 0x34000001, setupId: 0 }, 0x5b, intensity, () => table as never, () => 0)?.scriptId ?? 0;

  it('picks the first entry whose mod ≥ the intensity, not entries[0]', () => {
    expect(resolve(0.3)).toBe(0x33000001);
    expect(resolve(0.9)).toBe(0x33000002);
  });
});
