/**
 * FAITHFUL.374 — PhysicsDesc.ObjScale + PublicUpdatePropertyFloat
 *  DefaultScale (39) actually resize the rendered mesh.
 *
 * Pre-fix parseCreateObject read the float from PhysicsDescFlag.ObjScale
 * (0x80) and discarded it; every mob/object rendered at scale 1.0
 * regardless of the wire value. PublicUpdatePropertyFloat broadcasts
 * for PropertyFloat.DefaultScale = 39 were console-only, so polymorph /
 * sigil-of-growth / pet maturity visuals didn't take effect until the
 * object left + re-entered visual range.
 *
 * Now:
 *  - CreateObjectData carries objScale: number (defaults 1.0).
 *  - ServerObjectManager.createObject applies mesh.scale.setScalar.
 *  - PublicUpdatePropertyFloat handler with key=39 mutates mesh.scale.
 *
 * ACE refs:
 *   reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyFloat.cs:52
 *     → DefaultScale = 39
 *   reference/ACE/Source/ACE.Server/Network/Structure/PhysicsDesc.cs
 *     → ObjScale flag = 0x80
 *
 * CONVERTED (source-pin census, 2026-08-14) from a source-text pin
 * (readFileSync + regex against MessageSerializer.ts / ServerObjectManager.ts
 * / main.ts source, never executing any of the three modules —
 * CLAUDE.md's "Never Break Tests") to a behavioral test, following the
 * FAITHFUL.376 / verify-default-script-override.ts conversion shape (this
 * was the explicitly flagged "next candidate" hand-off from that cycle's
 * progress.md entry):
 *  1. Drive the real `parseCreateObject` (from `@ac/network`) with a
 *     hand-built binary CreateObject payload that sets/clears the
 *     PhysicsDescFlag.ObjScale (0x80) bit, and assert on the *parsed*
 *     `objScale` field (default 1.0 when absent, real wire float when
 *     present).
 *  2. Drive the real `ServerObjectManager.createObject()` with that
 *     parsed (or hand-built) `CreateObjectData` and assert the returned
 *     `ServerObject.mesh.scale` actually reflects the input — including
 *     the ACE-faithful "objScale===1.0 never calls setScalar" no-op path
 *     (mesh stays at THREE's default (1,1,1), not merely "some scale").
 *
 * The main.ts `onPublicUpdatePropertyFloat` (key===39) wiring forwards to
 * ServerObjectManager.setObjectScale, tested behaviorally below (it also
 * rescales the part-array radius/height, SWEEP1006B).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { parseCreateObject } from '@ac/network';
import type { CreateObjectData } from '@ac/network';


/* ================================================================ */
/*  Synthetic CreateObject payload builder                          */
/*  Mirrors the exact read order of parseCreateObject               */
/*  (packages/network/src/MessageSerializer.ts): model header (no    */
/*  sub-blocks), physics header with only the ObjScale (0x80) bit    */
/*  optionally set, 9 zeroed sequence u16s, then a zero-flags weenie */
/*  header (no optional weenie fields, empty name) so every          */
/*  downstream conditional read is skipped and the payload ends      */
/*  deterministically. Same shape as                                 */
/*  tests/verify-default-script-override.ts (FAITHFUL.376).          */
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
  hasObjScale?: boolean;
  objScale?: number;
}): Uint8Array {
  const OBJ_SCALE_BIT = 0x000080; // PhysicsDescFlag.ObjScale
  let physFlags = 0;
  if (opts.hasObjScale) physFlags |= OBJ_SCALE_BIT;

  const bytes: number[] = [
    ...u32(opts.guid),
    0x11, 0, 0, 0, // modelByte=0x11, numSubPalettes/numTexChanges/numAnimParts=0
    ...u32(physFlags),
    ...u32(0), // physicsState
  ];
  if (opts.hasObjScale) {
    bytes.push(...f32(opts.objScale ?? 1.0));
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

describe('FAITHFUL.374 — parseCreateObject captures objScale from the wire', () => {
  it('ObjScale bit not set: objScale defaults to 1.0', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({ guid: 0x50002001 }));
    expect(obj).not.toBeNull();
    expect(obj!.objScale).toBe(1.0);
  });

  it('ObjScale bit set: returns the real wire float (growth/tier > 1.0)', () => {
    const obj = parseCreateObject(
      buildCreateObjectPayload({ guid: 0x50002002, hasObjScale: true, objScale: 2.5 }),
    );
    expect(obj!.objScale).toBeCloseTo(2.5);
  });

  it('ObjScale bit set: also returns sub-unity values (shrink/miniature effects)', () => {
    const obj = parseCreateObject(
      buildCreateObjectPayload({ guid: 0x50002003, hasObjScale: true, objScale: 0.25 }),
    );
    expect(obj!.objScale).toBeCloseTo(0.25);
  });

  it('ObjScale bit set to exactly 1.0 on the wire still round-trips (not conflated with "absent")', () => {
    const obj = parseCreateObject(
      buildCreateObjectPayload({ guid: 0x50002004, hasObjScale: true, objScale: 1.0 }),
    );
    expect(obj!.objScale).toBe(1.0);
  });

  it('a different guid + value still parses correctly (not hardcoded to one fixture)', () => {
    const obj = parseCreateObject(
      buildCreateObjectPayload({ guid: 0x5000dead, hasObjScale: true, objScale: 4.0 }),
    );
    expect(obj!.guid).toBe(0x5000dead);
    expect(obj!.objScale).toBeCloseTo(4.0);
  });
});

