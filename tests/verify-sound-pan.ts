/**
 * RECON.ambient-sound-weighting.pan — retail's positional stereo pan.
 *
 * `SoundManager::PlaySoundInternal(SoundBufRef*, Position*, float, int)`
 * @ 00550170, operands read from the acclient.exe disassembly:
 *   angle = fmod(heading(sound → viewer) − viewer heading, 360), > 180 → −360;
 *   if |(long)distance| >= 5: pan = (long)(sin(angle · π/180f) · −15);
 * skipped when s_SoundFeatures == 1 (Mono). `SoundBuf::Play` @ 00552d50
 * clamps ±15 and calls IDirectSoundBuffer::SetPan(pan × 100) (hundredths
 * of a dB: + turns the left channel down).
 */
import { describe, it, expect } from 'vitest';
import {
  retailCompassHeading,
  retailSoundPan,
  retailPanGains,
  RETAIL_PAN_SCALE,
  RETAIL_PAN_MIN_DIST,
} from '../packages/renderer/src/audio/RetailSound.js';
import { SoundPlayer } from '../packages/renderer/src/audio/SoundPlayer.js';
import { AmbientSoundManager, type AmbientPlay } from '../packages/renderer/src/audio/AmbientSoundManager.js';
import type { SoundDesc } from '@ac/dat-parser/file-types/RegionDesc.js';

describe('Position::heading / Frame::get_heading — compass degrees', () => {
  it('0 = north (+y), 90 = east (+x), clockwise; a too-small offset is 0', () => {
    expect(retailCompassHeading(0, 1)).toBeCloseTo(0, 9);
    expect(retailCompassHeading(1, 0)).toBeCloseTo(90, 9);
    expect(retailCompassHeading(0, -1)).toBeCloseTo(180, 9);
    expect(retailCompassHeading(-1, 0)).toBeCloseTo(270, 9);
    expect(retailCompassHeading(1, 1)).toBeCloseTo(45, 9);
    expect(retailCompassHeading(0, 0)).toBe(0);
  });
});

describe('PlaySoundInternal pan', () => {
  it('uses the disassembly constants: −15 scale, 5 m gate', () => {
    expect(RETAIL_PAN_SCALE).toBe(-15);
    expect(RETAIL_PAN_MIN_DIST).toBe(5);
  });

  it('a sound to the viewer\'s right pans right, to the left pans left (facing north)', () => {
    // Sound 20 m east: the offset TO the viewer is (−20, 0).
    // sin(−90° in float π/180) is just short of −1, so retail truncates to 14.
    expect(retailSoundPan(-20, 0, 20, 0)).toBe(14);
    expect(retailSoundPan(20, 0, 20, 0)).toBe(-14);
  });

  it('a sound straight ahead or behind plays centred', () => {
    expect(retailSoundPan(0, -20, 20, 0)).toBe(0); // ahead (north)
    expect(retailSoundPan(0, 20, 20, 0)).toBe(0);  // behind
  });

  it('follows the viewer heading: facing east, a sound to the north is on the left', () => {
    expect(retailSoundPan(0, -30, 30, 90)).toBe(-14);
    expect(retailSoundPan(0, 30, 30, 90)).toBe(14);
    // Heading wrap: facing 350°, a sound due east is 100° to the right.
    expect(retailSoundPan(-30, 0, 30, 350)).toBe(Math.trunc(Math.sin(-100 * Math.fround(Math.PI / 180)) * -15));
    expect(retailSoundPan(-30, 0, 30, 350)).toBe(14);
  });

  it('diagonal: 45° right of ahead truncates sin·15 toward zero (10, not 11)', () => {
    // Facing north, sound NE: offset to the viewer (−21.2, −21.2).
    expect(retailSoundPan(-21.2, -21.2, 30, 0)).toBe(10);
    expect(retailSoundPan(21.2, -21.2, 30, 0)).toBe(-10);
  });

  it('the 5.0 gate is on the distance in whole metres, not the angle', () => {
    expect(retailSoundPan(-4.99, 0, 4.99, 0)).toBe(0);
    expect(retailSoundPan(-5, 0, 5, 0)).toBe(14);
    // A 3° offset still pans (pan = trunc(sin 3° · 15) = 0 here, but 10° does).
    expect(retailSoundPan(-Math.sin(10 * Math.PI / 180) * 50, -Math.cos(10 * Math.PI / 180) * 50, 50, 0)).toBe(2);
  });

  it('SetPan(pan × 100) turns the far channel down by |pan| dB', () => {
    expect(retailPanGains(0)).toEqual({ left: 1, right: 1 });
    const r = retailPanGains(10);
    expect(r.right).toBe(1);
    expect(r.left).toBeCloseTo(Math.pow(10, -0.5), 12);
    const l = retailPanGains(-14);
    expect(l.left).toBe(1);
    expect(l.right).toBeCloseTo(Math.pow(10, -14 / 20), 12);
  });
});

/** A recording AudioContext: nodes with a type tag and their connections. */
function fakeContext() {
  const nodes: Array<{ kind: string; gain?: { value: number }; out: Array<{ to: unknown; output?: number; input?: number }> }> = [];
  const node = (kind: string, extra: Record<string, unknown> = {}) => {
    const n = {
      kind, out: [] as Array<{ to: unknown; output?: number; input?: number }>, ...extra,
      connect(to: unknown, output?: number, input?: number) { n.out.push({ to, output, input }); return to; },
    };
    nodes.push(n as never);
    return n;
  };
  const ctx = {
    destination: node('destination'),
    createBufferSource: () => node('source', { start() {}, stop() {}, addEventListener() {} }),
    createGain: () => node('gain', { gain: { value: 1 } }),
    createChannelSplitter: () => node('splitter'),
    createChannelMerger: () => node('merger'),
  };
  return { ctx, nodes };
}

