/**
 * FramerateMeter — the retail `@framerate` FPS meter as a pure model.
 *
 * Ported from the decompiled EoL client (reference/client-eol, build
 * ac1_sep13); full spec with decomp line numbers in
 * docs/retail-commands/framerate-meter.md.
 *
 *  - **Measurement** — `SceneTool::UpdateFPSCounter @ 0043e510`, called at
 *    the end of every `SceneTool::EndFrame` (after the flip). It keeps the
 *    last 20 frame times in `m_LastFrameTimes` (float[20], zeroed at init),
 *    FIRST computes `m_FramesPerSecond = 20 / sum` (0 unless the sum exceeds
 *    F_EPSILON 0.0002), THEN shifts the ring and stores
 *    `now - m_LastFlipTime` as the newest sample. So the rate read during
 *    frame N excludes frame N-1's own duration. `m_LastFlipTime` starts at
 *    0 (bss), so the very first sample is the whole time since the clock's
 *    epoch; it ages out after 20 frames. Sums and samples are float32.
 *  - **Display** — `gmSmartBoxUI::UpdateFPSMeter @ 004d63a0`, run every
 *    frame from `gmSmartBoxUI::UseTime` while the meter is shown (no
 *    throttle). StringInfo `ID_SmartBox_FPS` (table enum 0x10000001 =
 *    StringTable 0x23000001): fragments "FPS: ", "\nDEG: ", "" with
 *    variables `fps` = Render::GetFramerate() and `deg` =
 *    (Render::auto_update_deg_mul ? Render::deg_mul :
 *    Render::s_rUserSuppliedDegradeBias), both AddVariable_Float precision 2
 *    (truncated, grouped, see formatStringInfoFloat).
 *  - **Toggle** — `ClientCommunicationSystem::DoFrameRate` flips the
 *    function-static `fShowFramerate` (bss: starts false, never persisted)
 *    and calls `CM_UI::SendNotice_SetFramerateDisplay`;
 *    `gmSmartBoxUI::RecvNotice_SetFramerateDisplay @ 004d65e0` shows
 *    element 0x10000047 (layout 0x2100000f) after one immediate update, or
 *    hides it.
 */

import { acStringHash, getStringPartsFromTable } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { formatStringInfoFloat } from './LinkStatusPanelText.js';

/** SceneTool::m_LastFrameTimes length (float[20], globals.tsv). */
export const FPS_SAMPLE_COUNT = 20;
/** F_EPSILON (0.0002): the frame-time sum must exceed it for a non-zero rate. */
export const FPS_SUM_EPSILON = 0.0002;
/** AddVariable_Float precision for both `fps` and `deg` (`push 2`). */
export const FPS_VARIABLE_PRECISION = 2;

/** StringInfo table enum 0x10000001 → client_local_English StringTable 0x23000001. */
export const FPS_STRING_TABLE = 0x23000001;
/** compute_str_hash("ID_SmartBox_FPS") = 231735155. */
export const FPS_STRING_ID = acStringHash('ID_SmartBox_FPS');
/** Verbatim DAT fragments of ID_SmartBox_FPS (escapes undone) — fallback when the table isn't loaded. */
export const FPS_TEMPLATE_FALLBACK: readonly string[] = Object.freeze(['FPS: ', '\nDEG: ', '']);

/** Layout 0x2100000f (gameplay screen): the 3D view element gmSmartBoxUI (class 0x10000014). */
export const SMARTBOX_LAYOUT_ID = 0x2100000f;
export const SMARTBOX_ELEMENT_ID = 0x10000037;
/**
 * The meter text element: UIElement_Text (type 0xc) child of 0x10000037 at
 * (0,0) 128x36, edges 1,1,2,2 (pinned top-left, fixed size), p59 Hidden,
 * font 0x4000001a, colour 0xFFFFFFFF, p33 outline (default black),
 * p20 = 2 / p21 = 4 (left / top), margins p35 = 2 (left) / p37 = 2 (top).
 */
export const FPS_ELEMENT_ID = 0x10000047;
export const FPS_ELEMENT_RECT = Object.freeze({ x: 0, y: 0, width: 128, height: 36 });
export const FPS_FONT_ID = 0x4000001a;
export const FPS_TEXT_COLOR_ARGB = 0xffffffff;
export const FPS_OUTLINE_COLOR_ARGB = 0xff000000;
export const FPS_MARGIN_LEFT = 2;
export const FPS_MARGIN_TOP = 2;

/** The ID_SmartBox_FPS fragments from the DAT, else the verbatim fallback. */
export function framerateMeterTemplate(): readonly string[] {
  return getStringPartsFromTable(FPS_STRING_TABLE, FPS_STRING_ID) ?? FPS_TEMPLATE_FALLBACK;
}

/** StringInfo::GetString for the meter: fragments interleaved with the fps then deg values. */
export function formatFramerateText(parts: readonly string[], fps: number, deg: number): string {
  const vars = [formatStringInfoFloat(fps, FPS_VARIABLE_PRECISION), formatStringInfoFloat(deg, FPS_VARIABLE_PRECISION)];
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i < parts.length - 1) out += vars[i] ?? '';
  }
  return out;
}

export class FramerateMeter {
  /** SceneTool::m_LastFrameTimes — newest first. */
  private readonly samples = new Float32Array(FPS_SAMPLE_COUNT);
  /** SceneTool::m_LastFlipTime (double, bss 0). */
  private lastFlipTime = 0;
  /** SceneTool::m_FramesPerSecond. */
  private fps = 0;
  /** gmSmartBoxUI::m_pFPSDisplay != null. */
  private _shown = false;

  constructor(private readonly parts: readonly string[] = FPS_TEMPLATE_FALLBACK) {}

  /**
   * SceneTool::UpdateFPSCounter — call once per rendered frame, after the
   * frame is presented, with a monotonic clock in seconds.
   */
  frame(nowSeconds: number): void {
    let sum = 0;
    for (let i = 0; i < FPS_SAMPLE_COUNT; i++) sum = Math.fround(sum + this.samples[i]);
    this.fps = sum > FPS_SUM_EPSILON ? Math.fround(FPS_SAMPLE_COUNT / sum) : 0;
    this.samples.copyWithin(1, 0, FPS_SAMPLE_COUNT - 1);
    this.samples[0] = nowSeconds - this.lastFlipTime;
    this.lastFlipTime = nowSeconds;
  }

  /** Render::GetFramerate — the rate as of the last frame() call (also what Render::CalcDegLevel reads). */
  get framesPerSecond(): number {
    return this.fps;
  }

  /** RecvNotice_SetFramerateDisplay(on). */
  setShown(on: boolean): void {
    this._shown = on;
  }

  get shown(): boolean {
    return this._shown;
  }

  /**
   * gmSmartBoxUI::UpdateFPSMeter — the element text for this frame, or null
   * while hidden. Retail refreshes it every UseTime (each frame) and on show.
   * `degradeBias` = auto_update_deg_mul ? deg_mul : s_rUserSuppliedDegradeBias
   * (our DegradeLod.bias).
   */
  text(degradeBias: number): string | null {
    if (!this._shown) return null;
    return formatFramerateText(this.parts, this.fps, degradeBias);
  }
}
