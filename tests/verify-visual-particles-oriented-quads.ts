/**
 * VISUAL.particles-oriented-quads — particles drew as camera-facing points
 * (THREE.Points) sized in screen space. Retail draws each particle as a
 * CPhysicsPart of the emitter's HW GfxObj (ParticleEmitter::SetInfo @
 * 0051ce90) at `gfxobj_scale`, in the part's frame (Particle::Update @
 * 0051c290: identity for every type but the GR ones, which take the parent
 * frame spun by C·t via Frame::rotate @ 004525b0 / grotate @ 005357a0), then
 * re-oriented by the GfxObj's degrade level (CPhysicsPart::calc_draw_frame
 * @ 0050dfa0: 2 = billboard, 5 = about local Z) and culled by that chain
 * (GfxObjDegradeInfo::get_degrade @ 0051e4b0 → an INVALID level draws
 * nothing; ShouldDrawParticles @ 0050fe60 beyond the emitter's degrade
 * distance).
 *
 * These tests drive the shipped ParticleSystem / resolveEmitterSprite with
 * synthetic emitters and with the real EoL DAT emitters (the casting-hand
 * glow 0x32000109, the windup swarm 0x3200011E, the portal swirl 0x320002CD,
 * a cylindrical GR emitter 0x32000227).
 */
import { describe, it, expect, beforeAll, vi, onTestFinished } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import { ParticleSystem, type ParticleFrameSource, type ParticleSpriteOptions } from '../packages/renderer/src/effects/ParticleSystem.js';
import { buildParticleSubmeshes, fallbackParticleGfx, particleMaxDegradeDistance, type ParticleGfx } from '../packages/renderer/src/effects/ParticleGfx.js';
import { resolveEmitterSprite } from '../packages/renderer/src/effects/EmitterSprite.js';
import { SpellEffects } from '../packages/renderer/src/effects/SpellEffects.js';
import { makeEmitterFrameSource } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { DegradeLod } from '../packages/renderer/src/models/DegradeLod.js';
import type { ParticleEmitterInfo } from '../packages/dat-parser/src/file-types/ParticleEmitterInfo.js';
import type { GfxObjLOD } from '../packages/dat-parser/src/file-types/GfxObjDegradeInfo.js';
import { openDat } from './_harness/dat.js';

const PORTAL = 'dat/client_portal.dat';
const hasDat = fs.existsSync(PORTAL);
const FLT_MAX = 3.4028234663852886e38;

function makeInfo(overrides: Partial<ParticleEmitterInfo>): ParticleEmitterInfo {
  return {
    id: 0x32000000, emitterType: 1, particleType: 1, gfxObjId: 0, hwGfxObjId: 0x01000001,
    birthrate: 0, maxParticles: 10, initialParticles: 1, totalParticles: 0, totalSeconds: 0,
    lifespan: 100, lifespanRand: 0, offsetDir: { x: 0, y: 0, z: 0 }, minOffset: 0, maxOffset: 0,
    a: { x: 0, y: 0, z: 0 }, minA: 1, maxA: 1, b: { x: 0, y: 0, z: 0 }, minB: 1, maxB: 1,
    c: { x: 0, y: 0, z: 0 }, minC: 1, maxC: 1, startScale: 1, finalScale: 1, scaleRand: 0,
    startTrans: 0, finalTrans: 0, transRand: 0, isParentLocal: 0,
    ...overrides,
  } as ParticleEmitterInfo;
}

const lod = (gfxObjId: number, mode: number, min: number, ideal: number, max: number): GfxObjLOD =>
  ({ gfxObjId, degradeMode: mode, minDist: min, idealDist: ideal, maxDist: max });

/** A 1 m quad in the AC XZ plane with the given degrade chain (the common DAT shape). */
function quadSprite(degrades: GfxObjLOD[]): ParticleSpriteOptions {
  const base = fallbackParticleGfx(1);
  const gfx: ParticleGfx = {
    gfxObjs: base.gfxObjs,
    degrades,
    levelGfx: degrades.length ? degrades.map(l => (l.gfxObjId ? 0 : -1)) : [0],
    sortCenter: { x: 0, y: 0, z: 0 },
  };
  return { gfx, map: null, additive: true, sizeScale: 1 };
}
const BILLBOARD_64 = [lod(0x01000001, 2, 64, 64, 64), lod(0, 1, FLT_MAX, FLT_MAX, FLT_MAX)];
const NORMAL_64 = [lod(0x01000001, 1, 64, 64, 64), lod(0, 1, FLT_MAX, FLT_MAX, FLT_MAX)];

