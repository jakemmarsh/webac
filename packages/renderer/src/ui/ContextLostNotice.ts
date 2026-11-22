/**
 * BUG.webgl-lost-no-notice — say so when the browser takes the game's
 * graphics away and never gives them back.
 *
 * Prod 2026-11-21 22:06Z: one Windows Chrome with three game tabs had a GPU
 * process reset. All three game canvases got `webglcontextlost` within 1.3 s
 * and none ever got `webglcontextrestored` (TELEMETRY.context-restore:
 * contextRestored=false, lostForMs 745–835 s). The tabs were visible and the
 * player looked at a dead world for 12–14 minutes with nothing saying why,
 * then closed them. Other losses restore on their own in about a second
 * (2026-11-18: contextRestored=true after 1 s); THREE's WebGLRenderer calls
 * preventDefault on the loss, which is what lets the browser restore it, and
 * the existing restore path (THREE's rebuild, GameUI.redrawRendererViews)
 * takes over when it does.
 *
 * So: when the GAME canvas's context is lost and still not back after
 * CONTEXT_LOST_NOTICE_GRACE_MS of the page being visible, show the boot
 * notice plate (boot/BootNotice.ts, the OK dialog's DAT look) with Reload.
 * A later `webglcontextrestored` takes it away again. A hidden page never
 * shows it: the grace starts again when the page is visible.
 * A canvas marked `data-ac-intentional-loss` (ContextHealth.isIntentionalLoss)
 * is never a fault.
 *
 * Why no WEBGL_lose_context.restoreContext() attempt: the extension
 * (registry.khronos.org/webgl/extensions/WEBGL_lose_context) generates
 * INVALID_OPERATION "if the context was not lost via loseContext()", so after
 * a real GPU loss it can do nothing. The browser's own restore is already
 * armed by THREE's preventDefault; when it never comes, the GPU is blocked
 * for the site (Chrome's crash block, WebGlDiagnosis context_lost_after_crash)
 * and only a new page can ask again.
 *
 * Every screen: the game canvas also draws the chargen / paperdoll previews
 * before the world, and nothing 3D can be drawn on it again, so the notice
 * shows pre-world too (with the line about the connection left out). The
 * code is the same in every era.
 */
import { showBootNotice, type BootNoticeHandle } from '../boot/BootNotice.js';
import { isIntentionalLoss } from './ContextHealth.js';

/**
 * How long a lost game context may stay lost, with the page visible, before
 * the notice shows. Restores seen in prod came back in ~1 s (a GPU process
 * restart); ten times that never shows the notice for a loss that heals by
 * itself, and is nothing beside the 12–14 minute stall it exists for.
 */
export const CONTEXT_LOST_NOTICE_GRACE_MS = 10_000;

export const CONTEXT_LOST_NOTICE_ID = 'context-lost-notice';

/**
 * The notice's lines. `inWorld`: a world session is up (the character is in
 * the game). A reload goes back to the launcher, which remembers the world
 * and the account name but never the password (launcher/launcherStorage.ts),
 * so it says the player logs in again.
 */
export function contextLostNoticeText(inWorld: boolean): string[] {
  const lines = ['The browser reset its graphics and hasn\'t given them back to the game.'];
  if (inWorld) {
    lines.push('You are still connected, but nothing can be drawn until the page reloads.');
    lines.push('Press Reload to bring the graphics back. You will need to log in again.');
  } else {
    lines.push('Press Reload to bring the graphics back.');
  }
  return lines;
}

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface ContextLostNoticeOptions {
  doc: Document & Listenable;
  graceMs?: number;
  /** A world session is up (WorldReporter.inWorld). */
  inWorld?: () => boolean;
  /** The notice went up. */
  onShown?: () => void;
  /** Reload was pressed, just before the reload. */
  onReload?: () => void;
  /** Reload the page (default location.reload()). */
  reload?: () => void;
  setTimeout?: (f: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

export class ContextLostNotice {
  private lost = false;
  private timer: unknown = null;
  private handle: BootNoticeHandle | null = null;
  private readonly graceMs: number;
  private readonly setT: (f: () => void, ms: number) => unknown;
  private readonly clearT: (id: unknown) => void;
  private readonly offs: Array<() => void> = [];

  constructor(private readonly canvas: Listenable, private readonly opts: ContextLostNoticeOptions) {
    this.graceMs = opts.graceMs ?? CONTEXT_LOST_NOTICE_GRACE_MS;
    this.setT = opts.setTimeout ?? ((f, ms) => setTimeout(f, ms));
    this.clearT = opts.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    const on = (t: Listenable, type: string, f: (e: Event) => void): void => {
      t.addEventListener(type, f);
      this.offs.push(() => t.removeEventListener(type, f));
    };
    on(canvas, 'webglcontextlost', (e) => this.lostNow(e.target ?? canvas));
    on(canvas, 'webglcontextrestored', () => this.restoredNow());
    on(opts.doc, 'visibilitychange', () => this.visibilityChanged());
  }

  /** The notice is up. */
  get shown(): boolean { return this.handle !== null; }

  private hidden(): boolean { return this.opts.doc.visibilityState === 'hidden'; }

  private lostNow(target: unknown): void {
    if (isIntentionalLoss(target)) return;
    this.lost = true;
    this.arm();
  }

  private restoredNow(): void {
    this.lost = false;
    this.disarm();
    this.handle?.close();
    this.handle = null;
  }

  private visibilityChanged(): void {
    // Hidden: no notice while nobody sees the page, and the grace starts over when it is visible.
    if (this.hidden()) this.disarm(); else this.arm();
  }

  private arm(): void {
    this.disarm();
    if (!this.lost || this.handle || this.hidden()) return;
    this.timer = this.setT(() => { this.timer = null; this.show(); }, this.graceMs);
  }

  private disarm(): void {
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = null;
  }

  private show(): void {
    if (!this.lost || this.handle || this.hidden()) return;
    const doc = this.opts.doc;
    // The player may be typing in chat: the plate must not take the focus, or the next Enter reloads.
    const before = doc.activeElement as (HTMLElement | null);
    const inWorld = (() => { try { return this.opts.inWorld?.() ?? false; } catch { return false; } })();
    const handle = showBootNotice(doc, {
      id: CONTEXT_LOST_NOTICE_ID,
      paragraphs: contextLostNoticeText(inWorld).map((text) => ({ text })),
      buttons: [{
        label: 'Reload',
        className: 'context-lost-reload',
        onClick: () => {
          try { this.opts.onReload?.(); } catch { /* telemetry never blocks the reload */ }
          (this.opts.reload ?? (() => doc.defaultView?.location.reload()))();
        },
      }],
      backdrop: 'clear',
    });
    // Over the dead world, not a wall: the chat, logout and the rest of the page stay usable.
    handle.root.style.pointerEvents = 'none';
    handle.plate.style.pointerEvents = 'auto';
    handle.root.setAttribute('aria-modal', 'false');
    try {
      if (before && before !== doc.body && typeof before.focus === 'function') before.focus();
      else handle.buttons[0]?.blur();
    } catch { /* a detached or headless document */ }
    this.handle = handle;
    console.warn('[AC] graphics context still lost after the grace: showing the Reload notice');
    try { this.opts.onShown?.(); } catch { /* telemetry never blocks the notice */ }
  }

  dispose(): void {
    this.disarm();
    for (const off of this.offs.splice(0)) off();
    this.handle?.close();
    this.handle = null;
  }
}
