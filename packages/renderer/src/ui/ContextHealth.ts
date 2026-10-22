/**
 * Graphics-context health (2026-10-03 resource sweep, proposal 3): count every
 * GPU context loss in the page and expose it, so a broken session is noticed
 * instead of silently rendering grey frames or blank text.
 *
 * - WebGL `webglcontextlost` / `webglcontextrestored` and 2D-canvas
 *   `contextlost` / `contextrestored` events are caught in the capture phase
 *   on the window (they don't bubble), whatever canvas they hit.
 * - A canvas marked `data-ac-intentional-loss` is skipped: PortalSpaceRenderer
 *   releases its own context on teardown (forceContextLoss) on purpose.
 * - `window.__acHealth` holds the counters for tooling (tools/lib/game-session.ts
 *   `healthSignals` / `assertHealthy`), and each loss is logged once.
 *
 * Recovery: THREE's WebGLRenderer prevents the default on loss and rebuilds on
 * restore. UI text canvases are CPU-backed (CanvasBacking.ts), so a GPU reset
 * no longer blanks them.
 */
export interface ContextHealth {
  webglLost: number;
  webglRestored: number;
  canvas2dLost: number;
  canvas2dRestored: number;
  /**
   * BUG.hud-text-blank-font-sheet — bitmap-font glyph sheets (or tinted
   * copies) that read back blank after they were built (ACFontRenderer's
   * health check): the canvas got no backing, or lost it. Each is dropped
   * and rebuilt; text draws with the fallback until it heals.
   */
  fontSheetBad: number;
  /** The most recent events, newest last (bounded). */
  events: Array<{ type: string; canvas: string; at: number }>;
}

const MAX_EVENTS = 50;

/** Font sheets found blank since the page loaded (also on `__acHealth.fontSheetBad` once installed). */
let fontSheetBadTotal = 0;

/** Count one blank glyph sheet (ACFontRenderer's readback check). */
export function noteFontSheetBad(): void {
  fontSheetBadTotal++;
  const h = (globalThis as { window?: { __acHealth?: ContextHealth } }).window?.__acHealth;
  if (h) h.fontSheetBad = fontSheetBadTotal;
}

/** The page's font-sheet and 2D-canvas health, for telemetry (first_minute). */
export function uiCanvasHealth(): { fontSheetBad: number; canvas2dLost: number } {
  const h = (globalThis as { window?: { __acHealth?: ContextHealth } }).window?.__acHealth;
  return { fontSheetBad: fontSheetBadTotal, canvas2dLost: h?.canvas2dLost ?? 0 };
}

/** A short description of a canvas for logs: id, classes, size. */
export function describeCanvas(el: unknown): string {
  const c = el as { id?: string; className?: string; width?: number; height?: number } | null;
  if (!c) return '?';
  const id = c.id ? `#${c.id}` : '';
  const cls = typeof c.className === 'string' && c.className ? `.${c.className.split(/\s+/)[0]}` : '';
  return `canvas${id}${cls} ${c.width ?? 0}x${c.height ?? 0}`;
}

/** Record one context event into `h` (pure; exported for tests). Returns false when it is skipped. */
export function recordContextEvent(h: ContextHealth, type: string, target: unknown, now = Date.now()): boolean {
  const ds = (target as { dataset?: Record<string, string | undefined> } | null)?.dataset;
  if (ds && ds.acIntentionalLoss !== undefined) return false;
  if (type === 'webglcontextlost') h.webglLost++;
  else if (type === 'webglcontextrestored') h.webglRestored++;
  else if (type === 'contextlost') h.canvas2dLost++;
  else if (type === 'contextrestored') h.canvas2dRestored++;
  else return false;
  h.events.push({ type, canvas: describeCanvas(target), at: now });
  if (h.events.length > MAX_EVENTS) h.events.splice(0, h.events.length - MAX_EVENTS);
  return true;
}

/** Install the listeners on `win` (default: window). Idempotent; returns the shared counters. */
export function installContextHealth(win: (Window & { __acHealth?: ContextHealth }) | undefined =
  (globalThis as { window?: Window & { __acHealth?: ContextHealth } }).window): ContextHealth | null {
  if (!win) return null;
  if (win.__acHealth) return win.__acHealth;
  const h: ContextHealth = { webglLost: 0, webglRestored: 0, canvas2dLost: 0, canvas2dRestored: 0, fontSheetBad: fontSheetBadTotal, events: [] };
  win.__acHealth = h;
  for (const type of ['webglcontextlost', 'webglcontextrestored', 'contextlost', 'contextrestored']) {
    win.addEventListener(type, (e: Event) => {
      if (recordContextEvent(h, type, e.target)) {
        const msg = `[AC] graphics context ${type.replace('context', ' context ')} on ${describeCanvas(e.target)}`;
        if (type.endsWith('lost')) console.error(msg); else console.warn(msg);
      }
    }, true);
  }
  return h;
}