/** Instance `i`'s drawn transform. */
function instance(sys: ParticleSystem, i = 0, mesh = 0) {
  const m = new THREE.Matrix4();
  const draw = sys.meshes[mesh];
  draw.getMatrixAt(i, m);
  // the draw's own frame (a world-frame emitter's draw is anchored at the emitter)
  draw.updateWorldMatrix(true, false);
  m.premultiply(draw.matrixWorld);
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(pos, q, s);
  return { pos, q, s };
}

/** A parent frame at `pos` with three.js orientation `quat` (a SetParenting frame source). */
function frameAt(pos: THREE.Vector3, quat: THREE.Quaternion, offset = { x: 0, y: 0, z: 0 }): ParticleFrameSource & { pos: THREE.Vector3; quat: THREE.Quaternion } {
  return {
    pos, quat, offset,
    getFrame(outPos, outQuat) { outPos.copy(this.pos); outQuat.copy(this.quat); return true; },
  };
}

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

describe('the part frame (Particle::Update @ 0051c290)', () => {
  it('a non-GR particle keeps the identity frame — world axes, whatever its parent\'s heading', () => {
    const parentQ = new THREE.Quaternion().setFromAxisAngle(Y, 1.2);
    const sys = new ParticleSystem(makeInfo({ particleType: 2, a: { x: 1, y: 0, z: 0 } }), 0xffffff,
      quadSprite(NORMAL_64), frameAt(new THREE.Vector3(5, 0, 5), parentQ));
    sys.update(0.5);
    expect(sys.orientationAt(0).angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
    // Mode 1: drawn in that frame even with a viewer.
    sys.setView({ viewer: new THREE.Vector3(20, 3, -7) });
    expect(instance(sys).q.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
    sys.dispose();
  });

  it('a GR particle spins by C·t about an axis in the parent frame (AC +z → three +Y, reflected angle)', () => {
    // C = (0, 0, 1) rad/s about AC up; at t = π/2 the AC x axis has turned to AC +y.
    const sys = new ParticleSystem(makeInfo({ particleType: 11, c: { x: 0, y: 0, z: 1 } }), 0xffffff, quadSprite(NORMAL_64),
      frameAt(new THREE.Vector3(), new THREE.Quaternion()));
    sys.update(Math.PI / 2);
    const acX = X.clone().applyQuaternion(sys.orientationAt(0));
    // AC +y is three +Z.
    expect(acX.x).toBeCloseTo(0, 5);
    expect(acX.z).toBeCloseTo(1, 5);
    sys.dispose();
  });

  it('parent-local GR particles spin in the parent\'s CURRENT frame; others in the StartFrame', () => {
    const src = frameAt(new THREE.Vector3(), new THREE.Quaternion());
    const mk = (isParentLocal: number) => new ParticleSystem(
      makeInfo({ particleType: 4, isParentLocal, c: { x: 1, y: 0, z: 0 }, minC: 0, maxC: 0 }), 0xffffff, quadSprite(NORMAL_64), src);
    const local = mk(1), start = mk(0);
    src.quat.setFromAxisAngle(Y, Math.PI / 2); // the parent turns after the particles were born
    local.update(0.1); start.update(0.1);
    // C scaled by 0 → no spin: the frame is just the parent's.
    expect(local.orientationAt(0).angleTo(src.quat)).toBeLessThan(1e-3);
    expect(start.orientationAt(0).angleTo(new THREE.Quaternion())).toBeLessThan(1e-3);
    local.dispose(); start.dispose();
  });

  it('the LVLALR C is taken into the start frame at Init AND treated as local again at Update (retail\'s double rotation)', () => {
    // Parent yawed 90° about AC z (three Y by −90°): AC local x → AC +y.
    const parentQ = new THREE.Quaternion().setFromAxisAngle(Y, -Math.PI / 2);
    const sys = new ParticleSystem(makeInfo({ particleType: 9, c: { x: 1, y: 0, z: 0 } }), 0xffffff, quadSprite(NORMAL_64),
      frameAt(new THREE.Vector3(), parentQ));
    sys.update(0.7);
    // Init: C_global = R·(1,0,0) = AC (0,1,0). Update: Frame::rotate(C·t) takes it as LOCAL → about R·(0,1,0) = AC −x.
    const expected = parentQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Z, -0.7)); // AC (0,1,0) → three (0,0,1), angle reflected
    expect(sys.orientationAt(0).angleTo(expected)).toBeLessThan(1e-5);
    sys.dispose();
  });
});

