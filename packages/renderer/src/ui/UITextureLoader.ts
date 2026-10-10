/**
 * UITextureLoader — loads DAT file textures for use in DOM elements.
 *
 * Converts DAT textures (0x06xxxxxx) to HTMLCanvasElement or data URLs
 * for use as CSS backgrounds, img sources, etc. Supports 9-slice rendering
 * for scalable border/frame elements using LayoutDesc edge values.
 */
import type { TextureManager } from '../models/TextureManager.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';

export class UITextureLoader {
  private textureManager: TextureManager;
  private dataUrlCache = new Map<string, string>();
  private canvasCache = new Map<string, HTMLCanvasElement>();

  constructor(textureManager: TextureManager) {
    this.textureManager = textureManager;
  }

  /**
   * Get a texture as a data URL string for use in CSS or <img> elements.
   * Handles both SurfaceTexture (0x05) and direct Texture (0x06) IDs.
   *
   * @param textureId - DAT texture ID (0x06xxxxxx or 0x05xxxxxx)
   * @param paletteId - Optional palette ID (0x04xxxxxx) for palette-indexed textures.
   *   If provided, the texture is recolored using this palette instead of its default.
   */
  getTextureDataURL(textureId: number, paletteId?: number): string | null {
    if (!textureId) return null;
    const key = paletteId ? `tex:${textureId}:pal:${paletteId}` : `tex:${textureId}`;
    const cached = this.dataUrlCache.get(key);
    if (cached) return cached;

    // Streamed DATs: a texture decoded while its 0x04 palette was not resident
    // (TextureManager's palette-less toRGBA fallback) is drawn but not cached.
    const missEpoch = datMissEpoch();
    try {
      // JPEG-format DAT textures (format 0x1f4, e.g. the full-screen chargen
      // background 0x06004d26) have no RGBA pixel data — getIconDataURL
      // returns null for them, so try the direct JPEG path first.
      const url = this.textureManager.getJPEGDataURL(textureId)
        ?? this.textureManager.getIconDataURL(textureId, paletteId);
      if (!url) return null;
      if (noDatMissSince(missEpoch)) this.dataUrlCache.set(key, url);
      return url;
    } catch {
      // Guard against zero-dimension or missing textures
      return null;
    }
  }

  /**
   * Get a texture as a data URL with its alpha channel scaled by `alphaMultiplier`
   * (0..1). Several DAT UI backgrounds (e.g. the classic_chat window textures
   * 0x0600114d/0x06001115/0x0600113a) are fully opaque R8G8B8 with no per-pixel
   * alpha — the retail client dims them at runtime via a material-opacity call
   * (ChatInterface::SetOpacity/SetActiveOpacity/SetDefaultOpacity in the
   * decompiled client) instead. Baking the alpha into the image (rather than
   * CSS `opacity` on the element) lets that dimming apply to just the
   * background layer without fading DOM content stacked on top of it.
   */
  getTextureDataURLWithAlpha(textureId: number, alphaMultiplier: number, paletteId?: number): string | null {
    if (!textureId) return null;
    const clamped = Math.max(0, Math.min(1, alphaMultiplier));
    const key = paletteId
      ? `tex:${textureId}:pal:${paletteId}:alpha:${clamped}`
      : `tex:${textureId}:alpha:${clamped}`;
    const cached = this.dataUrlCache.get(key);
    if (cached) return cached;

    const missEpoch = datMissEpoch();
    const rgba = this.textureManager.getIconRGBA(textureId, paletteId);
    if (!rgba) return null;

    const canvas = document.createElement('canvas');
    canvas.width = rgba.width;
    canvas.height = rgba.height;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.createImageData(rgba.width, rgba.height);
    const src = rgba.data;
    const dst = imageData.data;
    for (let i = 0; i < src.length; i += 4) {
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
      dst[i + 3] = Math.round(src[i + 3] * clamped);
    }
    ctx.putImageData(imageData, 0, 0);

    const url = canvas.toDataURL('image/png');
    if (noDatMissSince(missEpoch)) this.dataUrlCache.set(key, url);
    return url;
  }

  /**
   * Render a texture stretched to specific dimensions as a canvas.
   */
  renderTextureToCanvas(textureId: number, width: number, height: number, paletteId?: number): HTMLCanvasElement | null {
    const key = paletteId ? `canvas:${textureId}:${width}x${height}:pal:${paletteId}` : `canvas:${textureId}:${width}x${height}`;
    const cached = this.canvasCache.get(key);
    if (cached) return cached;

    const missEpoch = datMissEpoch();
    const rgba = this.textureManager.getIconRGBA(textureId, paletteId);
    if (!rgba) return null;

    // Create source image canvas
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = rgba.width;
    srcCanvas.height = rgba.height;
    const srcCtx = srcCanvas.getContext('2d')!;
    const imageData = srcCtx.createImageData(rgba.width, rgba.height);
    imageData.data.set(rgba.data);
    srcCtx.putImageData(imageData, 0, 0);

    // Create output canvas at target dimensions
    const outCanvas = document.createElement('canvas');
    outCanvas.width = width;
    outCanvas.height = height;
    const outCtx = outCanvas.getContext('2d')!;
    outCtx.drawImage(srcCanvas, 0, 0, width, height);

    if (noDatMissSince(missEpoch)) this.canvasCache.set(key, outCanvas);
    return outCanvas;
  }

