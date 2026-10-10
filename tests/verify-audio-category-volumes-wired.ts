/**
 * VISUAL3.68 — "Play Sounds Only When Active" gate + per-category volume.
 *
 * The Config sound section drives the live `AudioManager` category model:
 *  - Each per-category slider sets that category's gain (effects/ambient/ui).
 *  - Category mute/unmute (the enable check boxes). "Play Sounds Only When
 *    Active" no longer mutes categories: it is SoundPlayer.canStartSounds
 *    (DECOMP.sound-voice-limit, verify-decomp-sound-voices-prefs.ts).
 *
 * BEHAVIORAL (per the no-source-grep rule): drives the real AudioManager
 * instead of regex-matching the old addVolumeRow source. Supersedes the
 * FAITHFUL.439 source-text pins (the merged effects→ambient+ui row is gone;
 * each category now has its own slider per options-config.jpg).
 */
import { describe, it, expect } from 'vitest';
import { AudioManager } from '../packages/renderer/src/audio/AudioManager.js';

const ALL = ['effects', 'ambient', 'ui', 'music'] as const;

describe('VISUAL3.68 — activity gate mutes/unmutes every category', () => {
  it('inactive → all four categories muted', () => {
    const am = new AudioManager();
    for (const c of ALL) am.setCategoryMuted(c, true);   // window blurred
    for (const c of ALL) expect(am.isCategoryMuted(c)).toBe(true);
  });

  it('active → all four categories unmuted', () => {
    const am = new AudioManager();
    for (const c of ALL) am.setCategoryMuted(c, true);
    for (const c of ALL) am.setCategoryMuted(c, false);  // window focused
    for (const c of ALL) expect(am.isCategoryMuted(c)).toBe(false);
  });

  it('mute does NOT clobber the stored category volume (unmute restores it)', () => {
    const am = new AudioManager();
    am.setCategoryVolume('effects', 0.6);
    am.setCategoryMuted('effects', true);
    expect(am.getCategoryVolume('effects')).toBeCloseTo(0.6); // value preserved while muted
    am.setCategoryMuted('effects', false);
    expect(am.getCategoryVolume('effects')).toBeCloseTo(0.6);
  });

  it('the four default categories exist on a fresh AudioManager', () => {
    const am = new AudioManager();
    for (const c of ALL) expect(am.getCategoryVolume(c)).toBe(1.0);
  });
});