describe('calc_draw_frame + get_degrade on particles', () => {
  it('mode 2 billboards: AC +Y (three +Z) points from the viewer to the particle, X stays horizontal', () => {
    const sys = new ParticleSystem(makeInfo({}), 0xffffff, quadSprite(BILLBOARD_64));
    sys.setView({ viewer: new THREE.Vector3(3, 4, 12) });
    const { q } = instance(sys);
    const fwd = Z.clone().applyQuaternion(q);
    const want = new THREE.Vector3(-3, -4, -12).normalize();
    expect(fwd.distanceTo(want)).toBeLessThan(1e-5);
    expect(X.clone().applyQuaternion(q).y).toBeCloseTo(0, 6);
    sys.dispose();
  });

  it('the quad is world-sized: instance scale = gfxobj_scale, geometry = the GfxObj\'s own vertices', () => {
    const sys = new ParticleSystem(makeInfo({ startScale: 0.5, finalScale: 0.5 }), 0xffffff, quadSprite(BILLBOARD_64));
    sys.setView({ viewer: new THREE.Vector3(0, 0, 5) });
    expect(instance(sys).s.x).toBeCloseTo(0.5, 6);
    sys.dispose();
  });

  it('get_degrade(dist / scale − DegradeDistance): a small particle vanishes at its INVALID level', () => {
    // scale 0.1, level 0 up to 64 m after the 50 m Degrade Distance shift:
    // dist/0.1 − 50 < 64 ⇔ dist < 11.4 m.
    const sys = new ParticleSystem(makeInfo({ startScale: 0.1, finalScale: 0.1 }), 0xffffff, quadSprite(BILLBOARD_64));
    sys.setView({ viewer: new THREE.Vector3(0, 0, 11) });
    expect(sys.drawnCount).toBe(1);
    sys.setView({ viewer: new THREE.Vector3(0, 0, 11.6) });
    expect(sys.drawnCount).toBe(0);
    // Degrade Distance 100 keeps it to 16.4 m.
    sys.setView({ viewer: new THREE.Vector3(0, 0, 16), degradeDistance: 100 });
    expect(sys.drawnCount).toBe(1);
    sys.dispose();
  });

  it('ShouldDrawParticles: the whole emitter draws nothing beyond its max degrade distance', () => {
    expect(particleMaxDegradeDistance(BILLBOARD_64)).toBe(64);
    expect(particleMaxDegradeDistance([])).toBe(100);
    const sys = new ParticleSystem(makeInfo({ startScale: 10, finalScale: 10 }), 0xffffff, quadSprite(BILLBOARD_64));
    sys.setView({ viewer: new THREE.Vector3(0, 0, 63) });
    expect(sys.drawnCount).toBe(1);
    sys.setView({ viewer: new THREE.Vector3(0, 0, 65) });
    expect(sys.drawnCount).toBe(0);
    sys.dispose();
  });

  it('no chain: mode 1, never degraded (the portal swirl shape)', () => {
    const sys = new ParticleSystem(makeInfo({ startScale: 0.1, finalScale: 0.1 }), 0xffffff, quadSprite([]));
    sys.setView({ viewer: new THREE.Vector3(0, 0, 90) });
    expect(sys.drawnCount).toBe(1);
    expect(instance(sys).q.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
    sys.setView({ viewer: new THREE.Vector3(0, 0, 101) }); // beyond the 100 m default
    expect(sys.drawnCount).toBe(0);
    sys.dispose();
  });

  it('within particle_distance every particle faces the viewer from its own spot; beyond it they share the emitter\'s heading', () => {
    // The two random offsets could land at nearly the same angle (flaky under
    // load): seed Math.random so the pair is always well apart.
    let seed = 7;
    const rnd = vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    });
    onTestFinished(() => rnd.mockRestore());
    const sys = new ParticleSystem(makeInfo({ particleType: 1, initialParticles: 2, maxOffset: 3, minOffset: 3, offsetDir: { x: 0, y: 0, z: 1 } }),
      0xffffff, quadSprite(BILLBOARD_64));
    sys.setView({ viewer: new THREE.Vector3(0, 1, 1.5) }); // 2-D 1.5 m < 4 m
    const a = instance(sys, 0).q, b = instance(sys, 1).q;
    expect(a.angleTo(b)).toBeGreaterThan(0.05);
    sys.setView({ viewer: new THREE.Vector3(0, 1, 30) }); // far: CPartArray::UpdateViewerDistance(dist, dir)
    expect(instance(sys, 0).q.angleTo(instance(sys, 1).q)).toBeLessThan(1e-6);
    sys.dispose();
  });

  it('an outdoor emitter beyond 50 m takes its land-cell 2-D distance (RenderDeviceD3D::UpdateObjCell)', () => {
    // Emitter at (1, 0, 1), in the land cell centred (12, 12); degrade
    // distance 64 m.
    const anchor = new THREE.Object3D();
    anchor.userData[DegradeLod.LAND_CELL_KEY] = true;
    const scene = new THREE.Scene(); scene.add(anchor);
    anchor.position.set(1, 0, 1);
    const src = makeEmitterFrameSource(anchor, { x: 0, y: 0, z: 0 });
    expect(src.inLandCell?.()).toBe(true);
    const sys = new ParticleSystem(makeInfo({ startScale: 10, finalScale: 10 }), 0xffffff, quadSprite(BILLBOARD_64), src);
    // Viewer 63 m from the emitter, 47.4 m from the cell centre (≤ 50 m):
    // the emitter's own distance → 63 ≤ 64, drawn.
    const v = new THREE.Vector3(1 + 63 * Math.cos(0.785), 0, 1 + 63 * Math.sin(0.785));
    sys.setView({ viewer: v });
    expect(sys.drawnCount).toBe(1);
    anchor.userData[DegradeLod.LAND_CELL_KEY] = false; // an interior owner
    expect(src.inLandCell?.()).toBe(false);
    // Viewer 66 m from the emitter but only 50.4 m from the cell centre:
    // indoors → culled (66 > 64); outdoors → the cell's 50.4 m → drawn.
    const far = new THREE.Vector3(1 + 66 * Math.cos(0.785), 0, 1 + 66 * Math.sin(0.785));
    sys.setView({ viewer: far });
    expect(sys.drawnCount).toBe(0);
    anchor.userData[DegradeLod.LAND_CELL_KEY] = true;
    sys.setView({ viewer: far });
    expect(sys.drawnCount).toBe(1);
    sys.dispose();
  });

  it('a fully translucent particle (SetTranslucency(1)) is not drawn', () => {
    const sys = new ParticleSystem(makeInfo({ startTrans: 1, finalTrans: 0 , lifespan: 2 }), 0xffffff, quadSprite(BILLBOARD_64));
    expect(sys.drawnCount).toBe(0);
    sys.update(1);
    expect(sys.drawnCount).toBe(1);
    sys.dispose();
  });

  it('one draw call per emitter surface: every particle is an instance of the same mesh', () => {
    const sys = new ParticleSystem(makeInfo({ initialParticles: 8, maxParticles: 8 }), 0xffffff, quadSprite(BILLBOARD_64));
    expect(sys.meshes).toHaveLength(1);
    expect(sys.meshes[0]).toBeInstanceOf(THREE.InstancedMesh);
    expect(sys.meshes[0].count).toBe(8);
    sys.dispose();
  });

  it('SpellEffects lays a new emitter out against the live view at birth', () => {
    const effects = new SpellEffects(new THREE.Scene());
    effects.setParticleView({ viewer: new THREE.Vector3(0, 0, 200) });
    const sys = effects.spawnParticleEffect(makeInfo({}), { x: 0, y: 0, z: 0 }, undefined, quadSprite(BILLBOARD_64));
    expect(sys.drawnCount).toBe(0); // 200 m > the 64 m degrade distance
  });
});

