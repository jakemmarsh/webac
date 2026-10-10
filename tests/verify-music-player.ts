/**
 * GAP.4 / GAP.83 — MusicPlayer behavioral coverage (replaces the forbidden
 * source-text pin this file used to be — CLAUDE.md bans readFileSync+regex
 * tests; convert on touch).
 *
 * Faithfulness notes:
 * - GAP.4 (2026-07-05): retail AC1 deliberately had NO in-game background
 *   music (contemporary reviews; the team's decompiled-client survey found
 *   no music system in the EoL client — recorded in
 *   docs/gap-reconciliation-2026-06-12.md). The invented FAITHFUL.204/208
 *   automatic cues were removed from main.ts — MusicPlayer remains ONLY as
 *   debug tooling (acDebug.music).
 * - GAP.83 (2026-07-22): the prior /music/<hex>.wav fetch side-channel
 *   (requiring a user-populated, non-reproducible local directory) is gone.
 *   MusicPlayer now takes an injected waveLoader — main.ts wires it to
 *   soundPlayer.decodeWave, the same portal.dat Wave -> AudioBuffer pipeline
 *   SFX uses. These tests drive the real class with a stubbed
 *   AudioManager + waveLoader: correct wave id is requested, buffer-cache
 *   invariant, already-playing idempotence, and failure paths.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MusicPlayer } from '../packages/renderer/src/audio/MusicPlayer.js';

function makeFakeCtx() {
  return {
    currentTime: 0,
    destination: {},
    createGain: () => ({
      gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createBufferSource: () => ({
      buffer: null, loop: false,
      connect: vi.fn(), start: vi.fn(), stop: vi.fn(),
      onended: null,
    }),
  };
}

describe('GAP.4/GAP.83 — MusicPlayer behavior (debug-only tooling, DAT-backed)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ctx: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let player: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let waveLoader: any;

  beforeEach(() => {
    ctx = makeFakeCtx();
    waveLoader = vi.fn(async (_waveId: number) => ({ duration: 1 } as never));
    player = new MusicPlayer({ audioContext: ctx, getCategoryGain: () => null } as never, waveLoader);
  });

  it('decodes the requested wave id via the injected waveLoader', async () => {
    const ok = await player.loadAndPlay(0x0a000560);
    expect(ok).toBe(true);
    expect(waveLoader).toHaveBeenCalledWith(0x0a000560);
  });

  it('caches the decoded buffer — repeat play after stop does not re-decode', async () => {
    await player.loadAndPlay(0x0a000560);
    player.stop();
    await player.loadAndPlay(0x0a000560);
    expect(waveLoader).toHaveBeenCalledTimes(1);
  });

  it('already-playing same track is a no-decode no-op returning true', async () => {
    await player.loadAndPlay(0x0a000560);
    const again = await player.loadAndPlay(0x0a000560);
    expect(again).toBe(true);
    expect(waveLoader).toHaveBeenCalledTimes(1);
  });

  it('returns false without an AudioContext', async () => {
    const noCtx = new MusicPlayer({ audioContext: null, getCategoryGain: () => null } as never, waveLoader);
    expect(await (noCtx as never as { loadAndPlay(id: number): Promise<boolean> }).loadAndPlay(0x0a000560)).toBe(false);
    expect(waveLoader).not.toHaveBeenCalled();
  });

  it('returns false on a wave id absent from the DAT, without throwing', async () => {
    waveLoader.mockImplementationOnce(async () => null);
    expect(await player.loadAndPlay(0x0a0000ff)).toBe(false);
  });
});
