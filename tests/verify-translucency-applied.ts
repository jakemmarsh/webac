/**
 * FAITHFUL.375 — PhysicsDesc.Translucency + PropertyFloat.Translucency
 *  (76) actually fade meshes.
 *
 * Pre-fix parseCreateObject read the float from
 * PhysicsDescFlag.Translucency (0x200) and discarded it; ghost
 * creatures / fading lifestones / dispelled summons all rendered fully
 * opaque. PublicUpdatePropertyFloat broadcasts for
 * PropertyFloat.Translucency = 76 were console-only.
 *
 * Now:
 *  - CreateObjectData carries translucency: number (default 0).
 *  - ServerObjectManager exports applyTranslucency(root, t) — walks
 *    every Mesh child and sets material.opacity = 1 - t plus
 *    transparent=true when t > 0.
 *  - createObject applies on initial spawn.
 *  - PublicUpdatePropertyFloat key=76 mutates live.
 *
 * ACE refs:
 *   reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyFloat.cs:91
 *     → Translucency = 76
 *   PhysicsDesc serialization flag bit 0x200 (Translucency).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { ServerObjectManager, applyTranslucency } from '../packages/renderer/src/world/ServerObjectManager.js';

const REPO = resolve(__dirname, '..');
const SERIALIZER = readFileSync(resolve(REPO, 'packages/network/src/MessageSerializer.ts'), 'utf8');

describe('CreateObjectData carries translucency (FAITHFUL.375)', () => {
  it('interface declares translucency: number', () => {
    expect(SERIALIZER).toMatch(/translucency:\s*number;/);
  });

  it('parseCreateObject captures Translucency into a local (defaults 0.0)', () => {
    // parseCreateObject(payload) delegates its field-parsing body to
    // parseCreateObjectFromReader(r) (extracted for FAITHFUL.166's
    // behavioral align test — see verify-create-object-final-align.ts).
    const fn = SERIALIZER.match(/export function parseCreateObjectFromReader\([\s\S]+?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/let translucency = 0\.0;/);
    expect(fn).toMatch(/if \(physFlags & PhysicsDescFlag\.Translucency\) translucency = r\.readFloat32\(\);/);
  });

  it('parseCreateObject returns translucency in the result object', () => {
    const fn = SERIALIZER.match(/export function parseCreateObjectFromReader\([\s\S]+?\n\}/)?.[0] ?? '';
    // Tolerate sibling fields appended after (FAITHFUL.376 added defaultScript[Intensity]).
    expect(fn).toMatch(/return\s*\{[\s\S]+?\btranslucency,[\s\S]+?\};/);
  });
});

describe('applyTranslucency runtime helper (FAITHFUL.375)', () => {
  function makeTree(opacityCheck: (m: THREE.MeshBasicMaterial) => void): THREE.Object3D {
    const root = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    root.add(mesh);
    // Run after applyTranslucency mutates.
    queueMicrotask(() => opacityCheck(mat));
    return root;
  }

  it('opacity = 1 - translucency, clamped to [0, 1]', () => {
    const root = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
    applyTranslucency(root, 0.4);
    expect(mat.opacity).toBeCloseTo(0.6);
    expect(mat.transparent).toBe(true);
  });

  it('translucency 0 → opacity 1 + transparent=false', () => {
    const root = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
    applyTranslucency(root, 0);
    expect(mat.opacity).toBe(1);
    expect(mat.transparent).toBe(false);
  });

  it('translucency 1.0 → the part is not drawn (CPhysicsPart::SetTranslucency @ 0050e670 no-draw bit)', () => {
    const root = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    root.add(mesh);
    applyTranslucency(root, 1);
    // SWEEP1006 part no-draw — the mesh, not the (possibly shared) material.
    expect(mesh.visible).toBe(false);
    expect(mat.visible).toBe(true);
  });

  it('handles material arrays (multi-material meshes)', () => {
    const root = new THREE.Group();
    const a = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const b = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [a, b]));
    applyTranslucency(root, 0.25);
    expect(a.opacity).toBeCloseTo(0.75);
    expect(b.opacity).toBeCloseTo(0.75);
  });

  it('clamps out-of-range translucency (no NaN / negative opacity)', () => {
    const root = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    root.add(mesh);
    applyTranslucency(root, 1.5);
    expect(mesh.visible).toBe(false);
    applyTranslucency(root, -0.5);
    expect(mesh.visible).toBe(true);
    expect(mat.opacity).toBe(1);
  });
});

describe('PublicUpdatePropertyFloat Translucency=76 → ServerObjectManager.setServerTranslucency (FAITHFUL.375)', () => {
  // main.ts routes key 76 here. Behavioral (was a main.ts source-text pin).
  function som() {
    const smr = { createSetupMeshWithOverrides: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff0000 })));
      return g;
    }, loadSetupModel: () => null };
    const m = new ServerObjectManager(smr as never, { loadPaletteColors: () => null } as never, new THREE.Scene());
    m.createObject({
      guid: 0x80000076, name: 'Ghost', weenieClassId: 1, itemType: 0x10,
      position: { landblock: 0xA9B40102, x: 10, y: 20, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 },
      setupId: 0x02000123, motionTableId: 0, iconId: 0, physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
      basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0, wielderId: 0,
      currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0,
      uiEffects: 0, usable: 0, useRadius: 0.6, velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: 0, objScale: 1,
      translucency: 0, defaultScript: 0, defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0, cooldownId: 0, cooldownDuration: 0,
    } as never);
    return m;
  }
  const opacity = (m: ServerObjectManager) =>
    ((m.getObject(0x80000076)!.mesh!.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity;

  it('fades the object\'s mesh live', () => {
    const m = som();
    m.setServerTranslucency(0x80000076, 0.4);
    expect(opacity(m)).toBeCloseTo(0.6);
  });

  it('ignores NaN and out-of-range values', () => {
    const m = som();
    m.setServerTranslucency(0x80000076, 0.4);
    for (const bad of [Number.NaN, -0.1, 1.5]) m.setServerTranslucency(0x80000076, bad);
    expect(opacity(m)).toBeCloseTo(0.6);
    expect(m.getObject(0x80000076)!.translucency).toBeCloseTo(0.4);
  });
});
