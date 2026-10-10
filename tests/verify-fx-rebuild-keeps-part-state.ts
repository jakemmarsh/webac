/**
 * Retail keeps the CPhysicsObj — and every CPhysicsPart — across an ObjDesc
 * change: CPhysicsObj::DoObjDescChanges @ 0050fa30 → CPartArray::
 * DoObjDescChanges @ 00519210 → SetPart @ 00518580 → CPhysicsPart::SetPart
 * @ 0050e700 swaps only a part's GfxObj, and a streamed DAT arriving late
 * changes nothing at all. Our client builds new part nodes in both cases, so
 * what a script left on the object has to follow them:
 *
 *  - FX.pending-emitter-orphaned-by-rebuild: an emitter still waiting for its
 *    streamed files when the object's mesh is rebuilt starts on the new mesh.
 *  - FX.player-transplant-kills-part-emitters: the local player's in-place
 *    part transplant (transplantPartChildren) keeps its part emitters, its
 *    parts' texture scroll and its cell-pass materials.
 *  - FX.part-script-state-lost-on-rebuild: per-part translucency, luminosity
 *    and diffusion survive both rebuild paths.
 *
 * Drives the real PhysicsScriptPlayer, ParticleSystem, ObjectTranslucency,
 * RetailLighting and transplantPartChildren.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PhysicsScriptPlayer, PART_GFXOBJ_KEY } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { ParticleSystem, type ParticleFrameSource } from '../packages/renderer/src/effects/ParticleSystem.js';
import { AnimationHookType, type AnimationHook } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import type { ParticleEmitterInfo } from '../packages/dat-parser/src/file-types/ParticleEmitterInfo.js';
import { transplantPartChildren } from '../packages/renderer/src/models/AppearanceOverrides.js';
import { setCellLighting, cellObjectBaseOf, retailLightingKindOf } from '../packages/renderer/src/models/RetailLighting.js';
import { markSharedMaterial } from '../packages/renderer/src/models/MaterialOwnership.js';
import { setObjectTranslucency, setServerTranslucency } from '../packages/renderer/src/models/ObjectTranslucency.js';

/** An endless emitter: one particle per 1/6 s, 2 s lifespan (0x320002CD's shape). */
const ENDLESS = {
  id: 0x320002cd, emitterType: 1, particleType: 9, gfxObjId: 0, hwGfxObjId: 0x010016c8,
  birthrate: 1 / 6, maxParticles: 12, initialParticles: 0, totalParticles: 0, totalSeconds: 0,
  lifespan: 2, lifespanRand: 0, offsetDir: { x: 0, y: -1, z: 0 }, minOffset: 0, maxOffset: 0,
  a: { x: 0, y: 0, z: 0 }, minA: 0, maxA: 0, b: { x: 0, y: 0, z: 0 }, minB: 0, maxB: 0,
  c: { x: 0, y: 0, z: 0 }, minC: 0, maxC: 0, startScale: 1, finalScale: 1, scaleRand: 0,
  startTrans: 0, finalTrans: 0, transRand: 0, isParentLocal: 0,
} as unknown as ParticleEmitterInfo;

function createParticle(partIndex: number): AnimationHook {
  return { hookType: AnimationHookType.CreateParticle, direction: 0, emitterInfoId: ENDLESS.id, partIndex, offset: { origin: { x: 0, y: 0, z: 0 } }, emitterId: 0 } as unknown as AnimationHook;
}

/** A setup group whose `part_N` children each draw one lit, textured mesh. */
function setupGroup(indices: number[], x = 0, gfxObjId?: number): THREE.Group {
  const g = new THREE.Group();
  for (const i of indices) {
    const part = new THREE.Group(); part.name = `part_${i}`; part.position.set(x, 0, 0);
    if (gfxObjId !== undefined) part.userData[PART_GFXOBJ_KEY] = gfxObjId;
    part.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ map: new THREE.Texture() })));
    g.add(part);
  }
  return g;
}

function partMat(g: THREE.Object3D, i: number): THREE.MeshLambertMaterial {
  const part = g.children.find(c => c.name === `part_${i}`)!;
  return (part.children[0] as THREE.Mesh).material as THREE.MeshLambertMaterial;
}

