/**
 * VISUAL3.68 — Config "Sound Options" section, rebuilt to the retail EoL
 * layout (options-config.jpg): a "Sound Features" dropdown + per-category
 * green-bullet sliders (Sound Effects → 'effects', Ambient Sounds →
 * 'ambient', Interface Sounds → 'ui') + a "Play Sounds Only When Active"
 * checkbox. The old Master/Music/Effects `addVolumeRow` prompt() rows are
 * gone (retail shows no Master/Music rows here).
 *
 * BEHAVIORAL (per the no-source-grep rule): this drives the REAL units the
 * sliders consume — `AudioManager` category volume/mute — and the REAL
 * `GameUI.OPTIONS_DEFAULTS` static, instead of regex-matching GameUI source.
 * (Supersedes the FAITHFUL.433/.439 source-text pins that froze the old
 * three-volume-row layout.)
 */
import { describe, it, expect } from 'vitest';
import { AudioManager } from '../packages/renderer/src/audio/AudioManager.js';
import { GameUI } from '../packages/renderer/src/ui/GameUI.js';

describe('VISUAL3.68 — Sound category sliders drive the audio graph', () => {
  it('each Config sound slider maps to its AudioManager category', () => {
    const am = new AudioManager();
    // Sound Effects slider → 'effects', Ambient Sounds → 'ambient'
    // (applySoundCategories). DECOMP.volume-pref-routing — the Interface
    // Sounds slider is unread in retail; the 'ui' node is still a category.
    am.setCategoryVolume('effects', 0.5);
    am.setCategoryVolume('ambient', 0.25);
    am.setCategoryVolume('ui', 0.75);
    expect(am.getCategoryVolume('effects')).toBeCloseTo(0.5);
    expect(am.getCategoryVolume('ambient')).toBeCloseTo(0.25);
    expect(am.getCategoryVolume('ui')).toBeCloseTo(0.75);
  });

  it('volume is clamped to [0,1] (percentage slider / 100)', () => {
    const am = new AudioManager();
    am.setCategoryVolume('effects', 2.0);
    expect(am.getCategoryVolume('effects')).toBe(1);
    am.setCategoryVolume('effects', -1);
    expect(am.getCategoryVolume('effects')).toBe(0);
  });

  it('the green bullet toggles category mute (Sound Effects / Ambient / Interface)', () => {
    const am = new AudioManager();
    expect(am.isCategoryMuted('effects')).toBe(false);
    am.setCategoryMuted('effects', true);   // bullet off
    expect(am.isCategoryMuted('effects')).toBe(true);
    am.setCategoryMuted('effects', false);  // bullet on
    expect(am.isCategoryMuted('effects')).toBe(false);
  });
});

describe('VISUAL3.68/.69/.70 — Config defaults exist with correct types', () => {
  const D = GameUI.OPTIONS_DEFAULTS;

  it('Sound Options keys', () => {
    expect(D.soundFeatures).toBe('Stereo');
    expect(typeof D.ambientVolume).toBe('number');
    expect(typeof D.interfaceVolume).toBe('number');
    expect(typeof D.playSoundsOnlyWhenActive).toBe('boolean');
  });

  it('Camera Options keys', () => {
    expect(typeof D.cameraStiffness).toBe('number');
    expect(typeof D.cameraAdjustmentSpeed).toBe('number');
    expect(D.fieldOfView).toBe(90);
    expect(typeof D.alignCameraToSlope).toBe('boolean');
  });

  it('Graphics Options keys', () => {
    expect(typeof D.fullScreen).toBe('boolean');
    expect(typeof D.syncWithRefreshRate).toBe('boolean');
    expect(typeof D.screenBrightness).toBe('number');
    expect(typeof D.adaptiveDegrade).toBe('boolean');
    expect(typeof D.adaptiveDegradeBias).toBe('number');
  });

  it('volume slider defaults sit in their 0..100 range (Sound_*Volume SetPreferenceRange 0..1, SetDefaultValue(1.0))', () => {
    for (const k of ['ambientVolume', 'interfaceVolume', 'effectsVolume']) {
      const v = D[k] as number;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('CORE.17.h.f — Config slider defaults sit inside their RETAIL SetPreferenceRange, not a 0..100 percent', () => {
    const R = GameUI.CONFIG_SLIDER_RANGES;
    for (const k of ['cameraStiffness', 'cameraAdjustmentSpeed', 'fieldOfView', 'screenBrightness', 'adaptiveDegradeBias'] as const) {
      const v = D[k] as number;
      expect(v, k).toBeGreaterThanOrEqual(R[k].min);
      expect(v, k).toBeLessThanOrEqual(R[k].max);
    }
    // The pre-fix 0..100 midpoint defaults are gone: 50 is outside two of
    // the retail ranges outright and none of the retail defaults is 50.
    expect(D.cameraStiffness).not.toBe(50);
    expect(D.screenBrightness).not.toBe(50);
    expect(D.adaptiveDegradeBias).not.toBe(50);
  });
});