describe('FAITHFUL.374 — ServerObjectManager.createObject() applies objScale onto the rendered mesh', () => {
  function baseCreateObjectData(overrides: Partial<CreateObjectData> = {}): CreateObjectData {
    return {
      guid: 0x80007777,
      name: 'Test Object',
      weenieClassId: 300,
      itemType: 0,
      position: null,
      setupId: 0x02000001,
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

  it('a real CreateObject wire-decoded payload with objScale=2.5 lands on mesh.scale', async () => {
    const som = await makeSOM();
    const wire = parseCreateObject(
      buildCreateObjectPayload({ guid: 0x80008001, hasObjScale: true, objScale: 2.5 }),
    );
    expect(wire).not.toBeNull();
    const data: CreateObjectData = { ...wire!, setupId: 0x02000001 };
    const obj = som.createObject(data);
    expect(obj).not.toBeNull();
    expect(obj!.mesh).not.toBeNull();
    expect(obj!.mesh!.scale.x).toBeCloseTo(2.5);
    expect(obj!.mesh!.scale.y).toBeCloseTo(2.5);
    expect(obj!.mesh!.scale.z).toBeCloseTo(2.5);
  });

  it('objScale=1.0 never calls setScalar — mesh stays at THREE\'s untouched default (1,1,1), not a redundant explicit set', async () => {
    const som = await makeSOM();
    const data = baseCreateObjectData({ guid: 0x80008002, objScale: 1.0 });
    const obj = som.createObject(data);
    expect(obj!.mesh).not.toBeNull();
    expect(obj!.mesh!.scale.x).toBe(1);
    expect(obj!.mesh!.scale.y).toBe(1);
    expect(obj!.mesh!.scale.z).toBe(1);
  });

  it('a sub-unity objScale (miniature/shrink) also applies to the mesh', async () => {
    const som = await makeSOM();
    const data = baseCreateObjectData({ guid: 0x80008003, objScale: 0.25 });
    const obj = som.createObject(data);
    expect(obj!.mesh!.scale.x).toBeCloseTo(0.25);
  });

  it('objScale=0 (falsy) is treated as "no scale override" per the real `data.objScale &&` guard, not a zero-size mesh', async () => {
    const som = await makeSOM();
    const data = baseCreateObjectData({ guid: 0x80008004, objScale: 0 });
    const obj = som.createObject(data);
    // Documents the real guard's actual behavior: `if (data.objScale && data.objScale !== 1.0)`
    // short-circuits on falsy 0, leaving the mesh at THREE's default (1,1,1)
    // rather than scaling it to zero. ACE never sends objScale=0 in practice
    // (ObjScale is a multiplier; 0 would render nothing), so this is a
    // defensive no-op, not a wire-format case — pinned here so a future
    // refactor of the guard can't silently change this edge behavior.
    expect(obj!.mesh!.scale.x).toBe(1);
  });
});

describe('FAITHFUL.374 — a live DefaultScale (key=39) update: ServerObjectManager.setObjectScale', () => {
  // main.ts onPublicUpdatePropertyFloat forwards key 39 here. Behavioral
  // (replaces the old main.ts source-text pin).
  async function makeSOM(setup: unknown = null) {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    const smr = { createSetupMeshWithOverrides: () => new THREE.Group(), loadSetupModel: () => setup };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, { add: () => {}, remove: () => {} } as any);
  }
  const create = (guid: number, over: Partial<CreateObjectData> = {}) => {
    const wire = parseCreateObject(buildCreateObjectPayload({ guid, hasObjScale: false, objScale: 1 }))!;
    return { ...wire, setupId: 0x02000001, ...over } as CreateObjectData;
  };

  it('resizes the mesh', async () => {
    const som = await makeSOM();
    const obj = som.createObject(create(0x80008101))!;
    som.setObjectScale(0x80008101, 1.75);
    expect(obj.mesh!.scale.x).toBeCloseTo(1.75);
    expect(obj.mesh!.scale.z).toBeCloseTo(1.75);
  });

  it('ignores non-positive or NaN values', async () => {
    const som = await makeSOM();
    const obj = som.createObject(create(0x80008102))!;
    som.setObjectScale(0x80008102, 0);
    som.setObjectScale(0x80008102, -1);
    som.setObjectScale(0x80008102, Number.NaN);
    expect(obj.mesh!.scale.x).toBe(1);
  });

  it('rescales the part-array radius/height (CPhysicsObj::SetScaleInternal @ 00511bb0)', async () => {
    const som = await makeSOM({ radius: 0.5, height: 2, cylSpheres: [], spheres: [] });
    const obj = som.createObject(create(0x80008103))!;
    expect(obj.collisionRadius).toBeCloseTo(0.5);
    som.setObjectScale(0x80008103, 3);
    expect(obj.collisionRadius).toBeCloseTo(1.5);
    expect(obj.collisionHeight).toBeCloseTo(6);
  });
});