function makePlayer(emitterPending?: (id: number) => Promise<void> | null) {
  const systems: ParticleSystem[] = [];
  const player = new PhysicsScriptPlayer({
    spellEffects: {
      spawnParticleEffect: (info: ParticleEmitterInfo, _p: unknown, _c: unknown, _s: unknown, _l: unknown, opts: { frameSource?: ParticleFrameSource }) => {
        const sys = new ParticleSystem(info, 0xffffff, undefined, opts.frameSource);
        systems.push(sys);
        return sys;
      },
      removeParticleSystem: (s: ParticleSystem) => s.dispose(),
    },
    soundPlayer: { playPositionalSound: () => Promise.resolve() },
    loadEmitterInfo: () => ENDLESS,
    getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    emitterPending,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return { player, systems };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));
const maxX = (sys: ParticleSystem) => Math.max(...[...Array(sys.activeCount)].map((_, i) => sys.positionAt(i).x));

describe('FX.pending-emitter-orphaned-by-rebuild', () => {
  it('an emitter whose streamed files land after the mesh was rebuilt starts on the new mesh', async () => {
    const scene = new THREE.Scene();
    let arrive!: () => void;
    const { player, systems } = makePlayer(() => new Promise<void>(r => { arrive = r; }));
    const oldMesh = setupGroup([0], 0); scene.add(oldMesh);
    player.executeHook(createParticle(0), oldMesh);
    expect(systems).toHaveLength(0); // waiting for its files

    // ServerObjectManager.updateAppearance: the old mesh leaves, the new one is drawn.
    const newMesh = setupGroup([0], 4); scene.add(newMesh);
    scene.remove(oldMesh);
    player.transferAnchor(oldMesh, newMesh);
    // A second rebuild before the files land: forwarding is followed through.
    const newest = setupGroup([0], 6); scene.add(newest);
    scene.remove(newMesh);
    player.transferAnchor(newMesh, newest);

    arrive();
    await flush();
    expect(systems).toHaveLength(1);
    const sys = systems[0];
    for (let i = 0; i < 10; i++) sys.update(0.1);
    expect(sys.isStopped).toBe(false);
    expect(sys.activeCount).toBeGreaterThan(0);
    expect(maxX(sys)).toBeCloseTo(6, 3);
    expect(player.emittersFor(newest)).toBeDefined();
    sys.dispose();
  });
});

describe('FX.player-transplant-kills-part-emitters', () => {
  it('an emitter on part_12 keeps emitting at the transplanted part', () => {
    const scene = new THREE.Scene();
    const { player, systems } = makePlayer();
    const group = setupGroup([0, 12]); scene.add(group);
    player.executeHook(createParticle(12), group);
    expect(systems).toHaveLength(1);
    const sys = systems[0];
    sys.update(0.5);

    const pairs = transplantPartChildren(group, setupGroup([0, 12]));
    player.transferParts(group, pairs);
    // The next animation frame moves the new part.
    group.children.find(c => c.name === 'part_12')!.position.x = 5;
    for (let i = 0; i < 30; i++) sys.update(0.1);
    expect(sys.isStopped).toBe(false);
    expect(sys.isDone).toBe(false);
    expect(sys.activeCount).toBeGreaterThan(0);
    expect(maxX(sys)).toBeCloseTo(5, 3);
    sys.dispose();
  });

  it('an emitter whose part was not built yet (rode the object root) moves onto the part_N the transplant brings', () => {
    const scene = new THREE.Scene();
    const { player, systems } = makePlayer();
    const group = setupGroup([0]); scene.add(group); // part_12 missing (streamed GfxObj not resident)
    player.executeHook(createParticle(12), group);
    expect(systems).toHaveLength(1);
    const sys = systems[0];
    player.transferParts(group, transplantPartChildren(group, setupGroup([0, 12])));
    group.children.find(c => c.name === 'part_12')!.position.x = 5;
    for (let i = 0; i < 30; i++) sys.update(0.1);
    expect(sys.isStopped).toBe(false);
    expect(sys.activeCount).toBeGreaterThan(0);
    expect(maxX(sys)).toBeCloseTo(5, 3);
    sys.dispose();
  });

  it("the part's texture scroll writes to the new part, and the old one is let go", () => {
    const scene = new THREE.Scene();
    const { player } = makePlayer();
    const group = setupGroup([0, 3], 0, 0x0100abcd); scene.add(group);
    player.executeHook({ hookType: AnimationHookType.TextureVelocityPart, direction: 0, partIndex: 3, uSpeed: 0.25, vSpeed: 0 } as unknown as AnimationHook, group);
    const oldPart = group.children.find(c => c.name === 'part_3')!;
    player.transferParts(group, transplantPartChildren(group, setupGroup([0, 3], 0, 0x0100abcd)));
    const newPart = group.children.find(c => c.name === 'part_3')!;
    expect(newPart).not.toBe(oldPart);
    player.update(1);
    expect(partMat(group, 3).map!.offset.x).toBeCloseTo(0.25, 5);
    const oldMat = (oldPart.children[0] as THREE.Mesh).material as THREE.MeshLambertMaterial;
    expect(oldMat.map!.offset.x).toBe(0);
    expect(player.gfxVelocityOf(newPart)).toMatchObject({ u: 0.25 });
  });

  it('new parts of a player inside a cell draw with the cell-pass materials', () => {
    const group = setupGroup([0, 1]);
    setCellLighting(group, true);
    expect(cellObjectBaseOf(partMat(group, 0))).not.toBe(partMat(group, 0));
    transplantPartChildren(group, setupGroup([0, 1]));
    for (const i of [0, 1]) {
      const mat = partMat(group, i);
      expect(cellObjectBaseOf(mat)).not.toBe(mat); // a cellobject variant
    }
    // The frame loop's per-frame call (unchanged flag) is still a no-op afterwards.
    setCellLighting(group, true);
    expect(cellObjectBaseOf(partMat(group, 0))).not.toBe(partMat(group, 0));
  });
});

describe('FX.part-script-state-lost-on-rebuild', () => {
  const partHook = (hookType: AnimationHookType, part: number, end: number) =>
    ({ hookType, direction: 0, part, start: end, end, time: 0 }) as unknown as AnimationHook;

  it('a streamed rebuild (transferAnchor) keeps per-part translucency, luminosity and diffusion', () => {
    const scene = new THREE.Scene();
    const { player } = makePlayer();
    const oldMesh = setupGroup([0, 1, 2]); scene.add(oldMesh);
    player.executeHook(partHook(AnimationHookType.TransparentPart, 0, 0.5), oldMesh);
    player.executeHook(partHook(AnimationHookType.TransparentPart, 2, 1), oldMesh);
    player.executeHook(partHook(AnimationHookType.LuminousPart, 1, 0.8), oldMesh);
    player.executeHook(partHook(AnimationHookType.DiffusePart, 1, 0.3), oldMesh);
    const newMesh = setupGroup([0, 1, 2]); scene.add(newMesh);
    scene.remove(oldMesh);
    player.transferAnchor(oldMesh, newMesh);
    expect(partMat(newMesh, 0).opacity).toBeCloseTo(0.5, 5);
    expect(partMat(newMesh, 0).transparent).toBe(true);
    expect(newMesh.children[2].children[0].visible).toBe(false);
    expect(partMat(newMesh, 1).emissive.r).toBeCloseTo(0.8, 5);
    expect(partMat(newMesh, 1).color.r).toBeCloseTo(0.3, 5);
    // Untouched part stays as authored.
    expect(partMat(newMesh, 2).opacity).toBe(1);
  });

  it('a part hidden before its streamed GfxObj arrived (no meshes yet) stays hidden on the rebuild', () => {
    const scene = new THREE.Scene();
    const { player } = makePlayer();
    const oldMesh = new THREE.Group(); const empty = new THREE.Group(); empty.name = 'part_0'; oldMesh.add(empty); scene.add(oldMesh);
    player.executeHook(partHook(AnimationHookType.TransparentPart, 0, 1), oldMesh);
    const newMesh = setupGroup([0]); scene.add(newMesh);
    scene.remove(oldMesh);
    player.transferAnchor(oldMesh, newMesh);
    expect(newMesh.children[0].children[0].visible).toBe(false);
  });

  it('the player part transplant keeps the script values too', () => {
    const scene = new THREE.Scene();
    const { player } = makePlayer();
    const group = setupGroup([0, 1]); scene.add(group);
    player.executeHook(partHook(AnimationHookType.TransparentPart, 0, 0.25), group);
    player.executeHook({ hookType: AnimationHookType.Luminous, direction: 0, start: 0.6, end: 0.6, time: 0 } as unknown as AnimationHook, group);
    player.transferParts(group, transplantPartChildren(group, setupGroup([0, 1])));
    expect(partMat(group, 0).opacity).toBeCloseTo(0.75, 5);
    expect(partMat(group, 0).emissive.r).toBeCloseTo(0.6, 5);
    expect(partMat(group, 1).emissive.r).toBeCloseTo(0.6, 5);
    expect(partMat(group, 1).opacity).toBe(1);
  });

  // FX.player-transplant-drops-translucency — CPhysicsObj::DoObjDescChanges
  // @ 0050fa30 sets max(translucency, translucencyOriginal) on every part again.
  it("the player part transplant re-applies the object's translucency to the new parts", () => {
    const scene = new THREE.Scene();
    const { player } = makePlayer();
    const group = setupGroup([0, 1]); scene.add(group);
    setObjectTranslucency(group, 0.4); // a portal / login fade in progress
    player.transferParts(group, transplantPartChildren(group, setupGroup([0, 1])));
    for (const i of [0, 1]) {
      expect(partMat(group, i).opacity).toBeCloseTo(0.6, 5);
      expect(partMat(group, i).transparent).toBe(true);
    }
    // The server floor (translucencyOriginal) holds too.
    const g2 = setupGroup([0]); scene.add(g2);
    setServerTranslucency(g2, 0.7);
    player.transferParts(g2, transplantPartChildren(g2, setupGroup([0])));
    expect(partMat(g2, 0).opacity).toBeCloseTo(0.3, 5);
  });
});

describe('FX.cell-swap-loses-script-material — script luminosity / diffusion survive the cell <-> landscape pass swap', () => {
  const lum = (v: number) => ({ hookType: AnimationHookType.LuminousPart, direction: 0, part: 0, start: v, end: v, time: 0 }) as unknown as AnimationHook;
  const dif = (v: number) => ({ hookType: AnimationHookType.DiffusePart, direction: 0, part: 0, start: v, end: v, time: 0 }) as unknown as AnimationHook;

  it('a value set indoors is still there after walking out (owned material)', () => {
    const { player } = makePlayer();
    const group = setupGroup([0]);
    setCellLighting(group, false);
    player.executeHook(lum(0.7), group);
    setCellLighting(group, true);
    expect(partMat(group, 0).emissive.r).toBeCloseTo(0.7, 5);
    player.executeHook(lum(0.2), group);
    player.executeHook(dif(0.4), group);
    setCellLighting(group, false);
    const out = partMat(group, 0);
    expect(cellObjectBaseOf(out)).toBe(out); // the landscape-pass material
    expect(out.emissive.r).toBeCloseTo(0.2, 5);
    expect(out.color.r).toBeCloseTo(0.4, 5);
    setCellLighting(group, true);
    expect(partMat(group, 0).emissive.r).toBeCloseTo(0.2, 5);
  });

  it('a shared material first written indoors leaves the cell pass on the way out and keeps the value', () => {
    const { player } = makePlayer();
    const group = setupGroup([0]);
    const shared = markSharedMaterial(partMat(group, 0));
    setCellLighting(group, true);
    player.executeHook(lum(0.5), group);
    const inside = partMat(group, 0);
    expect(retailLightingKindOf(inside)).toBe('cellobject');
    expect(shared.emissive.r).toBe(0); // never written through
    setCellLighting(group, false);
    const out = partMat(group, 0);
    expect(out).not.toBe(shared);
    expect(retailLightingKindOf(out)).not.toBe('cellobject');
    expect(out.emissive.r).toBeCloseTo(0.5, 5);
    expect(shared.emissive.r).toBe(0);
  });
});