describe('buildParticleSubmeshes — the GfxObj\'s own polygons', () => {
  it('keeps a non-square, off-centre quad and its per-vertex UVs (AC → three axes)', () => {
    const verts = new Map([
      [0, { origin: { x: -0.7, y: 0, z: 0.7 }, normal: { x: 0, y: 1, z: 0 }, uvs: [{ u: 0, v: 0 }] }],
      [1, { origin: { x: -0.7, y: 0, z: -0.7 }, normal: { x: 0, y: 1, z: 0 }, uvs: [{ u: 0, v: 1 }] }],
      [2, { origin: { x: 0.75, y: 0, z: -0.7 }, normal: { x: 0, y: 1, z: 0 }, uvs: [{ u: 1, v: 1 }] }],
      [3, { origin: { x: 0.75, y: 0, z: 0.7 }, normal: { x: 0, y: 1, z: 0 }, uvs: [{ u: 1, v: 0 }] }],
    ]);
    const gfxObj = {
      vertexArray: { vertices: verts },
      polygons: [{ numPts: 4, stippling: 0, sidesType: 1, posSurface: 0, negSurface: 0, vertexIndices: [0, 1, 2, 3], posUVIndices: [0, 0, 0, 0], negUVIndices: [] }],
    } as never;
    const surf = { map: null, additive: true, color: 0xffffff, opacity: 1, alphaTest: 0, luminosity: 1 };
    const [sub] = buildParticleSubmeshes(gfxObj, [surf]);
    const pos = sub.geometry.getAttribute('position');
    const uv = sub.geometry.getAttribute('uv');
    expect(pos.count).toBe(4);
    // AC (0.75, 0, -0.7) → three (0.75, -0.7, 0)
    expect([pos.getX(2), pos.getY(2), pos.getZ(2)]).toEqual([0.75, expect.closeTo(-0.7, 6), 0]);
    expect([uv.getX(2), uv.getY(2)]).toEqual([1, 1]);
    expect(sub.geometry.index!.count).toBe(6);
    expect(sub.surface).toBe(surf);
  });
});

