/**
 * BUG.ui-text-blank-iosurface-exhaustion (2026-10-03): 2D canvases default to
 * CPU backing (`willReadFrequently: true`).
 *
 * Chrome on macOS backs each accelerated 2D canvas with an IOSurface. The UI
 * draws its bitmap-font text into many small canvases and makes new ones as
 * text changes (vitals tick every few seconds; raising stats re-renders rows),
 * so live and not-yet-collected canvases pile up. When the GPU process runs out
 * of IOSurfaces ("Failed to allocate IOSurface of size 18x16" in chrome://gpu),
 * new canvases get no backing ("ProduceSkia … non-existent mailbox"): every
 * label goes blank, and the compositor starves until the 3D view greys out.
 * CPU-backed canvases never take an IOSurface. These are small, so software
 * raster costs nothing visible, and getImageData / texture uploads get faster.
 *
 * A caller that really wants an accelerated canvas passes
 * `{ willReadFrequently: false }` explicitly.
 */
type GetContext = (this: HTMLCanvasElement, id: string, options?: unknown) => unknown;

const INSTALLED = Symbol.for('acjs.cpuBacked2dCanvases');

/** Make '2d' contexts on `proto` default to willReadFrequently: true. Idempotent. Returns false if already installed. */
type Patchable = { getContext: GetContext } & Record<symbol, unknown>;
export function installCpuBacked2dCanvases(proto: Patchable =
  ((globalThis as unknown as { HTMLCanvasElement?: { prototype: unknown } }).HTMLCanvasElement?.prototype ?? {}) as Patchable): boolean {
  if (typeof proto.getContext !== 'function' || proto[INSTALLED]) return false;
  const original = proto.getContext;
  proto.getContext = function (this: HTMLCanvasElement, id: string, options?: unknown) {
    if (id === '2d') {
      const o = (options && typeof options === 'object') ? options as Record<string, unknown> : {};
      if (!('willReadFrequently' in o)) return original.call(this, id, { ...o, willReadFrequently: true });
    }
    return original.call(this, id, options);
  };
  proto[INSTALLED] = true;
  return true;
}
