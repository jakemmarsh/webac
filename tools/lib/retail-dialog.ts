/**
 * retail-dialog — find the buttons of a retail confirmation dialog in a frame
 * of the real client (tools/probe-two-client-retail-ab.ts). The retail client
 * under Wine exposes no element tree, so a harness that must answer its
 * dialogs locates the buttons by colour.
 */
import type { PNG } from 'pngjs';

/** Retail's dialog buttons are a dark-red face (about rgb(120,0,0)) inside a gold rim. */
const isButtonRed = (r: number, g: number, b: number): boolean => r >= 90 && r <= 200 && g <= 40 && b <= 40;

/**
 * The centre of the leftmost dialog button (Yes) in a retail frame, or null.
 * Searches the middle of the screen, where DialogFactory centres its
 * confirmations, for connected button-red regions at least 40x14 px; the
 * health bar and other red HUD pieces sit outside that box or are too thin.
 */
export function retailYesButton(png: PNG): { x: number; y: number } | null {
  const { width: w, height: h, data } = png;
  const x0 = Math.floor(w * 0.25), x1 = Math.floor(w * 0.75), y0 = Math.floor(h * 0.2), y1 = Math.floor(h * 0.8);
  const seen = new Uint8Array(w * h);
  const red = (x: number, y: number): boolean => { const i = (y * w + x) * 4; return isButtonRed(data[i], data[i + 1], data[i + 2]); };
  const boxes: { x0: number; y0: number; x1: number; y1: number; n: number }[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (seen[y * w + x] || !red(x, y)) continue;
      const box = { x0: x, y0: y, x1: x, y1: y, n: 0 };
      const stack = [[x, y]];
      seen[y * w + x] = 1;
      while (stack.length) {
        const [cx, cy] = stack.pop()!;
        box.n++;
        box.x0 = Math.min(box.x0, cx); box.x1 = Math.max(box.x1, cx); box.y0 = Math.min(box.y0, cy); box.y1 = Math.max(box.y1, cy);
        for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1 || seen[ny * w + nx] || !red(nx, ny)) continue;
          seen[ny * w + nx] = 1;
          stack.push([nx, ny]);
        }
      }
      const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
      // A button face is mostly filled; a scattered red texture is not.
      if (bw >= 40 && bh >= 14 && bh <= 60 && box.n >= bw * bh * 0.5) boxes.push(box);
    }
  }
  if (!boxes.length) return null;
  boxes.sort((a, b) => a.x0 - b.x0);
  const b = boxes[0];
  return { x: Math.round((b.x0 + b.x1) / 2), y: Math.round((b.y0 + b.y1) / 2) };
}

