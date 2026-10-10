/**
 * ScreenGamma — the retail Config "Screen Brightness" slider as the swap-chain
 * gamma ramp it really is (CORE.17.q.a.a).
 *
 * Ground truth (decompiled EoL client, acclient.exe .rdata):
 *
 * `RenderDeviceD3D::SetGamma(float pref, bool calibrate)` @ 005a0b70 —
 *   pref = clamp(pref, -0.2f (.rdata 0x7e57b8), 1.0f (0x7928b0)), stored in
 *   m_gammaBrightnessVal (this+0x7f4); then for i in 0..255:
 *     ramp[i] = clamp(i*255 - _ftol2(float(i*255) * pref * -2.0f (.rdata 0x7e57b4)), 0, 0xffff)
 *   (the same WORD written to the red / green / blue tables), and
 *   IDirect3DDevice9::SetGammaRamp(0, calibrate && D3DCAPS2_CANCALIBRATEGAMMA
 *   (Caps2 bit 20) ? D3DSGR_CALIBRATE : D3DSGR_NO_CALIBRATION, &ramp).
 *   So the ramp is the LINEAR multiply  i*255 * (1 + 2*pref)  on the encoded
 *   8-bit output value, clamped at full scale: +1.0 = 3x (every value >= 86
 *   saturates), -0.2 = 0.6x (the floor — the slider's -1..-0.2 half is flat).
 * `Render::UpdateFromPreferences` @ 0054d850 (:325048 / :325079) calls it with
 *   Render_ScreenBrightness (default 0, range -1..1 — UIPreferences ::2965)
 *   only when the value CHANGED (Current_Render_ScreenBrightness), so at the
 *   default the device's own identity ramp stays installed; the ramp is
 *   re-applied on OnDeviceDisplayModeChange @ 005a1a90 from m_gammaBrightnessVal.
 * D3D9 applies a swap-chain gamma ramp to the WHOLE back buffer — the DAT-drawn
 *   HUD included — and only in full-screen exclusive mode (Display_FullScreen
 *   defaults ON in retail). Ours cannot be full-screen without a user gesture
 *   (CORE.17.h.f), so the ramp is modelled on the whole frame regardless of the
 *   browser's fullscreen state: a windowed browser tab is the stand-in for
 *   retail's default fullscreen presentation, not for its windowed mode.
 *
 * A CSS `brightness(f)` filter is the same operation — a per-channel linear
 * multiply of the sRGB-encoded value, clamped to [0, 1] (Filter Effects §
 * feComponentTransfer type="linear"; the shorthand functions operate in sRGB).
 */

/** SetGamma's lower clamp on the preference (.rdata 0x7e57b8 = -0.2f). */
export const RETAIL_GAMMA_PREF_MIN = -0.2;
/** SetGamma's upper clamp on the preference (.rdata 0x7928b0 = 1.0f). */
export const RETAIL_GAMMA_PREF_MAX = 1.0;
/** The ramp's preference multiplier (.rdata 0x7e57b4 = -2.0f): ramp = i*255 - ftol(i*255*pref*-2). */
export const RETAIL_GAMMA_PREF_SCALE = -2.0;
/** The per-entry step of retail's ramp (i*255, not the DAC-identity i*257). */
export const RETAIL_GAMMA_RAMP_STEP = 255;

/** SetGamma's clamp of the pref before it is stored / used. */
export function clampScreenBrightnessPref(pref: number): number {
  const p = Number.isFinite(pref) ? pref : 0;
  return Math.max(RETAIL_GAMMA_PREF_MIN, Math.min(RETAIL_GAMMA_PREF_MAX, p));
}

/** _ftol2: float → int, truncation toward zero. */
function ftol(v: number): number {
  return Math.trunc(Math.fround(v));
}

/**
 * The 256-entry D3DGAMMARAMP SetGamma builds (one channel; R = G = B), exactly
 * as the loop @ 005a0bd0 computes it in single precision.
 */
export function retailGammaRamp(pref: number): Uint16Array {
  const p = Math.fround(clampScreenBrightnessPref(pref));
  const ramp = new Uint16Array(256);
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    const scaled = Math.fround(Math.fround(acc * p) * RETAIL_GAMMA_PREF_SCALE);
    let v = acc - ftol(scaled);
    if (v < 0) v = 0; else if (v > 0xffff) v = 0xffff;
    ramp[i] = v;
    acc += RETAIL_GAMMA_RAMP_STEP;
  }
  return ramp;
}

/**
 * The ramp's linear factor on the encoded output value: 1 + 2·clamp(pref).
 * 0 → 1 (identity), +1 → 3, −0.2 (and every value below) → 0.6.
 */
export function screenBrightnessFactor(pref: number): number {
  return 1 - RETAIL_GAMMA_PREF_SCALE * clampScreenBrightnessPref(pref);
}

/**
 * The CSS filter for the whole frame: '' at the retail default (retail never
 * installs a ramp until the pref changes — the device identity stays), else
 * brightness(1 + 2·pref).
 */
export function screenBrightnessFilter(pref: number): string {
  const f = screenBrightnessFactor(pref);
  return Math.abs(f - 1) < 1e-9 ? '' : `brightness(${f.toFixed(3)})`;
}
