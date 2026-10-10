/**
 * VISUAL.dat-static-default-scripts — DAT static objects (LandBlockInfo
 * objects, EnvCell stabs) run their Setup's DefaultScript.
 *
 * Retail: CPartArray::InitDefaults @ 00518980 → CPhysicsObj::InitDefaults
 * @ 005139d0 → play_script_internal(setup->default_script_id) for EVERY
 * physics object, statics included. The Holtburg Dungeon (0x01F6) wall
 * sconces 0x020001eb carry DefaultScript 0x3300000b: flame emitter
 * 0x3200002f at (0, -0.11, 0.40), glow 0x32000141 at t=1, then the
 * 0x330003cc crackle loop — all offsets in the sconce's own frame.
 *
 * Pins: the StaticScriptDriver starts each tagged static once it is in the
 * scene (from the frame loop), stops it when its tree is detached, and keeps
 * its emitters drawn exactly while the static is (hidden cell / ring block /
 * tree removed from the scene); PhysicsScriptPlayer composes emitter offsets
 * with the anchor's orientation and hides emitters born on a hidden anchor;
 * EnvCellRenderer tags the real Holtburg Dungeon sconce stabs (DAT).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StaticScriptDriver, tagStaticScriptAnchor, STATIC_SCRIPT_KEY } from '../packages/renderer/src/world/StaticScriptDriver.js';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { AnimationHookType } from '@ac/dat-parser';
import type { PhysicsScript } from '@ac/dat-parser';
import { openDat } from './_harness/dat.js';

function makeDriver() {
  const play = vi.fn();
  const stop = vi.fn();
  const setParticlesVisible = vi.fn();
  return { driver: new StaticScriptDriver({ play, stop, setParticlesVisible }), play, stop, setParticlesVisible };
}

describe('StaticScriptDriver — lifecycle', () => {
  it('starts every tagged static in an attached tree on the next sync, once', () => {
    const { driver, play } = makeDriver();
    const scene = new THREE.Scene();
    const cell = new THREE.Group();
    const torch = new THREE.Object3D();
    const chair = new THREE.Object3D();
    tagStaticScriptAnchor(torch, 0x020001eb, 0x3300000b);
    cell.add(torch, chair);
    scene.add(cell);
    driver.attach(cell);
    expect(play).not.toHaveBeenCalled(); // not inside the time-budgeted load step
    driver.sync();
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith(0x3300000b, torch);
    expect(torch.userData.setupId).toBe(0x020001eb);
    expect(driver.count).toBe(1);
    expect(driver.owns(torch)).toBe(true);
    expect(driver.owns(chair)).toBe(false);
    driver.attach(cell);
    driver.sync();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('detach stops running statics and drops ones that never started', () => {
    const { driver, play, stop } = makeDriver();
    const scene = new THREE.Scene();
    const a = new THREE.Object3D(); tagStaticScriptAnchor(a, 0x02000001, 0x33000001);
    const b = new THREE.Object3D(); tagStaticScriptAnchor(b, 0x02000002, 0x33000002);
    scene.add(a, b);
    driver.attach(a);
    driver.sync();
    driver.attach(b);
    driver.detach(a);
    driver.detach(b);
    driver.sync();
    expect(play).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(a);
    expect(driver.count).toBe(0);
  });

  it("emitters follow the static's effective visibility: hidden cell, then a tree off the scene", () => {
    const { driver, setParticlesVisible } = makeDriver();
    const scene = new THREE.Scene();
    const cell = new THREE.Group();
    const torch = new THREE.Object3D();
    tagStaticScriptAnchor(torch, 0x020001eb, 0x3300000b);
    cell.add(torch);
    scene.add(cell);
    driver.attach(cell);
    driver.sync();
    expect(setParticlesVisible).not.toHaveBeenCalled();
    cell.visible = false; // portal / PVS gated
    driver.sync();
    expect(setParticlesVisible).toHaveBeenLastCalledWith(torch, false);
    driver.sync();
    expect(setParticlesVisible).toHaveBeenCalledTimes(1); // only on change
    cell.visible = true;
    driver.sync();
    expect(setParticlesVisible).toHaveBeenLastCalledWith(torch, true);
    scene.remove(cell); // e.g. the dungeon group leaving the scene
    driver.sync();
    expect(setParticlesVisible).toHaveBeenLastCalledWith(torch, false);
  });

  it('a static starting hidden starts with hidden emitters', () => {
    const { driver, play, setParticlesVisible } = makeDriver();
    const scene = new THREE.Scene();
    const cell = new THREE.Group();
    cell.visible = false;
    const torch = new THREE.Object3D();
    tagStaticScriptAnchor(torch, 0x020001eb, 0x3300000b);
    cell.add(torch);
    scene.add(cell);
    driver.attach(cell);
    driver.sync();
    expect(play).toHaveBeenCalledTimes(1);
    expect(setParticlesVisible).toHaveBeenCalledWith(torch, false);
  });
});

function makeScript(id: number, steps: Array<{ t: number; hook: object }>): PhysicsScript {
  return { id, steps: steps.map(s => ({ startTime: s.t, hook: s.hook as never })) } as never;
}

function makePlayer() {
  const systems: Array<{ object3D: THREE.Object3D; pos: { x: number; y: number; z: number } }> = [];
  const spawnParticleEffect = vi.fn((_info: unknown, pos: { x: number; y: number; z: number }) => {
    const s = { object3D: new THREE.Object3D(), pos };
    systems.push(s);
    return s;
  });
  const removeParticleSystem = vi.fn();
  const player = new PhysicsScriptPlayer({
    spellEffects: { spawnParticleEffect, removeParticleSystem } as never,
    soundPlayer: { playPositionalSound: vi.fn().mockResolvedValue(undefined) } as never,
    // Endless (the torch flame 0x3200002f: totalSeconds 0, totalParticles 0).
    loadEmitterInfo: (id: number) => ({ id, hwGfxObjId: 0x01000001, lifespan: 2, lifespanRand: 0, totalSeconds: 0, totalParticles: 0 } as never),
    getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
  });
  return { player, systems, removeParticleSystem };
}

const flame = (t: number, x: number, y: number, z: number) => ({
  t,
  hook: {
    hookType: AnimationHookType.CreateParticle, direction: 0, emitterInfoId: 0x3200002f, partIndex: 0,
    offset: { origin: { x, y, z }, orientation: { w: 1, x: 0, y: 0, z: 0 } }, emitterId: 0,
  },
});

describe('FX.static-script-never-retried — a streamed DefaultScript starts on arrival', () => {
  const flush = () => new Promise<void>(r => setTimeout(r, 0));

  it('a static whose script is not resident waits, then plays once it lands', async () => {
    const play = vi.fn();
    let arrive!: () => void;
    const scriptPending = vi.fn((): Promise<void> | null => new Promise<void>(r => { arrive = r; }));
    const driver = new StaticScriptDriver({ play, stop: vi.fn(), setParticlesVisible: vi.fn(), scriptPending });
    const scene = new THREE.Scene();
    const torch = new THREE.Object3D(); tagStaticScriptAnchor(torch, 0x020001eb, 0x3300000b);
    scene.add(torch);
    driver.attach(torch);
    driver.sync();
    expect(scriptPending).toHaveBeenCalledWith(0x3300000b);
    expect(play).not.toHaveBeenCalled(); // nothing to play yet
    expect(driver.owns(torch)).toBe(true);
    expect(driver.count).toBe(0);
    arrive();
    await flush();
    driver.sync();
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith(0x3300000b, torch);
    expect(driver.count).toBe(1);
    expect(scriptPending).toHaveBeenCalledTimes(1); // not asked again after arrival
  });

  it('a static that left the scene while waiting does not start', async () => {
    const play = vi.fn();
    let arrive!: () => void;
    const driver = new StaticScriptDriver({
      play, stop: vi.fn(), setParticlesVisible: vi.fn(),
      scriptPending: () => new Promise<void>(r => { arrive = r; }),
    });
    const torch = new THREE.Object3D(); tagStaticScriptAnchor(torch, 0x020001eb, 0x3300000b);
    driver.attach(torch);
    driver.sync();
    driver.detach(torch);
    arrive();
    await flush();
    driver.sync();
    expect(play).not.toHaveBeenCalled();
    expect(driver.owns(torch)).toBe(false);
  });

  it('a failed fetch falls through to one plain play', async () => {
    const play = vi.fn();
    const scriptPending = vi.fn(() => Promise.reject(new Error('fetch failed')));
    const driver = new StaticScriptDriver({ play, stop: vi.fn(), setParticlesVisible: vi.fn(), scriptPending });
    const torch = new THREE.Object3D(); tagStaticScriptAnchor(torch, 0x020001eb, 0x3300000b);
    driver.attach(torch);
    driver.sync();
    await flush();
    driver.sync();
    expect(play).toHaveBeenCalledTimes(1);
    expect(scriptPending).toHaveBeenCalledTimes(1);
  });
});

describe('PhysicsScriptPlayer — emitter offsets live in the object frame', () => {
  it("rotates the sconce flame's (0, -0.11, 0.40) offset by the anchor's yaw", () => {
    const { player, systems } = makePlayer();
    const anchor = new THREE.Object3D();
    anchor.position.set(10, 2, 20);
    // AC 90° yaw about z (w = z = √½) → three (-x, -z, -y, w).
    anchor.quaternion.set(0, -Math.SQRT1_2, 0, Math.SQRT1_2);
    anchor.updateMatrixWorld(true);
    player.play(makeScript(0x3300000b, [flame(0, 0, -0.11, 0.4)]), anchor);
    expect(systems).toHaveLength(1);
    const p = systems[0].pos;
    // AC offset (0, -0.11) yawed 90° CCW → (+0.11, 0); three x = AC x, three z = AC y.
    expect(p.x).toBeCloseTo(10.11, 5);
    expect(p.y).toBeCloseTo(2.4, 5);
    expect(p.z).toBeCloseTo(20, 5);
  });

  it('an unrotated anchor keeps the plain swizzled offset', () => {
    const { player, systems } = makePlayer();
    const anchor = new THREE.Object3D();
    anchor.position.set(1, 2, 3);
    player.play(makeScript(1, [flame(0, 0.5, -0.25, 0.4)]), anchor);
    expect(systems[0].pos.x).toBeCloseTo(1.5, 5);
    expect(systems[0].pos.y).toBeCloseTo(2.4, 5);
    expect(systems[0].pos.z).toBeCloseTo(2.75, 5);
  });
});

describe('PhysicsScriptPlayer — hidden anchors draw no particles', () => {
  it('toggles the endless emitters and hides ones born while hidden', () => {
    const { player, systems } = makePlayer();
    const anchor = new THREE.Object3D();
    player.play(makeScript(0x3300000b, [flame(0, 0, 0, 0.4), flame(1, 0, 0, 0.45)]), anchor);
    expect(systems).toHaveLength(1);
    player.setAnchorParticlesVisible(anchor, false);
    expect(systems[0].object3D.visible).toBe(false);
    player.update(1.1); // the glow emitter (t=1) is born while hidden
    expect(systems).toHaveLength(2);
    expect(systems[1].object3D.visible).toBe(false);
    player.setAnchorParticlesVisible(anchor, true);
    expect(systems.every(s => s.object3D.visible)).toBe(true);
  });

  it('countActive filters the running scripts by anchor', () => {
    const { player } = makePlayer();
    const a = new THREE.Object3D();
    const b = new THREE.Object3D();
    player.play(makeScript(1, [flame(0, 0, 0, 0), flame(5, 0, 0, 0)]), a);
    player.play(makeScript(2, [flame(0, 0, 0, 0), flame(5, 0, 0, 0)]), b);
    expect(player.activeCount).toBe(2);
    expect(player.countActive(x => x !== a)).toBe(1);
  });
});

const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const CELL_DAT = resolve(REPO, 'dat/client_cell_1.dat');
const datPresent = existsSync(PORTAL_DAT) && existsSync(CELL_DAT);

describe.skipIf(!datPresent)('EnvCellRenderer — Holtburg Dungeon sconces are script anchors (needs DAT files)', () => {
  let cellMesh: THREE.Group | null = null;
  let cellId = 0;
  let sconceCount = 0;

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { EnvCell } = await import('../packages/dat-parser/src/file-types/EnvCell.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const portalDb = openDat(PORTAL_DAT);
    const cellDb = openDat(CELL_DAT);
    // The first 0x01F6 cell holding a 0x020001eb wall sconce.
    for (let idx = 0x100; idx < 0x100 + 429 && !cellId; idx++) {
      const data = cellDb.getFileData((0x01f60000 | idx) >>> 0);
      if (!data) continue;
      const n = new EnvCell(new DatReader(data)).staticObjects.filter(s => s.id === 0x020001eb).length;
      if (n > 0) { cellId = (0x01f60000 | idx) >>> 0; sconceCount = n; }
    }
    const mf = new MaterialFactory(portalDb, new TextureManager(portalDb));
    const mr = new ModelRenderer(portalDb, mf);
    const sr = new SetupModelRenderer(portalDb, mr);
    cellMesh = new EnvCellRenderer(portalDb, cellDb, mf, sr, mr).createCellMesh(cellId);
  });

  it('tags each 0x020001eb stab with DefaultScript 0x3300000b and the driver starts it in the scene', () => {
    expect(cellId).not.toBe(0);
    expect(cellMesh).not.toBeNull();
    const anchors: THREE.Object3D[] = [];
    cellMesh!.traverse(n => { if (n.userData[STATIC_SCRIPT_KEY] && n.userData.setupId === 0x020001eb) anchors.push(n); });
    expect(anchors).toHaveLength(sconceCount);
    for (const a of anchors) expect(a.userData[STATIC_SCRIPT_KEY]).toBe(0x3300000b);
    const play = vi.fn();
    const driver = new StaticScriptDriver({ play, stop: vi.fn(), setParticlesVisible: vi.fn() });
    const scene = new THREE.Scene();
    scene.add(cellMesh!);
    driver.attach(cellMesh!);
    driver.sync();
    expect(play.mock.calls.filter(c => c[0] === 0x3300000b)).toHaveLength(sconceCount);
  });
});
