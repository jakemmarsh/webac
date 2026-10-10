/**
 * SWEEP1006B.world-objects.dat-static-objects-dungeon-building — DAT statics
 * (EnvCell stabs, landblock objects, scenery) loop their Setup's
 * DefaultAnimation, as every retail static CPhysicsObj does.
 *
 * Retail (acclient-decompiled.annotated.c):
 *  - CEnvCell::init_static_objects @ 0052c350 / CLandBlock::init_static_objs
 *    @ 00530a40 / CLandBlock::get_land_scenes @ 00530460 →
 *    CPhysicsObj::makeObject @ 00513970 → InitObjectBegin(..,0,0) (STATIC).
 *  - CPartArray::InitDefaults @ 00518980: AnimData(default_anim_id, 0, -1,
 *    30 fps) appended; CPhysicsObj::InitDefaults @ 005139d0: STATIC + default
 *    anim → state |= 0x40000, CPhysics::AddStaticAnimatingObject.
 *  - CPhysics::UseTime @ 00509950 → animate_static_object @ 00513df0:
 *    CPartArray::Update(dt), parts posed, process_hooks; a step longer than
 *    HUGE_QUANTUM (2 s) only resets the clock.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as THREE from 'three';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Animation } from '@ac/dat-parser/file-types/Animation.js';
import type { AnimationHook } from '@ac/dat-parser/file-types/AnimationHook.js';
import {
  StaticAnimationDriver, tagStaticDefaultAnimation, STATIC_ANIM_KEY, HUGE_QUANTUM,
} from '../packages/renderer/src/world/StaticAnimationDriver.js';
import { StaticScriptDriver } from '../packages/renderer/src/world/StaticScriptDriver.js';
import { openDat } from './_harness/dat.js';

const ID = { w: 1, x: 0, y: 0, z: 0 };
/** A 2-part, `n`-frame animation: part 0 rises 1 m per frame; frame 1 carries one hook. */
function fakeAnim(n = 4): Animation {
  const partFrames = Array.from({ length: n }, (_, f) => ({
    frames: [{ origin: { x: 0, y: 0, z: f }, orientation: ID }, { origin: { x: 2, y: 0, z: 0 }, orientation: ID }],
    hooks: f === 1 ? [{ hookType: 22, direction: 0, axis: { x: 0, y: 0, z: 1 } } as unknown as AnimationHook] : [],
  }));
  return { id: 0x03000001, flags: 0, numParts: 2, numFrames: n, posFrames: [], partFrames } as unknown as Animation;
}

function staticMesh(): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 2; i++) { const p = new THREE.Object3D(); p.name = `part_${i}`; g.add(p); }
  return g;
}

describe('StaticAnimationDriver — static_animating_objects', () => {
  it('a tagged static starts at frame 0 when attached and loops at 30 fps', () => {
    const anim = fakeAnim(4);
    const driver = new StaticAnimationDriver({ loadAnimation: id => (id === 0x03000001 ? anim : null) });
    const cell = new THREE.Group();
    const lever = staticMesh();
    tagStaticDefaultAnimation(lever, 0x02000ccd, 0x03000001);
    cell.add(lever, staticMesh()); // an untagged sibling is ignored
    driver.attach(cell);
    expect(driver.count).toBe(1);
    expect(lever.userData.setupId).toBe(0x02000ccd);
    expect(lever.userData[STATIC_ANIM_KEY]).toBe(0x03000001);
    const part0 = lever.children[0];
    // AC (x, y, z) → three (x, z, y)
    expect(part0.position.y).toBe(0);
    expect(lever.children[1].position.x).toBe(2);
    driver.update(1 / 30 + 1e-6);
    expect(part0.position.y).toBe(1);
    driver.update(2 / 30);
    expect(part0.position.y).toBe(3);
    driver.update(1 / 30); // wraps back to frame 0
    expect(part0.position.y).toBe(0);
    driver.attach(cell); // re-attach doesn't restart it
    expect(driver.count).toBe(1);
  });

  it('fires the animation hooks on the static (process_hooks)', () => {
    const onHook = vi.fn();
    const driver = new StaticAnimationDriver({ loadAnimation: () => fakeAnim(4), onHook });
    const obj = staticMesh();
    tagStaticDefaultAnimation(obj, 0x020005ac, 0x03000751);
    driver.attach(obj);
    driver.update(2 / 30 + 1e-6); // steps over frames 0 and 1
    expect(onHook).toHaveBeenCalledTimes(1);
    expect(onHook.mock.calls[0][0].hookType).toBe(22);
    expect(onHook.mock.calls[0][1]).toBe(obj);
  });

  it('a step longer than HUGE_QUANTUM does not advance; detach stops the static', () => {
    const driver = new StaticAnimationDriver({ loadAnimation: () => fakeAnim(4) });
    const obj = staticMesh();
    tagStaticDefaultAnimation(obj, 0x02000001, 0x03000001);
    driver.attach(obj);
    driver.update(HUGE_QUANTUM + 0.5);
    expect(obj.children[0].position.y).toBe(0);
    driver.detach(obj);
    expect(driver.count).toBe(0);
    driver.update(1 / 30 + 1e-6);
    expect(obj.children[0].position.y).toBe(0);
  });

  // STATIC.anim-retry-cap — a streamed miss waits for the file's arrival
  // however long it takes (the old 600-update cap gave up after ~10-20 s).
  it('an animation not readable yet (streamed DAT miss) starts once it arrives, even after 1000 updates', async () => {
    let ready = false;
    let arrive!: () => void;
    const animationPending = vi.fn((): Promise<void> | null => new Promise<void>(r => { arrive = r; }));
    const driver = new StaticAnimationDriver({ loadAnimation: () => (ready ? fakeAnim(4) : null), animationPending });
    const obj = staticMesh();
    tagStaticDefaultAnimation(obj, 0x02000001, 0x03000001);
    driver.attach(obj);
    expect(driver.count).toBe(0);
    for (let i = 0; i < 1000; i++) driver.update(1 / 60);
    expect(driver.count).toBe(0);
    expect(animationPending).toHaveBeenCalledTimes(1); // waits, does not poll
    ready = true;
    arrive();
    await new Promise<void>(r => setTimeout(r, 0));
    driver.update(1 / 60);
    expect(driver.count).toBe(1);
    expect(driver.isAnimating(obj)).toBe(true);
  });

  it('an animation known absent (no arrival to wait for) is given up at once; detach drops a waiting one', async () => {
    const loadAnimation = vi.fn(() => null);
    const driver = new StaticAnimationDriver({ loadAnimation, animationPending: () => null });
    const absent = staticMesh();
    tagStaticDefaultAnimation(absent, 0x02000001, 0x03000001);
    driver.attach(absent);
    for (let i = 0; i < 5; i++) driver.update(1 / 60);
    expect(loadAnimation).toHaveBeenCalledTimes(1);

    let arrive!: () => void;
    const ready = { v: false };
    const d2 = new StaticAnimationDriver({
      loadAnimation: () => (ready.v ? fakeAnim(4) : null),
      animationPending: () => new Promise<void>(r => { arrive = r; }),
    });
    const waiting = staticMesh();
    tagStaticDefaultAnimation(waiting, 0x02000001, 0x03000001);
    d2.attach(waiting);
    d2.detach(waiting);
    ready.v = true;
    arrive();
    await new Promise<void>(r => setTimeout(r, 0));
    d2.update(1 / 60);
    expect(d2.isAnimating(waiting)).toBe(false);
  });

  it('StaticScriptDriver forwards every attached / detached tree to it', () => {
    const scripts = new StaticScriptDriver({ play: vi.fn(), stop: vi.fn(), setParticlesVisible: vi.fn() });
    const anims = new StaticAnimationDriver({ loadAnimation: () => fakeAnim(4) });
    scripts.animations = anims;
    const obj = staticMesh();
    tagStaticDefaultAnimation(obj, 0x02000001, 0x03000001);
    scripts.attach(obj);
    expect(anims.isAnimating(obj)).toBe(true);
    scripts.detach(obj);
    expect(anims.isAnimating(obj)).toBe(false);
  });
});

