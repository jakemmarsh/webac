/**
 * GoArrow's arrow HUD (docs/plugin-specs/goarrow.md §1): a 400 × 175 canvas with the arrow image, the
 * destination's name and coordinates over it and the distance under it. Clean room: our own code from the
 * spec's facts; the rules live in the shared core (packages/shared/src/goarrow/arrowHud.ts).
 *
 * - The arrow turns with the CHARACTER's heading, never the camera (§1.2): frame = goArrowFrame(bearing −
 *   heading). A one-frame set (Simple) is rotated at draw time about its centre.
 * - Text is Arial at "Text size", bold when "Bold" is on, with the 8-copy outline (§1.3).
 * - Hovering = the mouse over the arrow image while the position is unlocked or Ctrl is held (§1.4): a 1 px
 *   Gold border and the 14 px close box 2 px in from the image's top-right. A left drag moves the HUD; the
 *   close box hides the arrow. Ctrl is read on mousedown, not click: on a Mac Ctrl+click is a right-click
 *   and no click event follows (its contextmenu is swallowed after a handled press).
 * - While a route is shown, a click on the outer 20% of the name line's text steps the route (§1.4).
 * - The HUD eats only the presses it handles; everything else reaches the game.
 * - It repaints only when what it draws changes (§1.2): update() is cheap to call every frame.
 *
 * Art: GoArrow's arrow sets are MIT (Copyright (c) 2007 Ben Howell; (c) 2018 Xanius; arrows/LICENSE.txt),
 * not DAT art, so they load as plain bundled images rather than through TextureManager. We ship Chrome
 * (the default) and Simple; the other three sets are 250–525 KB each as sheets
 * (tools/pack-goarrow-arrows.mjs adds them). Each sheet is fetched only when its set is in use.
 */
import {
  GOARROW_CLOSE_BOX_INSET,
  GOARROW_CLOSE_BOX_SIZE,
  GOARROW_HIDDEN_ERROR_MESSAGE,
  GOARROW_HIDDEN_INDOORS_MESSAGE,
  GOARROW_HOVER_BORDER_RGB,
  GOARROW_HUD_HEIGHT,
  GOARROW_HUD_WIDTH,
  GOARROW_OUTLINE_OFFSETS,
  goArrowAngle,
  goArrowFrame,
  goArrowImageOrigin,
  goArrowOutline,
  goArrowTargetCoords,
  goArrowTextLines,
  goArrowVisible,
  goBearing,
  goPickArrowSet,
  goRouteStepClick,
  type GoArrowSettings,
  type GoArrowTarget,
  type GoCoords,
} from '@ac/shared';
import { GOARROW_SHEETS, type GoArrowSheet } from './arrows/sheets.js';

/** The close box (Icons/Window/CloseBox.png, MIT) and GoArrow's toolbar glyph (Icons/Toolbar/GoArrow.png, MIT). */
export const goArrowCloseBoxUrl = (): string => new URL('./arrows/close-box.png', import.meta.url).href;
export const goArrowGlyphUrl = (): string => new URL('./arrows/goarrow-glyph.png', import.meta.url).href;

/** The arrow sets this port ships, for the "Arrow image" dropdown. */
export const GOARROW_SHIPPED_SETS: readonly string[] = GOARROW_SHEETS.map((s) => s.name);

/** The player as the HUD needs it: position, the character's heading (radians, 0 = north, clockwise) and §1.5's "in a dungeon". */
export interface ArrowHudPlayer {
  coords: GoCoords;
  heading: number;
  inDungeon: boolean;
}

/** The HUD's settings: GoArrow's arrow options, plus the shared "Active Opacity" (0–255, default 255). */
export type ArrowHudSettings = GoArrowSettings & { alphaActive?: number };

/** What the HUD reads and drives. GameUI implements it; tests fake it. */
export interface ArrowHudHost {
  player(): ArrowHudPlayer | null;
  /** The destination, resolved now (a tracked object's live position and in-range flag). */
  target(): GoArrowTarget | null;
  settings(): ArrowHudSettings;
  /** The HUD was dragged: keep its new top-left (ArrowHud.Location). */
  savePosition(p: { x: number; y: number }): void;
  /** The close box: switch the arrow off ("Show Arrow" unchecked). */
  hide(): void;
  /** Route stepping set a new destination (the same route at another index). */
  setTarget(t: GoArrowTarget): void;
  /** Overrides for tests: how an image loads, how a canvas is made, which sheets exist. */
  loadImage?(url: string): Promise<CanvasImageSource>;
  createCanvas?(w: number, h: number): HTMLCanvasElement;
  sheets?(): readonly GoArrowSheet[];
}

type Rect = { x: number; y: number; w: number; h: number };

