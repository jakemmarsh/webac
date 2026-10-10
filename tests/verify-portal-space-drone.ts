/**
 * The portal-space drone: the tunnel animation's own sound hook.
 *
 * Retail (decompiled EoL client): gmSmartBoxUI::UseTime @ 004d6e30 plays the
 * teleport object's Animation 0x030005AC with set_sequence_animation at 40
 * fps, and its CSequence runs the animation's hooks like any object's. Frame
 * 2 carries a SoundTweaked hook — Wave 0x0A000316 (3.01 s), prob 1, vol 0.3
 * — so each 3 s loop restarts the wave: a continuous drone between
 * Sound_UI_EnterPortal and Sound_UI_ExitPortal. SoundTweakedHook::Execute
 * @ 00526a80 → SoundManager::PlaySoundA(gid, obj, prio, prob, vol) @ 005507a0.
 * Ours stepped the frames itself and never ran the hooks: portal space was
 * silent after the entry whoosh.
 *
 * Drives the shipped PortalSpaceRenderer (THREE's WebGLRenderer swapped for a
 * stub — node has no WebGL) with a synthetic animation, and checks the real
 * DAT's hook.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import { AnimationHookType, type AnimationHook } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';

vi.mock('three', async (importOriginal) => {
  const THREE = await importOriginal<typeof import('three')>();
  class StubRenderer {
    domElement = { style: {}, dataset: {} } as unknown as HTMLCanvasElement;
    setSize(): void {}
    setPixelRatio(): void {}
    setClearColor(): void {}
    render(): void {}
    dispose(): void {}
    forceContextLoss(): void {}
  }
  return { ...THREE, WebGLRenderer: StubRenderer };
});

const ANIM_ID = 0x030005ac;

/** A 0-part, 120-frame animation: a SoundTweaked hook on frame 2, a backward-only Sound hook on frame 5. */
function syntheticAnimation(): ArrayBuffer {
  const words: Array<['u' | 'i' | 'f', number]> = [['u', ANIM_ID], ['u', 0], ['u', 0], ['u', 120]];
  for (let f = 0; f < 120; f++) {
    if (f === 2) {
      // type, direction Both, gid, prob, prio, vol (SoundTweakedHook::UnPack order)
      words.push(['u', 1], ['u', AnimationHookType.SoundTweaked], ['i', 0], ['u', 0x0a000316], ['f', 1], ['f', 1], ['f', 0.3]);
    } else if (f === 5) {
      words.push(['u', 1], ['u', AnimationHookType.Sound], ['i', -1], ['u', 0x0a000999]);
    } else {
      words.push(['u', 0]);
    }
  }
  const dv = new DataView(new ArrayBuffer(words.length * 4));
  words.forEach(([t, v], i) => {
    if (t === 'u') dv.setUint32(i * 4, v >>> 0, true);
    else if (t === 'i') dv.setInt32(i * 4, v, true);
    else dv.setFloat32(i * 4, v, true);
  });
  return dv.buffer;
}