const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const CELL_DAT = resolve(REPO, 'dat/client_cell_1.dat');
const datPresent = existsSync(PORTAL_DAT) && existsSync(CELL_DAT);

describe.skipIf(!datPresent)('EnvCellRenderer — an animated dungeon stab is per-object and loops (needs DAT files)', () => {
  // Cell 0x0007026E holds stab 0x020006B2 (8 parts), DefaultAnimation 0x03000790.
  const CELL = 0x0007026e, SETUP = 0x020006b2, ANIM = 0x03000790;
  let cellMesh: THREE.Group | null = null;
  let loadAnimation: (id: number) => Animation | null = () => null;

  beforeAll(async () => {
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { SceneryInstancer } = await import('../packages/renderer/src/terrain/SceneryInstancer.js');
    const portalDb = openDat(PORTAL_DAT);
    const cellDb = openDat(CELL_DAT);
    const mf = new MaterialFactory(portalDb, new TextureManager(portalDb));
    const mr = new ModelRenderer(portalDb, mf);
    const sr = new SetupModelRenderer(portalDb, mr);
    const ecr = new EnvCellRenderer(portalDb, cellDb, mf, sr, mr);
    // With an instancer wired (the live config) the animated stab must still be per-object.
    ecr.setInstancer(new SceneryInstancer(mr, sr));
    expect(new SceneryInstancer(mr, sr).hasModel(SETUP)).toBe(true); // it would batch it otherwise
    cellMesh = ecr.createCellMesh(CELL);
    loadAnimation = id => sr.loadAnimation(id);
  });

  it('tags the stab with its DefaultAnimation and the driver poses its parts from the DAT frames', () => {
    expect(cellMesh).not.toBeNull();
    const tagged: THREE.Object3D[] = [];
    cellMesh!.traverse(n => { if (n.userData[STATIC_ANIM_KEY] && n.userData.setupId === SETUP) tagged.push(n); });
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged[0].userData[STATIC_ANIM_KEY]).toBe(ANIM);
    const anim = loadAnimation(ANIM)!;
    expect(anim.numFrames).toBeGreaterThan(1);
    const driver = new StaticAnimationDriver({ loadAnimation });
    driver.attach(cellMesh!);
    expect(driver.count).toBe(tagged.length);
    const k = Math.min(5, anim.numFrames - 1);
    driver.update(k / 30 + 1e-6);
    const part0 = tagged[0].children.find(c => c.name === 'part_0')!;
    const f = anim.partFrames[k].frames[0];
    expect(part0.position.x).toBeCloseTo(f.origin.x, 5);
    expect(part0.position.y).toBeCloseTo(f.origin.z, 5);
    expect(part0.position.z).toBeCloseTo(f.origin.y, 5);
  });
});