/** Everything one paint draws. Two equal plans draw the same pixels. */
export interface ArrowHudPlan {
  visible: boolean;
  set: string | null;
  frame: number;
  /** The rotation of a one-frame set (radians, rounded to 1e-3); 0 for a multi-frame set. */
  rotation: number;
  image: Rect;
  lines: Array<{ kind: 'name' | 'coords' | 'distance'; text: string; y: number }>;
  font: string;
  textSize: number;
  color: number;
  hover: boolean;
  closeBox: Rect | null;
  opacity: number;
}

/** The arrow's angle for a player and destination (0 = dead ahead); 0 when either is unknown. */
export function arrowHudAngle(player: ArrowHudPlayer | null, dest: GoCoords | null): number {
  if (!player || !dest) return 0;
  return goArrowAngle(goBearing(player.coords, dest), player.heading);
}

/** The paint plan (spec §1.3, §1.4). `sheet` is the loaded set, null while none is. */
export function planArrowHud(o: {
  player: ArrowHudPlayer | null;
  target: GoArrowTarget | null;
  settings: ArrowHudSettings;
  sheet: Pick<GoArrowSheet, 'name' | 'frames' | 'width' | 'height'> | null;
  hover: boolean;
}): ArrowHudPlan {
  const s = o.settings;
  const w = o.sheet?.width ?? 0;
  const h = o.sheet?.height ?? 0;
  const origin = goArrowImageOrigin(w, s.textSize, s.showDestinationOver);
  const image = { x: origin.x, y: origin.y, w, h };
  const visible = goArrowVisible({ enabled: s.visible, hasImage: !!o.sheet, inDungeon: o.player?.inDungeon ?? false, showIndoors: s.displayIndoors });
  const angle = arrowHudAngle(o.player, goArrowTargetCoords(o.target));
  const frames = o.sheet?.frames ?? 1;
  const text = goArrowTextLines(o.target, o.player?.coords ?? null, { showDestination: s.showDestinationOver, showDistance: s.showDistanceUnder });
  const lines: ArrowHudPlan['lines'] = [];
  if (text.name !== null) lines.push({ kind: 'name', text: text.name, y: 0 });
  if (text.coords !== null) lines.push({ kind: 'coords', text: text.coords, y: s.textSize });
  if (text.distance !== null) lines.push({ kind: 'distance', text: text.distance, y: image.y + image.h });
  const hover = visible && o.hover;
  return {
    visible,
    set: o.sheet?.name ?? null,
    frame: goArrowFrame(angle, frames),
    rotation: frames <= 1 ? Math.round(angle * 1000) / 1000 : 0,
    image,
    lines,
    font: `${s.textBold ? 'bold ' : ''}${s.textSize}px Arial`,
    textSize: s.textSize,
    color: s.textColor & 0xffffff,
    hover,
    closeBox: hover ? { x: image.x + image.w - GOARROW_CLOSE_BOX_INSET - GOARROW_CLOSE_BOX_SIZE, y: image.y + GOARROW_CLOSE_BOX_INSET, w: GOARROW_CLOSE_BOX_SIZE, h: GOARROW_CLOSE_BOX_SIZE } : null,
    opacity: Math.max(0, Math.min(255, s.alphaActive ?? 255)) / 255,
  };
}

/** A route destination moved `delta` steps; null when it can't move or isn't a route. */
export function goStepRouteTarget(t: GoArrowTarget | null, delta: -1 | 1): GoArrowTarget | null {
  if (!t || t.kind !== 'route') return null;
  const index = t.index + delta;
  if (index < 0 || index >= t.names.length) return null;
  return { ...t, index };
}

