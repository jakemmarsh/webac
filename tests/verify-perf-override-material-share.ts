/**
 * PERF.override-material-share (2026-11-16, docs/perf-pass-2026-11-15.md) —
 * MaterialFactory made one fresh material per getMaterial call with a palette
 * / texture override (every creature, NPC and player). Now an object build
 * (SetupModelRenderer opens beginObjectBuild / endObjectBuild) whose whole
 * sequence of override materials repeats an earlier object's draws that
 * object's materials, part for part. One object's parts never share with each
 * other, so three.js (opaque sort: material.id first) keeps drawing an
 * object's parts in build order: sharing one material across a body's parts
 * reordered coplanar layers (5-9 px in a same-frame A/B). Every per-object
 * write copies a shared material first, which is what makes sharing safe.
 * Drives the real MaterialFactory / MaterialOwnership / ObjectTranslucency code.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { MaterialFactory, overrideCacheKey } from '../packages/renderer/src/models/MaterialFactory.js';
import { disposeObjectTree, isSharedMaterial } from '../packages/renderer/src/models/MaterialOwnership.js';
import { setObjectTranslucency } from '../packages/renderer/src/models/ObjectTranslucency.js';
import { Surface } from '@ac/dat-parser/file-types/Surface.js';

const SURFACE = 0x08000123;

/** A factory whose one surface is a plain coloured (untextured) Base1Solid surface. */
function factory(): MaterialFactory {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mf = new MaterialFactory({ getFileData: () => null } as any, {} as any);
  const surface = Object.assign(Object.create(Surface.prototype), { type: 0x1, colorValue: 0xff808080, translucency: 0, luminosity: 0, diffuse: 1, origTextureId: 0, origPaletteId: 0 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mf as any).loadSurface = (id: number) => (id === SURFACE ? surface : null);
  return mf;
}

const palette = (seed: number) => Array.from({ length: 2048 }, (_, i) => (i * 2654435761 + seed) >>> 0);

/**
 * One object build the way SetupModelRenderer runs it: a scope, then one
 * getMaterial per part surface (`calls`: [texture swaps, palette] each), the
 * meshes under a root, then endObjectBuild.
 */
function build(mf: MaterialFactory, calls: Array<[Map<number, number> | undefined, number[] | undefined]>): { root: THREE.Group; meshes: THREE.Mesh[] } {
  mf.beginObjectBuild();
  const root = new THREE.Group();
  const meshes = calls.map(([tex, pal]) => new THREE.Mesh(new THREE.BufferGeometry(), mf.getMaterial(SURFACE, undefined, tex, pal)));
  for (const m of meshes) root.add(m);
  mf.endObjectBuild(root);
  return { root, meshes };
}
const mats = (o: { meshes: THREE.Mesh[] }) => o.meshes.map((m) => m.material as THREE.Material);
const id = (m: THREE.Material) => (m as unknown as { id: number }).id;

afterEach(() => { delete (globalThis as { __acUniqueOverrideMaterials?: boolean }).__acUniqueOverrideMaterials; });

describe('PERF.override-material-share — identical objects share their override materials, part for part', () => {
  it('a second identical object draws the first one\'s materials, index for index', () => {
    const mf = factory();
    const seq: Array<[Map<number, number> | undefined, number[] | undefined]> = [[undefined, palette(1)], [new Map([[1, 2]]), palette(1)]];
    const a = build(mf, seq);
    const b = build(mf, [[undefined, palette(1)], [new Map([[1, 2]]), palette(1)]]); // equal content, new arrays
    expect(mats(b)).toEqual(mats(a));
    for (const m of mats(a)) expect(isSharedMaterial(m)).toBe(true);
    expect(mf.objectSetCount).toBe(1);
  });

  it('inside one object two parts with the same surface keep distinct materials, in build order (the draw order)', () => {
    const mf = factory();
    const o = build(mf, [[undefined, palette(2)], [undefined, palette(2)], [undefined, palette(2)]]);
    const m = mats(o);
    expect(new Set(m).size).toBe(3);
    expect(m.map(id)).toEqual([...m.map(id)].sort((x, y) => x - y));
    const twin = build(mf, [[undefined, palette(2)], [undefined, palette(2)], [undefined, palette(2)]]);
    expect(mats(twin)).toEqual(m);
  });

  it('any difference in the sequence (palette colour, texture swap, order, length) is its own set', () => {
    const mf = factory();
    const a = build(mf, [[undefined, palette(1)], [undefined, palette(3)]]);
    const pal = palette(1); pal[1500] ^= 1;
    expect(mats(build(mf, [[undefined, pal], [undefined, palette(3)]]))).not.toEqual(mats(a));
    expect(mats(build(mf, [[new Map([[5, 6]]), palette(1)], [undefined, palette(3)]]))[0]).not.toBe(mats(a)[0]);
    expect(mats(build(mf, [[undefined, palette(3)], [undefined, palette(1)]]))[0]).not.toBe(mats(a)[1]);
    expect(mats(build(mf, [[undefined, palette(1)]]))[0]).not.toBe(mats(a)[0]);
  });

  it('a palette-hash collision is caught by the colour compare: that object keeps its own', () => {
    const mf = factory();
    const a = build(mf, [[undefined, palette(7)]]);
    // Forge a collision: point another palette's signature at a's set.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sets = (mf as any).objectSets as Map<string, unknown>;
    const forged = overrideCacheKey(SURFACE, undefined, undefined, palette(8), false, false);
    sets.set(forged, sets.get(overrideCacheKey(SURFACE, undefined, undefined, palette(7), false, false)));
    const b = build(mf, [[undefined, palette(8)]]);
    expect(mats(b)[0]).not.toBe(mats(a)[0]);
    expect(isSharedMaterial(mats(b)[0])).toBe(false);
  });

  it('outside an object build every call is a fresh material (degrade levels, previews)', () => {
    const mf = factory();
    expect(mf.getMaterial(SURFACE, undefined, undefined, palette(1))).not.toBe(mf.getMaterial(SURFACE, undefined, undefined, palette(1)));
  });

  it('a fade on one object never touches its identical twin', () => {
    const mf = factory();
    const a = build(mf, [[undefined, palette(3)]]);
    const b = build(mf, [[undefined, palette(3)]]);
    const shared = mats(a)[0];
    setObjectTranslucency(a.root, 0.6);
    expect(mats(a)[0].opacity).toBeCloseTo(0.4, 6);
    expect(shared.opacity).toBe(1);
    expect(mats(b)[0]).toBe(shared);
    setObjectTranslucency(a.root, 0);
    expect(mats(a)[0]).toBe(shared); // PERF.restored-copy-release
  });

  it('tearing an object down leaves the set for its twin; the sweep frees it once nothing draws it', () => {
    const mf = factory();
    const a = build(mf, [[undefined, palette(4)]]);
    const shared = mats(a)[0];
    let disposed = 0;
    shared.addEventListener('dispose', () => { disposed++; });
    disposeObjectTree(a.root);
    expect(disposed).toBe(0);
    expect(mats(build(mf, [[undefined, palette(4)]]))[0]).toBe(shared);
    expect(mf.sweep(new Set([shared]))).toBe(0);
    expect(mf.sweep(new Set())).toBeGreaterThan(0);
    expect(disposed).toBe(1);
    expect(mf.objectSetCount).toBe(0);
    expect(mats(build(mf, [[undefined, palette(4)]]))[0]).not.toBe(shared);
  });

  it('the probe switch leaves every object on its own materials and names the shared one each would draw', () => {
    const mf = factory();
    (globalThis as { __acUniqueOverrideMaterials?: boolean }).__acUniqueOverrideMaterials = true;
    const a = build(mf, [[undefined, palette(5)], [undefined, palette(6)]]);
    const b = build(mf, [[undefined, palette(5)], [undefined, palette(6)]]);
    expect(mats(b)[0]).not.toBe(mats(a)[0]);
    expect(mats(b).map((m) => mf.sharedOverrideFor(m))).toEqual(mats(a));
    expect(mf.sharedOverrideFor(mats(a)[0])).toBeNull();
  });
});
