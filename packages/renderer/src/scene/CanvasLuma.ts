/**
 * BUG.dungeon-login-black (The Tower, end of retail, 2026-11-07) — what the world canvas showed.
 *
 * Four logins into the dungeon 0x5950 sent first_minute events that said the world was drawn (worldDrawnMs
 * 6-8 s, ~475 draw calls and 10-13k triangles a frame, no errors, no lost context) while the player saw a
 * black world. Nothing in the event could tell a black frame from a lit one. This reads the canvas back once
 * every few seconds, right after a world render (in the same task, so the WebGL buffer still holds the
 * frame without preserveDrawingBuffer, as SceneManager.captureNextFrame does): a LUMA_SAMPLE_W × LUMA_SAMPLE_H
 * drawImage downscale, 576 pixels, its mean luma and its share of dark pixels (WorldReporter lumaStats).
 * The HUD is DOM, never on this canvas, so the numbers are the world's alone.
 */
import { LUMA_SAMPLE_H, LUMA_SAMPLE_W, lumaStats, type LumaSample } from '../telemetry/WorldReporter.js';

/** The 2D canvas the downscale is drawn into (a DOM canvas in the page, a stub in tests). */
export interface LumaScratch {
  width: number;
  height: number;
  getContext(kind: '2d', opts?: { willReadFrequently?: boolean }): {
    drawImage(src: unknown, x: number, y: number, w: number, h: number): void;
    getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
  } | null;
}

/** The luma of `src` (the WebGL canvas) through `scratch`; null when it has no size or cannot be read (a tainted or lost canvas). */
export function sampleCanvasLuma(src: { width: number; height: number } | null | undefined, scratch: LumaScratch): LumaSample | null {
  if (!src || !(src.width > 0) || !(src.height > 0)) return null;
  try {
    if (scratch.width !== LUMA_SAMPLE_W) scratch.width = LUMA_SAMPLE_W;
    if (scratch.height !== LUMA_SAMPLE_H) scratch.height = LUMA_SAMPLE_H;
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0, LUMA_SAMPLE_W, LUMA_SAMPLE_H);
    return lumaStats(ctx.getImageData(0, 0, LUMA_SAMPLE_W, LUMA_SAMPLE_H).data);
  } catch {
    return null;
  }
}