const inRect = (r: Rect, x: number, y: number): boolean => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const rgba = (c: readonly [number, number, number, number]): string => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3] / 255})`;
const hex = (rgb: number): string => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;

export class ArrowHud {
  /** The HUD's element (absolute, placed at ArrowHud.Location inside the parent). */
  readonly root: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  /** How many times it has painted (tests: repaints only on change). */
  paints = 0;
  /** The last plan computed. */
  plan: ArrowHudPlan | null = null;

  private key = '';
  private sheet: GoArrowSheet | null = null;
  private image: CanvasImageSource | null = null;
  private loading: string | null = null;
  private readonly failed = new Set<string>();
  private closeImage: CanvasImageSource | null = null;
  private mouse: { x: number; y: number } | null = null;
  private ctrl = false;
  private drag: { dx: number; dy: number; x: number; y: number } | null = null;
  private swallowContextMenu = false;
  private readonly off: Array<() => void> = [];

  constructor(private readonly host: ArrowHudHost, private readonly parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.dataset.goarrow = 'hud';
    // Over the world and the HUD panels, under the plugin windows (9000+), as a Decal HUD drew over the game.
    Object.assign(this.root.style, { position: 'absolute', width: `${GOARROW_HUD_WIDTH}px`, height: `${GOARROW_HUD_HEIGHT}px`, pointerEvents: 'none', display: 'none', zIndex: '8980' });
    this.canvas = host.createCanvas?.(GOARROW_HUD_WIDTH, GOARROW_HUD_HEIGHT) ?? document.createElement('canvas');
    this.canvas.width = GOARROW_HUD_WIDTH;
    this.canvas.height = GOARROW_HUD_HEIGHT;
    Object.assign(this.canvas.style, { display: 'block', width: `${GOARROW_HUD_WIDTH}px`, height: `${GOARROW_HUD_HEIGHT}px` });
    this.root.appendChild(this.canvas);
    parent.appendChild(this.root);
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
      const l = fn as EventListener;
      window.addEventListener(type, l, true);
      this.off.push(() => window.removeEventListener(type, l, true));
    };
    on('mousedown', (e) => this.onMouseDown(e));
    on('mousemove', (e) => this.onMouseMove(e));
    on('mouseup', (e) => this.onMouseUp(e));
    on('contextmenu', (e) => { if (this.swallowContextMenu) { this.swallowContextMenu = false; e.preventDefault(); e.stopPropagation(); } });
    on('keydown', (e) => { if (e.key === 'Control' && !this.ctrl) { this.ctrl = true; this.update(); } });
    on('keyup', (e) => { if (e.key === 'Control' && this.ctrl) { this.ctrl = false; this.update(); } });
    on('blur', () => { if (this.ctrl) { this.ctrl = false; this.update(); } });
  }

  dispose(): void {
    for (const f of this.off.splice(0)) f();
    this.root.remove();
  }

  /** Why an enabled arrow isn't showing (spec §1.5's messages), or null when it shows, is off or is loading. */
  hiddenReason(): string | null {
    const s = this.host.settings();
    if (!s.visible) return null;
    if ((this.host.player()?.inDungeon ?? false) && !s.displayIndoors) return GOARROW_HIDDEN_INDOORS_MESSAGE;
    if (!this.pickSheet(s)) return GOARROW_HIDDEN_ERROR_MESSAGE;
    return null;
  }

  /** Read the host and repaint if anything drawn changed. Cheap: call it every frame. */
  update(): void {
    const s = this.host.settings();
    this.ensureSheet(s);
    const loaded = this.image && this.sheet ? this.sheet : null;
    const pos = this.drag ? { x: this.drag.x, y: this.drag.y } : s.location;
    this.root.style.left = `${pos.x}px`;
    this.root.style.top = `${pos.y}px`;
    const target = this.host.target();
    const player = this.host.player();
    let plan = planArrowHud({ player, target, settings: s, sheet: loaded, hover: false });
    const hover = !!this.drag || (this.mouse !== null && inRect(plan.image, this.mouse.x, this.mouse.y) && (!s.positionLocked || this.ctrl));
    if (hover) plan = planArrowHud({ player, target, settings: s, sheet: loaded, hover: true });
    this.root.style.display = plan.visible ? 'block' : 'none';
    this.root.style.opacity = String(plan.opacity);
    this.plan = plan;
    const key = JSON.stringify(plan);
    if (key === this.key) return;
    this.key = key;
    if (plan.visible) this.paint(plan);
  }

  private pickSheet(s: ArrowHudSettings): GoArrowSheet | null {
    const sheets = this.host.sheets?.() ?? GOARROW_SHEETS;
    const usable = sheets.filter((x) => !this.failed.has(x.name)).map((x) => x.name);
    const name = goPickArrowSet(s.arrowName, usable);
    return sheets.find((x) => x.name === name) ?? null;
  }

  private ensureSheet(s: ArrowHudSettings): void {
    if (!s.visible) return;
    const want = this.pickSheet(s);
    if (!want || want.name === this.sheet?.name || want.name === this.loading) return;
    const load = this.host.loadImage ?? loadBundledImage;
    this.loading = want.name;
    load(want.url()).then((img) => {
      if (this.loading !== want.name) return;
      this.loading = null;
      this.sheet = want;
      this.image = img;
      this.update();
    }, () => {
      if (this.loading === want.name) this.loading = null;
      this.failed.add(want.name);
      this.update();
    });
    // The close box only shows while hovering: repaint for it only then.
    if (!this.closeImage) load(goArrowCloseBoxUrl()).then((img) => { this.closeImage = img; if (this.plan?.hover) { this.key = ''; this.update(); } }, () => {});
  }

  private paint(p: ArrowHudPlan): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    this.paints++;
    ctx.clearRect(0, 0, GOARROW_HUD_WIDTH, GOARROW_HUD_HEIGHT);
    const sheet = this.sheet;
    if (this.image && sheet) {
      const { x, y, w, h } = p.image;
      if (sheet.frames <= 1) {
        ctx.save();
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate(p.rotation);
        ctx.drawImage(this.image, -w / 2, -h / 2, w, h);
        ctx.restore();
      } else {
        const sx = (p.frame % sheet.cols) * w;
        const sy = Math.floor(p.frame / sheet.cols) * h;
        ctx.drawImage(this.image, sx, sy, w, h, x, y, w, h);
      }
    }
    if (p.hover) {
      ctx.strokeStyle = hex(GOARROW_HOVER_BORDER_RGB);
      ctx.lineWidth = 1;
      ctx.strokeRect(p.image.x + 0.5, p.image.y + 0.5, p.image.w - 1, p.image.h - 1);
      if (p.closeBox && this.closeImage) ctx.drawImage(this.closeImage, p.closeBox.x, p.closeBox.y, p.closeBox.w, p.closeBox.h);
    }
    ctx.font = p.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const outline = goArrowOutline(p.color);
    const cx = GOARROW_HUD_WIDTH / 2;
    for (const line of p.lines) {
      for (const [dx, dy, which] of GOARROW_OUTLINE_OFFSETS) {
        ctx.fillStyle = rgba(outline[which]);
        ctx.fillText(line.text, cx + dx, line.y + dy);
      }
      ctx.fillStyle = hex(p.color);
      ctx.fillText(line.text, cx, line.y);
    }
  }

  /** Mouse position in the HUD's own pixels. */
  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.parent.getBoundingClientRect();
    const pos = this.drag ? { x: this.drag.x, y: this.drag.y } : this.host.settings().location;
    return { x: e.clientX - r.left - pos.x, y: e.clientY - r.top - pos.y };
  }

  private eat(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    // Ctrl+press on a Mac is a right-click: its contextmenu follows; don't let it open a menu.
    this.swallowContextMenu = true;
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    this.ctrl = e.ctrlKey;
    const p = this.plan;
    if (!p?.visible) return;
    const m = this.local(e);
    this.mouse = m;
    const s = this.host.settings();
    if (inRect(p.image, m.x, m.y) && (!s.positionLocked || this.ctrl)) {
      this.eat(e);
      const close = planArrowHud({ player: this.host.player(), target: this.host.target(), settings: s, sheet: this.sheet, hover: true }).closeBox;
      if (close && inRect(close, m.x, m.y)) { this.host.hide(); this.update(); return; }
      this.drag = { dx: m.x, dy: m.y, x: s.location.x, y: s.location.y };
      this.update();
      return;
    }
    const name = p.lines.find((l) => l.kind === 'name');
    const target = this.host.target();
    if (!name || target?.kind !== 'route' || m.y < name.y || m.y >= name.y + p.textSize) return;
    const width = this.measure(name.text, p.font, p.textSize);
    const step = goRouteStepClick(m.x - (GOARROW_HUD_WIDTH - width) / 2, width);
    if (step === 0) return;
    this.eat(e);
    const next = goStepRouteTarget(target, step);
    if (next) this.host.setTarget(next);
    this.update();
  }

  private onMouseMove(e: MouseEvent): void {
    this.ctrl = e.ctrlKey;
    if (this.drag) {
      const r = this.parent.getBoundingClientRect();
      this.drag.x = Math.round(e.clientX - r.left - this.drag.dx);
      this.drag.y = Math.round(e.clientY - r.top - this.drag.dy);
      this.mouse = { x: this.drag.dx, y: this.drag.dy };
      e.preventDefault();
    } else {
      this.mouse = this.local(e);
    }
    this.update();
  }

  private onMouseUp(e: MouseEvent): void {
    if (!this.drag) return;
    const { x, y } = this.drag;
    this.drag = null;
    e.preventDefault();
    e.stopPropagation();
    this.host.savePosition({ x, y });
    this.mouse = this.local(e);
    this.update();
  }

  /** The name line's drawn width (for the route-stepping zones). */
  private measure(text: string, font: string, size: number): number {
    const ctx = this.canvas.getContext('2d');
    if (ctx) {
      ctx.font = font;
      const w = (ctx.measureText(text) as TextMetrics | undefined)?.width;
      if (typeof w === 'number' && Number.isFinite(w) && w > 0) return w;
    }
    return text.length * size * 0.55;
  }
}

/** Fetch and decode one of the bundled images (same-origin Vite assets). */
async function loadBundledImage(url: string): Promise<CanvasImageSource> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GoArrow: could not load ${url} (${res.status})`);
  return createImageBitmap(await res.blob());
}
