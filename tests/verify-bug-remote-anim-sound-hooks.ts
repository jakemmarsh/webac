/**
 * BUG.remote-anim-sound-hooks — remote objects' animation sound hooks
 * (Sound / SoundTweaked / SoundTable: footsteps, swings, growls) never
 * played; only our own character's did (non-positional, from a hardcoded
 * table, plus an invented Attack1 whoosh).
 *
 * Retail (decompiled acclient, reference/client-eol):
 *  - CSequence::execute_hooks → SoundHook::Execute @ 00526a20 /
 *    SoundTweakedHook::Execute @ 00526a80 / SoundTableHook::Execute @ 00526ab0
 *    run on EVERY animating object and play at its position
 *    (SoundManager::PlaySoundInternal @ 00550170, &obj->m_position).
 *  - A SoundTable hook plays from the object's own table only
 *    (PlaySoundA(SoundType, obj) @ 00550b70: none → silence); GetSound
 *    @ 00550680 picks a variant uniformly and PlayProbability @ 005500e0
 *    gates it on the entry's probability.
 *  - GetAttenuation @ 00550020: full volume within VOL_MIN_DIST (5 m),
 *    25·v/d² beyond, dB = ceil(log2(v)·6.0206), not played below VOL_MIN
 *    (−50 dB). The listener is the viewer (SmartBox::set_viewer @ 00452c40).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  retailSoundAttenuation, pickRetailTableSound, resolveAnchorSoundTable, SOUND_TABLE_KEY,
  RETAIL_VOL_MIN_DIST, RETAIL_VOL_MIN_DB,
} from '../packages/renderer/src/audio/RetailSound.js';
import { SoundPlayer } from '../packages/renderer/src/audio/SoundPlayer.js';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { AnimationHookType, type AnimationHook } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';

const PORTAL = resolve(__dirname, '..', 'dat/client_portal.dat');
const hasDat = fs.existsSync(PORTAL);

describe('SoundManager::GetAttenuation (retailSoundAttenuation)', () => {
  it('full volume inside 5 m, inverse-square beyond, dB ceiled', () => {
    expect(RETAIL_VOL_MIN_DIST).toBe(5);
    expect(retailSoundAttenuation(0, 1)).toBe(1);
    expect(retailSoundAttenuation(4.99, 1)).toBe(1);
    // 10 m: 25/100 = 0.25 → log2 = −2 → −12.04 dB → ceil −12 dB.
    expect(retailSoundAttenuation(10, 1)).toBeCloseTo(Math.pow(10, -12 / 20), 9);
    // A quiet variant (volume 0.5) at 2 m: −6.02 dB → −6 dB.
    expect(retailSoundAttenuation(2, 0.5)).toBeCloseTo(Math.pow(10, -6 / 20), 9);
    // Loud variants clamp at 1 before the preference.
    expect(retailSoundAttenuation(1, 3)).toBe(1);
    expect(retailSoundAttenuation(1, 3, 0.5)).toBeCloseTo(Math.pow(10, Math.ceil(Math.log2(0.5) * 6.0206) / 20), 9);
  });

  it('is not played below VOL_MIN (−50 dB) — about 94 m for a full-volume sound; no preference, no sound', () => {
    expect(RETAIL_VOL_MIN_DB).toBe(-50);
    // 94 m: 25/94² → −50.96 dB, ceiled to −50: still played; 95 m → −51.
    expect(retailSoundAttenuation(94, 1)).toBeCloseTo(Math.pow(10, -50 / 20), 9);
    expect(retailSoundAttenuation(95, 1)).toBe(0);
    expect(retailSoundAttenuation(1, 1, 0)).toBe(0);
    expect(retailSoundAttenuation(1, 0)).toBe(0);
  });

  it('SoundPlayer.playPositionalSound never starts a sound retail would cut (no decode, no source)', async () => {
    const createBufferSource = vi.fn();
    const audioManager = { audioContext: { createBufferSource, createGain: vi.fn() }, getCategoryGain: () => null } as never;
    const sp = new SoundPlayer({ getFileData: () => null } as never, audioManager);
    const decode = vi.spyOn(sp, 'decodeWave');
    await sp.playPositionalSound(0x0a000001, { x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(decode).not.toHaveBeenCalled();
    expect(createBufferSource).not.toHaveBeenCalled();
  });
});

describe('SoundManager::GetSound + PlayProbability (pickRetailTableSound)', () => {
  const table = {
    data: new Map([
      [0x10, { unknown: 0, data: [
        { soundId: 0x0a000001, priority: 0, probability: 1, volume: 0.8 },
        { soundId: 0x0a000002, priority: 0, probability: 0.25, volume: 0.6 },
      ] }],
    ]),
  };
  it('picks a variant uniformly, then plays it only when the roll is under its probability', () => {
    const seq = (...v: number[]) => { let i = 0; return () => v[i++]; };
    expect(pickRetailTableSound(table, 0x10, seq(0.2, 0.99))).toEqual({ waveId: 0x0a000001, volume: 0.8 });
    expect(pickRetailTableSound(table, 0x10, seq(0.7, 0.2))).toEqual({ waveId: 0x0a000002, volume: 0.6 });
    expect(pickRetailTableSound(table, 0x10, seq(0.7, 0.3))).toBeNull(); // 0.3 ≥ 0.25
    expect(pickRetailTableSound(table, 0x11, seq(0, 0))).toBeNull(); // no entry
  });

  it('an object with no sound table plays nothing; a DAT static falls back to its Setup default', () => {
    const setupDefault = (id: number) => (id === 0x02000123 ? 0x20000055 : 0);
    expect(resolveAnchorSoundTable({ [SOUND_TABLE_KEY]: 0, setupId: 0x02000123 }, setupDefault)).toBe(0);
    expect(resolveAnchorSoundTable({ [SOUND_TABLE_KEY]: 0x20000001, setupId: 0x02000123 }, setupDefault)).toBe(0x20000001);
    expect(resolveAnchorSoundTable({ setupId: 0x02000123 }, setupDefault)).toBe(0x20000055);
    expect(resolveAnchorSoundTable({}, setupDefault)).toBe(0);
  });
});

describe('the object hook path', () => {
  it('executeHook plays a Sound hook at the OBJECT\'s world position against the viewer listener', () => {
    const playPositionalSound = vi.fn().mockResolvedValue(undefined);
    const player = new PhysicsScriptPlayer({
      spellEffects: {} as never, soundPlayer: { playPositionalSound } as never, loadEmitterInfo: () => null,
      getListenerPos: () => ({ x: 7, y: 8, z: 9 }),
    });
    const creature = new THREE.Group();
    creature.position.set(40, 2, 60);
    creature.updateMatrixWorld(true);
    player.executeHook({ hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0a000123 } as never, creature);
    expect(playPositionalSound).toHaveBeenCalledWith(0x0a000123, { x: 40, y: 2, z: 60 }, { x: 7, y: 8, z: 9 }, 'effects', 1);
  });

  // SWEEP1006 hook volume — PlaySoundA(DID, obj) @ 00550730 plays the wave AT
  // effect_sound_volume; GetAttenuation multiplies by it again.
  it('a raw-wave Sound hook plays at the effects preference as its own volume (heard at the preference squared)', () => {
    const playPositionalSound = vi.fn().mockResolvedValue(undefined);
    const player = new PhysicsScriptPlayer({
      spellEffects: {} as never, soundPlayer: { playPositionalSound, effectsVolume: 0.5 } as never, loadEmitterInfo: () => null,
      getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    });
    const o = new THREE.Group();
    o.updateMatrixWorld(true);
    player.executeHook({ hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0a000124 } as never, o);
    expect(playPositionalSound.mock.calls[0][3]).toBe('effects');
    expect(playPositionalSound.mock.calls[0][4]).toBe(0.5);
    expect(retailSoundAttenuation(1, 0.5, 0.5)).toBeCloseTo(retailSoundAttenuation(1, 0.25, 1), 6);
  });
});

describe.skipIf(!hasDat)('a remote drudge running: its run-cycle SoundTable hooks play at its position (needs DAT)', () => {
  let portalDb: { getFileData(id: number): ArrayBuffer | null };
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const buf = fs.readFileSync(PORTAL);
    portalDb = new DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer) as never;
  });

  /** An InterpretedMotionState movement event: NonCombat stance, forward command at `speed`. */
  function moveEvent(guid: number, forward: number, speed: number): { guid: number; movementData: Uint8Array } {
    const STANCE = 0x8000003d;
    const buf = new Uint8Array(6 + 4 + 4 + 2 + 2 + 4);
    const v = new DataView(buf.buffer);
    v.setUint16(8, STANCE & 0xffff, true);
    v.setUint32(10, 0x1 | 0x2 | 0x4, true);
    v.setUint16(14, STANCE & 0xffff, true);
    v.setUint16(16, forward & 0xffff, true);
    v.setFloat32(18, speed, true);
    return { guid, movementData: buf };
  }

  it('Drudge (wcid 7089: setup 0x020007DD, motion 0x09000008, sounds 0x20000007) — Walk1 hooks resolve to a wave in its own table', async () => {
    const { SoundTable } = await import('../packages/dat-parser/src/file-types/SoundTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const scene = new THREE.Scene();
    const som = new ServerObjectManager({} as never, {} as never, scene as never);
    som.setPortalDb(portalDb as never);
    const group = new THREE.Group();
    for (let i = 0; i < 34; i++) { const p = new THREE.Object3D(); p.name = `part_${i}`; group.add(p); }
    group.position.set(30, 0, 30);
    group.userData[SOUND_TABLE_KEY] = 0x20000007;
    scene.add(group);
    scene.updateMatrixWorld(true);
    const GUID = 0x50000099;
    (som as unknown as { tryInitAnimation(o: object): void }).tryInitAnimation({ guid: GUID, mesh: group, setupId: 0x020007DD, motionTableId: 0x09000008 });
    expect(som.getAnimated(GUID)).toBeTruthy();

    const table = SoundTable.read(new DatReader(portalDb.getFileData(0x20000007)!));
    const played: Array<{ anchor: THREE.Object3D; type: number; pos: { x: number; y: number; z: number }; wave: number | null }> = [];
    const player = new PhysicsScriptPlayer({
      spellEffects: {} as never, soundPlayer: {} as never, loadEmitterInfo: () => null,
      getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
      playSoundTableSound: (anchor, type, pos) => {
        const tableId = resolveAnchorSoundTable(anchor.userData, () => 0);
        played.push({ anchor, type, pos, wave: tableId === 0x20000007 ? (pickRetailTableSound(table, type, () => 0)?.waveId ?? null) : null });
      },
    });
    // main.ts's wiring: every object's animation hooks go through the object path.
    som.onAnimationHook = (_g, hook, anchor) => player.executeHook(hook, anchor);
    som.handleMovementEvent(moveEvent(GUID, 0x0007 /* RunForward */, 1.0) as never);
    for (let t = 0; t < 3; t += 1 / 60) { som.updateAnimations(1 / 60); group.updateMatrixWorld(true); }

    expect(played.length).toBeGreaterThan(0);
    expect(played.every((p) => p.anchor === group)).toBe(true);
    // Positional: at the creature, not the listener.
    expect(played[0].pos.x).toBeCloseTo(30, 0);
    expect(played[0].pos.z).toBeCloseTo(30, 0);
    // Every hook resolves to a real wave in the object's own table (the run
    // cycle's Walk1, 0x39 → 0x0A000167).
    expect(played.every((p) => p.type === 0x39)).toBe(true);
    expect(played.every((p) => p.wave === 0x0a000167)).toBe(true);
  });

  it('the human table 0x20000001 has no Footstep1/2 entries: a running human is silent (GetSound finds nothing)', async () => {
    const { SoundTable } = await import('../packages/dat-parser/src/file-types/SoundTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const human = SoundTable.read(new DatReader(portalDb.getFileData(0x20000001)!));
    expect(pickRetailTableSound(human, 0x37, () => 0)).toBeNull();
    expect(pickRetailTableSound(human, 0x38, () => 0)).toBeNull();
  });
});