describe('PortalSpaceRenderer runs the tunnel animation\'s hooks', () => {
  beforeAll(() => {
    (globalThis as unknown as { window: unknown }).window ??= { devicePixelRatio: 1 };
  });

  async function make(): Promise<{ r: import('../packages/renderer/src/effects/PortalSpaceRenderer.js').PortalSpaceRenderer; fired: AnimationHook[]; setNow: (ms: number) => void }> {
    const { PortalSpaceRenderer } = await import('../packages/renderer/src/effects/PortalSpaceRenderer.js');
    const buf = syntheticAnimation();
    const db = { getFileData: (id: number) => (id === ANIM_ID ? buf : null) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = new PortalSpaceRenderer(800, 600, null, db as any);
    let now = 0;
    r.clock = () => now;
    const fired: AnimationHook[] = [];
    r.onHook = (h) => fired.push(h);
    r.startAnimation(0);
    return { r, fired, setNow: (ms) => { now = ms; } };
  }

  it('a frame\'s hooks fire as the loop steps past it — once per 3 s loop', async () => {
    const { r, fired, setNow } = await make();
    setNow(70); r.render(); // frame 2 still current (2.8 frames)
    expect(fired).toHaveLength(0);
    setNow(80); r.render(); // stepped past frame 2
    expect(fired).toHaveLength(1);
    expect(fired[0].hookType).toBe(AnimationHookType.SoundTweaked);
    setNow(2999); r.render();
    expect(fired).toHaveLength(1);
    setNow(3080); r.render(); // the next loop's frame 2
    expect(fired).toHaveLength(2);
    setNow(6080); r.render();
    setNow(9080); r.render(); // two more loops
    expect(fired).toHaveLength(4);
  });

  it('backward-only hooks never fire on the forward loop', async () => {
    const { r, fired, setNow } = await make();
    setNow(3000); r.render();
    expect(fired.map((h) => h.hookType)).toEqual([AnimationHookType.SoundTweaked]);
  });

  it('a long stall (hidden tab) runs one loop\'s hooks, not the backlog; a restart begins at frame 0', async () => {
    const { r, fired, setNow } = await make();
    setNow(100_000); r.render();
    expect(fired).toHaveLength(1);
    r.startAnimation(100_000);
    setNow(100_040); r.render(); // frame 1: frame 2 not left yet
    expect(fired).toHaveLength(1);
    setNow(100_080); r.render();
    expect(fired).toHaveLength(2);
  });
});

describe('portalSpaceHookSound — how a tunnel hook plays', () => {
  it('SoundTweaked: PlayProbability, then its wave at its own volume', async () => {
    const { portalSpaceHookSound } = await import('../packages/renderer/src/effects/PortalSpaceRenderer.js');
    const hook = { hookType: AnimationHookType.SoundTweaked, direction: 0, soundId: 0x0a000316, priority: 1, probability: 0.5, volume: 0.3 } as AnimationHook;
    expect(portalSpaceHookSound(hook, 0.8, () => 0.2)).toEqual({ waveId: 0x0a000316, volume: 0.3 });
    expect(portalSpaceHookSound(hook, 0.8, () => 0.7)).toBeNull();
  });
  it('Sound: the wave at the effect-volume preference; SoundTable (no table on the object) is silent', async () => {
    const { portalSpaceHookSound } = await import('../packages/renderer/src/effects/PortalSpaceRenderer.js');
    expect(portalSpaceHookSound({ hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0a000001 } as AnimationHook, 0.8))
      .toEqual({ waveId: 0x0a000001, volume: 0.8 });
    expect(portalSpaceHookSound({ hookType: AnimationHookType.SoundTable, direction: 0, soundType: 5 } as AnimationHook, 0.8)).toBeNull();
  });
});

describe.skipIf(!fs.existsSync(DAT_PATHS.portal))('real DAT: the tunnel animation carries the drone', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  beforeAll(() => { db = openDat(DAT_PATHS.portal); });

  it('frame 2 of 0x030005AC: SoundTweaked Wave 0x0A000316 at vol 0.3, prob 1; no other hooks', async () => {
    const { Animation } = await import('../packages/dat-parser/src/file-types/Animation.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { portalSpaceHookSound } = await import('../packages/renderer/src/effects/PortalSpaceRenderer.js');
    const anim = new Animation(new DatReader(db.getFileData(ANIM_ID)));
    const hooked = anim.partFrames.flatMap((f, i) => f.hooks.map((h) => ({ i, h })));
    expect(hooked).toHaveLength(1);
    expect(hooked[0].i).toBe(2);
    expect(portalSpaceHookSound(hooked[0].h, 1, () => 0.999)).toEqual({ waveId: 0x0a000316, volume: expect.closeTo(0.3, 6) });
  });

  it('the wave outlasts the 3 s loop (120 frames / 40 fps), so the drone is continuous', async () => {
    const { Wave } = await import('../packages/dat-parser/src/file-types/Wave.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const w = new Wave(new DatReader(db.getFileData(0x0a000316)));
    const bytesPerSec = new DataView(w.header.buffer, w.header.byteOffset, w.header.byteLength).getUint32(8, true);
    expect(w.data.byteLength / bytesPerSec).toBeGreaterThanOrEqual(3.0);
  });
});