describe.skipIf(!hasDat)('EoL DAT emitters draw their HW GfxObj the retail way', () => {
  let db: import('@ac/dat-parser').DatDatabase;
  let tm: import('../packages/renderer/src/models/TextureManager.js').TextureManager;
  const info: Record<number, ParticleEmitterInfo> = {};

  beforeAll(async () => {
    const { DatDatabase, DatReader, ParticleEmitterInfo: PEI } = await import('@ac/dat-parser');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    db = openDat(PORTAL);
    tm = new TextureManager(db);
    for (const id of [0x32000109, 0x3200011E, 0x320002CD, 0x32000227]) info[id] = new PEI(new DatReader(db.getFileData(id)!));
  });

  it('hand glow 0x32000109 / windup swarm 0x3200011E: a 0.29 m additive quad, billboarded (mode 2) to 64 m, then INVALID', () => {
    for (const id of [0x32000109, 0x3200011E]) {
      const sprite = resolveEmitterSprite(info[id], db, tm)!;
      const gfx = sprite.gfx!;
      expect(gfx.gfxObjs).toHaveLength(1);
      expect(gfx.degrades.map(l => l.degradeMode)).toEqual([2, 1]);
      expect(gfx.levelGfx).toEqual([0, -1]);
      expect(gfx.degrades[0].maxDist).toBe(64);
      const [sub] = gfx.gfxObjs[0];
      expect(sub.surface.additive).toBe(true);
      expect(sub.surface.map).not.toBeNull();
      sub.geometry.computeBoundingBox();
      const bb = sub.geometry.boundingBox!;
      // The quad lies in the AC XZ plane = three XY (z = 0), 0.2937 m square.
      expect(bb.max.x - bb.min.x).toBeCloseTo(0.2937, 3);
      expect(bb.max.y - bb.min.y).toBeCloseTo(0.2937, 3);
      expect(bb.max.z - bb.min.z).toBeCloseTo(0, 6);
    }
  });

  it('the hand glow faces the camera with the texture\'s front (−Y) side and shrinks to 0.1 scale', () => {
    const sprite = resolveEmitterSprite(info[0x32000109], db, tm)!;
    const src = frameAt(new THREE.Vector3(10, 1, 10), new THREE.Quaternion().setFromAxisAngle(Y, 0.8));
    const sys = new ParticleSystem(info[0x32000109], 0xffffff, sprite, src);
    // Per-metre emitter: move the hand to emit.
    for (let i = 0; i < 5; i++) { src.pos.x += 0.1; sys.update(0.05); }
    expect(sys.activeCount).toBeGreaterThan(0);
    // Within particle_distance (2-D < 4 m): the heading is the particle's own.
    const viewer = new THREE.Vector3(10.3, 2, 12);
    sys.setView({ viewer });
    const { pos, q, s } = instance(sys);
    // −(AC +Y) = the quad's textured front, toward the viewer.
    const front = Z.clone().negate().applyQuaternion(q);
    expect(front.dot(viewer.clone().sub(pos).normalize())).toBeGreaterThan(0.999);
    // start 0.5 → final 0.1, each ± scaleRand (GetRandomStartScale)
    expect(s.x).toBeLessThanOrEqual(0.5 + info[0x32000109].scaleRand + 1e-6);
    sys.dispose();
  });

  it('a world-frame emitter\'s draw sorts at the emitter, not the scene origin (VISUAL.glow-vs-cutout-draw-order)', () => {
    const sprite = resolveEmitterSprite(info[0x32000109], db, tm)!;
    const src = frameAt(new THREE.Vector3(500, 3, -700), new THREE.Quaternion());
    const sys = new ParticleSystem(info[0x32000109], 0xffffff, sprite, src);
    for (let i = 0; i < 5; i++) { src.pos.x += 0.1; sys.update(0.05); }
    sys.setView({ viewer: new THREE.Vector3(500, 4, -695) });
    const draw = sys.meshes[0];
    draw.updateWorldMatrix(true, false);
    const at = new THREE.Vector3().setFromMatrixPosition(draw.matrixWorld);
    // three.js sorts the transparent list by this position
    expect(at.distanceTo(src.pos)).toBeLessThan(1);
    // and the particles still land where the simulation put them
    expect(instance(sys).pos.distanceTo(src.pos)).toBeLessThan(2);
    sys.dispose();
  });

  it('portal swirl 0x320002CD: no degrade chain → drawn in its frame (never billboarded), spinning about its normal, a 1.45 × 1.40 m off-centre quad', () => {
    const e = info[0x320002CD];
    expect(e.particleType).toBe(9); // ParabolicLVLALR
    const sprite = resolveEmitterSprite(e, db, tm)!;
    const gfx = sprite.gfx!;
    expect(gfx.degrades).toEqual([]);
    const [sub] = gfx.gfxObjs[0];
    sub.geometry.computeBoundingBox();
    const bb = sub.geometry.boundingBox!;
    expect(bb.max.x - bb.min.x).toBeCloseTo(1.45, 4);
    expect(bb.max.y - bb.min.y).toBeCloseTo(1.4, 4);
    expect(bb.min.x).toBeCloseTo(-0.7, 4); // off-centre: x ∈ [−0.70, 0.75]
    // An unrotated portal: the swirl disc spins in the portal's plane. (A
    // yawed one spins about R·R·C — Init already took C into the start
    // frame and Update's Frame::rotate treats it as local again; see the
    // LVLALR double-rotation test above.)
    const portalQ = new THREE.Quaternion();
    const sys = new ParticleSystem(e, 0xffffff, sprite, frameAt(new THREE.Vector3(0, 0, 0), portalQ));
    sys.update(0.5);
    sys.setView({ viewer: new THREE.Vector3(8, 1.5, -3) });
    const normal = Z.clone().applyQuaternion(portalQ);
    for (let i = 0; i < Math.min(sys.drawnCount, 5); i++) {
      const { q } = instance(sys, i);
      // The quad's normal (AC local y) is the portal's: C = (0, −0.5, 0) spins about it.
      expect(Math.abs(Z.clone().applyQuaternion(q).dot(normal))).toBeGreaterThan(0.999);
    }
    // …and it spins: two particles of different ages have different in-plane
    // angles (one emission per update — DECOMP.emitter-backlog — so a few
    // updates for a few ages).
    for (let i = 0; i < 3; i++) sys.update(0.2);
    const angles = new Set<string>();
    for (let i = 0; i < sys.drawnCount; i++) angles.add(X.clone().applyQuaternion(instance(sys, i).q).x.toFixed(3));
    expect(angles.size).toBeGreaterThan(1);
    sys.dispose();
  });

  it('0x32000227 (LVGAGR, chain mode 5): the quad turns about its own up axis toward the viewer, never pitching', () => {
    const e = info[0x32000227];
    const sprite = resolveEmitterSprite(e, db, tm)!;
    expect(sprite.gfx!.degrades[0].degradeMode).toBe(5);
    const sys = new ParticleSystem(e, 0xffffff, sprite, frameAt(new THREE.Vector3(), new THREE.Quaternion()));
    for (let i = 0; i < 10; i++) sys.update(0.1);
    sys.setView({ viewer: new THREE.Vector3(6, 9, 2) });
    expect(sys.drawnCount).toBeGreaterThan(0);
    for (let i = 0; i < sys.drawnCount; i++) {
      const { q } = instance(sys, i);
      const base = sys.orientationAt(i);
      // The kept axis is the part's own AC z (three Y).
      expect(Y.clone().applyQuaternion(q).distanceTo(Y.clone().applyQuaternion(base))).toBeLessThan(1e-4);
    }
    sys.dispose();
  });
});
