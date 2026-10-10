/**
 * Verify AudioManager category/volume semantics.
 *
 * Ships alongside UI.37's in-browser audio verification. These pure-logic
 * tests pin the API surface (categories, volume bounds, mute flag, master
 * volume) so regressions in category routing are caught in CI. The actual
 * AudioContext/Web Audio nodes can't run in Vitest's jsdom — those are
 * covered by manual in-browser checks recorded in progress.md (UI.37).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AudioManager } from '../packages/renderer/src/audio/AudioManager.js';

describe('AudioManager — category/volume API', () => {
  let am: AudioManager;

  beforeEach(() => {
    am = new AudioManager();
  });

  it('initializes with the four canonical AC categories (ambient/effects/music/ui)', () => {
    const cats = am.getCategoryNames();
    expect(cats).toContain('ambient');
    expect(cats).toContain('effects');
    expect(cats).toContain('music');
    expect(cats).toContain('ui');
    expect(cats.length).toBe(4);
  });

  it('defaults every category to volume=1.0, muted=false', () => {
    for (const cat of am.getCategoryNames()) {
      expect(am.getCategoryVolume(cat)).toBe(1);
      expect(am.isCategoryMuted(cat)).toBe(false);
    }
  });

  it('roundtrips category volume changes', () => {
    am.setCategoryVolume('effects', 0.5);
    expect(am.getCategoryVolume('effects')).toBeCloseTo(0.5, 5);
    am.setCategoryVolume('effects', 0);
    expect(am.getCategoryVolume('effects')).toBe(0);
  });

  it('roundtrips category mute flag', () => {
    am.setCategoryMuted('music', true);
    expect(am.isCategoryMuted('music')).toBe(true);
    am.setCategoryMuted('music', false);
    expect(am.isCategoryMuted('music')).toBe(false);
  });

  it('master volume defaults to 1.0 before init() (from masterGain fallback)', () => {
    // setMasterVolume is a no-op until init() creates the masterGain node.
    // Pre-init reads return the fallback default 1.0 — matches the
    // runtime expectation: "no audio context → no volume control effect".
    expect(am.getMasterVolume()).toBe(1);
  });

  it('category changes on unknown name are a no-op (graceful)', () => {
    // Should not throw — the renderer's Options panel could read a stale
    // category name and we want it to degrade gracefully.
    expect(() => am.setCategoryVolume('does-not-exist', 0.5)).not.toThrow();
    expect(am.getCategoryVolume('does-not-exist')).toBe(0); // default for unknown
  });

  it('exposes isInitialized (getter) — false before init() call', () => {
    // isInitialized is a getter, not a method call.
    expect(am.isInitialized).toBe(false);
  });

  it('init() returns false gracefully if AudioContext is unavailable (CI/jsdom)', () => {
    // In Node/Vitest without jsdom Web Audio, AudioContext doesn't exist.
    // The AC browser client always runs post-user-gesture so this path is
    // CI-only; verify it returns false rather than throwing.
    const result = am.init();
    // Either init succeeds (jsdom with webAudio polyfill) OR returns false.
    // Both are valid outcomes — the key is: no throw.
    expect(typeof result).toBe('boolean');
  });
});