function rigPlayer() {
  const { ctx, nodes } = fakeContext();
  const audio = {
    audioContext: ctx,
    getCategoryGain: () => null,
    isCategoryMuted: () => false,
    getCategoryVolume: () => 1,
  };
  const player = new SoundPlayer({} as never, audio as never);
  player.decodeWave = async () => ({}) as AudioBuffer;
  return { player, nodes };
}

describe('SoundPlayer.playPositionalSound pans through the audio graph', () => {
  it('a sound to the right is heard with the LEFT channel turned down (merger input 0)', async () => {
    const { player, nodes } = rigPlayer();
    // three.js coords: x east, z north. Sound 20 m east of a north-facing viewer.
    await player.playPositionalSound(0x0a000001, { x: 20, y: 0, z: 0 }, { x: 0, y: 0, z: 0, heading: 0 });
    const merger = nodes.find((n) => n.kind === 'merger');
    expect(merger).toBeDefined();
    const intoMerger = nodes.filter((n) => n.out.some((c) => c.to === merger));
    const left = intoMerger.find((n) => n.out.some((c) => c.to === merger && c.input === 0))!;
    const right = intoMerger.find((n) => n.out.some((c) => c.to === merger && c.input === 1))!;
    expect(left.gain!.value).toBeCloseTo(Math.pow(10, -14 / 20), 12);
    expect(right.gain!.value).toBe(1);
  });

  it('plays unpanned (no splitter) inside 5 m, with no listener heading, or in Mono', async () => {
    for (const run of [
      (p: SoundPlayer) => p.playPositionalSound(1, { x: 4, y: 0, z: 0 }, { x: 0, y: 0, z: 0, heading: 0 }),
      (p: SoundPlayer) => p.playPositionalSound(1, { x: 20, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
      (p: SoundPlayer) => { p.stereo = false; return p.playPositionalSound(1, { x: 20, y: 0, z: 0 }, { x: 0, y: 0, z: 0, heading: 0 }); },
    ]) {
      const { player, nodes } = rigPlayer();
      await run(player);
      expect(nodes.some((n) => n.kind === 'source')).toBe(true);
      expect(nodes.some((n) => n.kind === 'splitter')).toBe(false);
    }
  });
});

describe('AmbientSoundManager pans an intermittent sound by its bearing from the viewer', () => {
  function seq(...values: number[]): () => number {
    let i = 0;
    return () => (i < values.length ? values[i++] : 0);
  }
  function rig(stereo: boolean, heading: number) {
    const pans: number[] = [];
    const player = {
      stereo,
      loadSoundTable: () => ({ resolveSound: (t: number) => ({ waveId: 0x0a000000 + t, volume: 1 }) }),
      playSound: (_w: number, _c: string, _g: number, _s: string, pan = 0) => { pans.push(pan); return Promise.resolve(null); },
      levelThroughCategory: (amp: number) => amp,
    } as never;
    const audio = { isInitialized: true, isRunning: true, getCategoryVolume: () => 1 } as never;
    // Rolls: PlayNow 0, direction 0, heading 0.5 (no jitter), distance r = 1.
    const mgr = new AmbientSoundManager(player, audio, seq(0, 0, 0.5, 1, 0, 0));
    mgr.viewerHeading = () => heading;
    const plays: AmbientPlay[] = [];
    mgr.onPlay = (p) => plays.push(p);
    mgr.loadFromSoundDesc({
      stbDesc: [{ stbId: 0x20000002, ambientSounds: [{ sType: 2, volume: 1, baseChance: 0.8, minRate: 5, maxRate: 5 }] }],
    } as never as SoundDesc);
    // Only vertex 40 m east → the sound plays 50 m east of the listener.
    mgr.applyNeighbourhood([{ stbIndex: 0, dx: 40, dy: 0, dz: 0 }]);
    return { plays, pans };
  }

  it('facing north, an eastern sound plays on the right', () => {
    const { plays, pans } = rig(true, 0);
    expect(plays).toHaveLength(1);
    expect(plays[0].dx).toBeCloseTo(50, 9);
    expect(plays[0].pan).toBe(14);
    expect(pans).toEqual([14]);
  });

  it('facing south, the same sound plays on the left; facing east, centred', () => {
    expect(rig(true, 180).plays[0].pan).toBe(-14);
    expect(rig(true, 90).plays[0].pan).toBe(0);
  });

  it('Sound Features Mono plays it centred', () => {
    const { plays, pans } = rig(false, 0);
    expect(plays[0].pan).toBe(0);
    expect(pans).toEqual([0]);
  });
});

describe('Config "Sound Features" drives SoundPlayer.stereo (s_SoundFeatures)', () => {
  it('Stereo (the default) pans; Mono turns the pan off; back to Stereo turns it on', async () => {
    const { mountGameUI } = await import('./_harness/gameui.js');
    const { AudioManager } = await import('../packages/renderer/src/audio/AudioManager.js');
    const H = await mountGameUI();
    try {
      const player = { stereo: true, playOnlyWhenActive: true };
      H.ui.soundPlayer = player;
      H.ui.audioManager = new AudioManager();
      H.ui.applySoundCategories();
      expect(player.stereo).toBe(true);
      H.ui.optionsSettings.soundFeatures = 'Mono';
      H.ui.applySoundCategories();
      expect(player.stereo).toBe(false);
      H.ui.optionsSettings.soundFeatures = 'Stereo';
      H.ui.applySoundCategories();
      expect(player.stereo).toBe(true);
    } finally {
      H.teardown();
    }
  });
});
