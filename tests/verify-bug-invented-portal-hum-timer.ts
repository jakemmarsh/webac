/**
 * BUG.invented-portal-hum-timer — main.ts played wave 0x0A00009C at full
 * volume every 3 s near any purple-radar object. Retail has no such timer:
 * a portal hums from its own Setup DefaultScript.
 *
 * Why the invented timer existed: our SoundTweaked parser used ACE's field
 * names, which swap probability and priority. Retail SoundTweakedHook::UnPack
 * @ 00527780 (and ::Pack @ 00527730) is gid, PROB, prio, vol; the ctor
 * (@ 00526a40) defaults prio 0.9. Read ACE's way, the 220 hooks whose second
 * float is 0 — every portal's hum among them — never played.
 *
 * DAT (portal 2072): the portal setup 0x020001B3 (1991 portal weenies) has
 * DefaultScript 0x3300067A — two emitters, SoundTweaked 0x0A00038E
 * (prob 1, prio 0, vol 0.05), then at 2.7 s CallPES 0x330006DA, which
 * repeats the hum and calls itself every 2.7 s.
 */
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Object3D } from 'three';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { readAnimationHook, AnimationHookType, type SoundTweakedHookData, type CallPESHookData } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import type { PhysicsScript } from '../packages/dat-parser/src/file-types/PhysicsScript.js';
import { openDat } from './_harness/dat.js';

const PORTAL = resolve(__dirname, '..', 'dat/client_portal.dat');
const hasDat = existsSync(PORTAL);

describe('SoundTweakedHook::UnPack field order (gid, probability, priority, volume)', () => {
  it('reads the first float as the probability and the second as the priority', () => {
    const buf = new ArrayBuffer(24);
    const v = new DataView(buf);
    v.setUint32(0, AnimationHookType.SoundTweaked, true);
    v.setInt32(4, 0, true);
    v.setUint32(8, 0x0a00038e, true);
    v.setFloat32(12, 0.25, true); // probability
    v.setFloat32(16, 0.9, true);  // priority (the ctor default)
    v.setFloat32(20, 0.05, true); // volume
    const h = readAnimationHook(new DatReader(buf)) as SoundTweakedHookData;
    expect(h.soundId).toBe(0x0a00038e);
    expect(h.probability).toBeCloseTo(0.25, 6);
    expect(h.priority).toBeCloseTo(0.9, 6);
    expect(h.volume).toBeCloseTo(0.05, 6);
  });
});

describe.skipIf(!hasDat)('the portal hum is the portal\'s own DefaultScript (needs DAT)', () => {
  const scripts = new Map<number, PhysicsScript>();
  let defaultScript = 0;
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel.js');
    const { PhysicsScript: PS } = await import('../packages/dat-parser/src/file-types/PhysicsScript.js');
    const db = openDat(PORTAL);
    defaultScript = new SetupModel(new DatReader(db.getFileData(0x020001b3)!)).defaultScript;
    for (const id of [0x3300067a, 0x330006da]) scripts.set(id, PS.read(new DatReader(db.getFileData(id)!)));
  });
  afterEach(() => vi.useRealTimers());

  it('setup 0x020001B3 → DefaultScript 0x3300067A: hum 0x0A00038E, always (prob 1), at volume 0.05, looping every 2.7 s', () => {
    expect(defaultScript).toBe(0x3300067a);
    for (const id of [0x3300067a, 0x330006da]) {
      const steps = scripts.get(id)!.steps;
      const hum = steps.find((s) => s.hook?.hookType === AnimationHookType.SoundTweaked)!.hook as SoundTweakedHookData;
      expect(hum.soundId).toBe(0x0a00038e);
      expect(hum.probability).toBe(1);
      expect(hum.priority).toBe(0);
      expect(hum.volume).toBeCloseTo(0.05, 6);
      const call = steps.find((s) => s.hook?.hookType === AnimationHookType.CallPES)!;
      expect(call.startTime).toBeCloseTo(2.7, 6);
      expect((call.hook as CallPESHookData).pes).toBe(0x330006da);
    }
  });

  it('PhysicsScriptPlayer plays it AT the portal, at 0.05, and again 2.7 s later', () => {
    const playPositionalSound = vi.fn().mockResolvedValue(undefined);
    const player = new PhysicsScriptPlayer({
      spellEffects: { spawnParticleEffect: vi.fn() } as never,
      soundPlayer: { playPositionalSound } as never,
      loadEmitterInfo: () => null,
      loadScript: (id: number) => scripts.get(id) ?? null,
      getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    });
    const portal = new Object3D();
    portal.position.set(12, 3, -40);
    portal.updateMatrixWorld(true);
    player.play(scripts.get(0x3300067a)!, portal);
    expect(playPositionalSound).toHaveBeenCalledTimes(1);
    const [wave, at, , , vol] = playPositionalSound.mock.calls[0];
    expect(wave).toBe(0x0a00038e);
    expect(at).toEqual({ x: 12, y: 3, z: -40 });
    expect(vol).toBeCloseTo(0.05, 6);
    player.update(2.8);
    expect(playPositionalSound).toHaveBeenCalledTimes(2);
    expect(playPositionalSound.mock.calls[1][0]).toBe(0x0a00038e);
  });
});