  /**
   * Render a 9-slice texture for scalable borders/frames.
   * Uses edge values from LayoutDesc ElementDesc to determine slice positions.
   *
   * @param textureId - DAT texture ID (0x06xxxxxx or 0x05xxxxxx)
   * @param width - Target width in pixels
   * @param height - Target height in pixels
   * @param edges - Edge insets: { left, top, right, bottom } in source texture pixels
   */
  render9Slice(
    textureId: number,
    width: number,
    height: number,
    edges: { left: number; top: number; right: number; bottom: number },
    paletteId?: number,
  ): HTMLCanvasElement | null {
    const palSuffix = paletteId ? `:pal:${paletteId}` : '';
    const key = `9slice:${textureId}:${width}x${height}:${edges.left},${edges.top},${edges.right},${edges.bottom}${palSuffix}`;
    const cached = this.canvasCache.get(key);
    if (cached) return cached;

    const missEpoch = datMissEpoch();
    const rgba = this.textureManager.getIconRGBA(textureId, paletteId);
    if (!rgba) return null;

    // Create source image canvas
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = rgba.width;
    srcCanvas.height = rgba.height;
    const srcCtx = srcCanvas.getContext('2d')!;
    const imageData = srcCtx.createImageData(rgba.width, rgba.height);
    imageData.data.set(rgba.data);
    srcCtx.putImageData(imageData, 0, 0);

    const sw = rgba.width;
    const sh = rgba.height;
    const { left, top, right, bottom } = edges;

    // Clamp edges to source dimensions
    const l = Math.min(left, sw);
    const t = Math.min(top, sh);
    const r = Math.min(right, sw - l);
    const b = Math.min(bottom, sh - t);

    // Create output canvas
    const outCanvas = document.createElement('canvas');
    outCanvas.width = width;
    outCanvas.height = height;
    const ctx = outCanvas.getContext('2d')!;

    // Disable image smoothing for pixel-perfect rendering
    ctx.imageSmoothingEnabled = false;

    // Source regions: left col, center col, right col widths
    const srcCenterW = sw - l - r;
    const srcCenterH = sh - t - b;
    // Destination regions
    const dstCenterW = width - l - r;
    const dstCenterH = height - t - b;

    // Top-left corner
    if (l > 0 && t > 0) {
      ctx.drawImage(srcCanvas, 0, 0, l, t, 0, 0, l, t);
    }
    // Top-center edge
    if (srcCenterW > 0 && t > 0 && dstCenterW > 0) {
      ctx.drawImage(srcCanvas, l, 0, srcCenterW, t, l, 0, dstCenterW, t);
    }
    // Top-right corner
    if (r > 0 && t > 0) {
      ctx.drawImage(srcCanvas, sw - r, 0, r, t, width - r, 0, r, t);
    }
    // Middle-left edge
    if (l > 0 && srcCenterH > 0 && dstCenterH > 0) {
      ctx.drawImage(srcCanvas, 0, t, l, srcCenterH, 0, t, l, dstCenterH);
    }
    // Center fill
    if (srcCenterW > 0 && srcCenterH > 0 && dstCenterW > 0 && dstCenterH > 0) {
      ctx.drawImage(srcCanvas, l, t, srcCenterW, srcCenterH, l, t, dstCenterW, dstCenterH);
    }
    // Middle-right edge
    if (r > 0 && srcCenterH > 0 && dstCenterH > 0) {
      ctx.drawImage(srcCanvas, sw - r, t, r, srcCenterH, width - r, t, r, dstCenterH);
    }
    // Bottom-left corner
    if (l > 0 && b > 0) {
      ctx.drawImage(srcCanvas, 0, sh - b, l, b, 0, height - b, l, b);
    }
    // Bottom-center edge
    if (srcCenterW > 0 && b > 0 && dstCenterW > 0) {
      ctx.drawImage(srcCanvas, l, sh - b, srcCenterW, b, l, height - b, dstCenterW, b);
    }
    // Bottom-right corner
    if (r > 0 && b > 0) {
      ctx.drawImage(srcCanvas, sw - r, sh - b, r, b, width - r, height - b, r, b);
    }

    if (noDatMissSince(missEpoch)) this.canvasCache.set(key, outCanvas);
    return outCanvas;
  }

  /**
   * Get a texture as a CSS background-image url() value.
   */
  getTextureAsCSS(textureId: number, paletteId?: number): string | null {
    const url = this.getTextureDataURL(textureId, paletteId);
    if (!url) return null;
    return `url(${url})`;
  }

  /**
   * Apply a DAT texture as background to a DOM element.
   */
  applyTextureBackground(element: HTMLElement, textureId: number, paletteId?: number): boolean {
    const url = this.getTextureDataURL(textureId, paletteId);
    if (!url) return false;
    element.style.backgroundImage = `url(${url})`;
    element.style.backgroundSize = 'cover';
    element.style.backgroundRepeat = 'no-repeat';
    return true;
  }

  /**
   * Apply a 9-slice rendered texture as background to a DOM element.
   */
  apply9SliceBackground(
    element: HTMLElement,
    textureId: number,
    width: number,
    height: number,
    edges: { left: number; top: number; right: number; bottom: number },
    paletteId?: number,
  ): boolean {
    const canvas = this.render9Slice(textureId, width, height, edges, paletteId);
    if (!canvas) return false;
    element.style.backgroundImage = `url(${canvas.toDataURL('image/png')})`;
    element.style.backgroundSize = '100% 100%';
    element.style.backgroundRepeat = 'no-repeat';
    return true;
  }

  /** Clear all caches. */
  clear(): void {
    this.dataUrlCache.clear();
    this.canvasCache.clear();
  }
}
