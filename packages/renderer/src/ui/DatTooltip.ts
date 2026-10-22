/**
 * CORE.17.k.b.b.a.d — the retail hover tooltip (UIElementManager's tooltip
 * mechanism), drawn from the DAT tooltip layout 0x21000041.
 *
 * Ground truth (the decompiled EoL client, docs/retail-client-symbols.md
 * CORE.17.k.b.b.a.d):
 *  - An element's tooltip is described by five UIElement properties:
 *    p71 (0x47, Enum)     the root element to instantiate in the tooltip layout
 *    p72 (0x48, DataFile) the tooltip layout (absent → the element's own layout)
 *    p73 (0x49, String)   the tooltip text (UIElement::SetTooltip's m_TTText
 *                         overrides it — gmCGSkillsPage sets the section
 *                         headers' ID_CharGen_*_Tooltip strings that way)
 *    p74 (0x4a, Enum)     on the ROOT: the child text element that takes the string
 *    p75 (0x4b, Bool)     UIRegion::SetTooltipOn — MouseHover @ 00462520
 *                         starts a tooltip only for elements with the bit set
 *    p80 (0x50, Float)    a per-element delay override (CheckTooltip @ 0045b6e0)
 *  - UIElementManager::CheckTooltip @ 0045b6e0: no hover started, the mouse in
 *    the window, nothing captured, an element entered → once p80 (else
 *    m_tooltipDelay) has passed since the last mouse move, StartHover → the
 *    element's MouseHover → StartTooltipAtMouse when p75 and Misc.TooltipEnable.
 *    With a tooltip up: after m_tooltipDuration it is deleted and the mouse-over
 *    reset. SwitchMouseOver @ 0045b560 / StopHover @ 00459280: entering another
 *    element (or none — MouseLeaveEvent @ 0045c2a0) deletes the tooltip.
 *    Defaults (the ctor @ 0045f5d0): enabled, delay 0.25 s, duration 10 s;
 *    Misc.TooltipDelay (0–10 s) / Misc.TooltipEnable are UIPreferences.
 *  - UIElement::StartTooltipAtMouse @ 00460d70 → UIElementManager::StartTooltip
 *    @ 0045de90: CreateRootElement(layout, p71) → the p74 child's
 *    UIElement_Text::SetStringInfo(text) → InqSizewMargins(UITS_MAX_WIDTH:
 *    wrap at the text element's p61 MaxWidth less its margins, size + margins
 *    back) → the root grows by (needed − the child's current size) → the
 *    positional StartTooltip @ 00459700: (mouse + 32, mouse + 32), each
 *    coordinate floored at 0 then clamped to (display − size).
 *  - Layout 0x21000041 (client_local_English.dat): every chargen element uses
 *    root 0x10000487 — 30x30, fill tile 0x06004cc2 (the chargen frame's black
 *    at alpha 175/255), four 1-px edge strips 0x06004cc8 (0x10000209 left,
 *    0x1000020a right, 0x1000020b bottom, 0x100002b5 top — anchored to grow
 *    with the root) and the text child 0x10000396 at (2,2) 26x26, edges
 *    1111: font 0x40000002, white, margins p35–p38 = 2, p21 = 1 (centred),
 *    p60 MaxHeight 512 / p61 MaxWidth 256. (0x10000395 / 0x10000397 /
 *    0x10000398 are the other roots — the same chrome, 0x10000398 in font
 *    0x40000015.)
 *
 * The tooltip box is therefore text + 8 px each way (2 px of frame + 2 px of
 * margin per side), wrapped at 252 px.
 */
import type { BaseProperty } from '@ac/dat-parser/file-types/LayoutDesc.js';

export const TOOLTIP_LAYOUT = 0x21000041;
/** The root every chargen element names in p71. */
export const TOOLTIP_ROOT_ELEMENT = 0x10000487;
/** All four roots of 0x21000041 (the same 30x30 chrome). */
export const TOOLTIP_ROOT_ELEMENTS: readonly number[] = [0x10000487, 0x10000395, 0x10000397, 0x10000398];
/** The text child each root names in p74. */
export const TOOLTIP_TEXT_ELEMENT = 0x10000396;
/** The chargen tooltip strings' table (StringInfo table enum 0x10000002). */
export const TOOLTIP_STRING_TABLE = 0x23000002;

export const TOOLTIP_ROOT_PROPERTY = 71;
export const TOOLTIP_LAYOUT_PROPERTY = 72;
export const TOOLTIP_TEXT_PROPERTY = 73;
export const TOOLTIP_TEXT_CHILD_PROPERTY = 74;
export const TOOLTIP_ON_PROPERTY = 75;
export const TOOLTIP_DELAY_PROPERTY = 80;
export const TEXT_MAX_HEIGHT_PROPERTY = 60;
export const TEXT_MAX_WIDTH_PROPERTY = 61;

/** The root's own media — the 48x48 black tile at alpha 175/255. */
export const TOOLTIP_FILL = 0x06004cc2;
export const TOOLTIP_FILL_FALLBACK = 'rgba(0,0,0,0.686)';
/** The 1-px edge strips' media. */
export const TOOLTIP_EDGE = 0x06004cc8;
export const TOOLTIP_ROOT_SIZE = 30;
/** The text child sits 2 px inside the root on every side ((2,2) 26x26). */
export const TOOLTIP_TEXT_INSET = 2;
export const TOOLTIP_FONT = 0x40000002;
export const TOOLTIP_TEXT_COLOR_ARGB = 0xffffffff;
export const TOOLTIP_TEXT_MARGIN = 2;
export const TOOLTIP_MAX_WIDTH = 256;
export const TOOLTIP_MAX_HEIGHT = 512;
/** StartTooltip @ 00459700 — the box's top-left is mouse + 0x20 each way. */
export const TOOLTIP_MOUSE_OFFSET = 32;
/** UIElementManager's ctor defaults (@ 0045f5d0). */
export const DEFAULT_TOOLTIP_DELAY_SECONDS = 0.25;
export const DEFAULT_TOOLTIP_DURATION_SECONDS = 10;
export const TOOLTIP_DELAY_RANGE_SECONDS: readonly [number, number] = [0, 10];

export interface TooltipEdgePiece {
  /** The strip's element id in 0x21000041's root. */
  element: number;
  /** Placement inside the box (from the child's rect + edge flags at 30x30). */
  style: Record<string, string>;
}

/**
 * The four strips: (0,0) 1x30 edges 1121 → left; (29,0) 1x30 edges 2111 →
 * right; (0,29) 30x1 edges 1211 → bottom; (0,0) 30x1 edges 1112 → top.
 * (Edge flag 1 = anchored to that side of the parent, 2 = follows the far
 * edge — UIElement::UpdateForParentSizeChange @ 00462640.)
 */
export const TOOLTIP_EDGE_PIECES: readonly TooltipEdgePiece[] = [
  { element: 0x10000209, style: { left: '0', top: '0', bottom: '0', width: '1px' } },
  { element: 0x1000020a, style: { right: '0', top: '0', bottom: '0', width: '1px' } },
  { element: 0x1000020b, style: { left: '0', right: '0', bottom: '0', height: '1px' } },
  { element: 0x100002b5, style: { left: '0', right: '0', top: '0', height: '1px' } },
];

/** InqSizewMargins(UITS_MAX_WIDTH): the wrap width is p61 less the text margins. */
export function tooltipWrapWidth(
  maxWidth = TOOLTIP_MAX_WIDTH,
  marginLeft = TOOLTIP_TEXT_MARGIN,
  marginRight = TOOLTIP_TEXT_MARGIN,
): number {
  return maxWidth - marginLeft - marginRight;
}

export interface TooltipBoxSize { width: number; height: number }

/**
 * StartTooltip @ 0045de90: the text child needs (text + margins); the root
 * grows by (needed − the child's size), i.e. the 30x30 root around a 26x26
 * child becomes text + margins + 2 × inset.
 */
export function tooltipBoxSize(
  textWidth: number,
  textHeight: number,
  opts: { inset?: number; insetX?: number; insetY?: number; marginLeft?: number; marginRight?: number; marginTop?: number; marginBottom?: number } = {},
): TooltipBoxSize {
  // CORE.17.k.b.b.a.g — the roots differ in the text child's inset: 0x10000487
  // / 0x10000397 hold it at (2,2), 0x10000395 / 0x10000398 at (2,1)
  // (HudTooltips.tooltipRootGeometry).
  const insetX = opts.insetX ?? opts.inset ?? TOOLTIP_TEXT_INSET;
  const insetY = opts.insetY ?? opts.inset ?? TOOLTIP_TEXT_INSET;
  const ml = opts.marginLeft ?? TOOLTIP_TEXT_MARGIN;
  const mr = opts.marginRight ?? TOOLTIP_TEXT_MARGIN;
  const mt = opts.marginTop ?? TOOLTIP_TEXT_MARGIN;
  const mb = opts.marginBottom ?? TOOLTIP_TEXT_MARGIN;
  return { width: textWidth + ml + mr + 2 * insetX, height: textHeight + mt + mb + 2 * insetY };
}

export interface TooltipPoint { x: number; y: number }

/**
 * StartTooltip @ 00459700: (mouseX + 32, mouseY + 32), each floored at 0 and
 * then held to (display − box) so the box stays on screen.
 */
export function tooltipPosition(
  mouseX: number, mouseY: number,
  boxWidth: number, boxHeight: number,
  displayWidth: number, displayHeight: number,
  offset = TOOLTIP_MOUSE_OFFSET,
): TooltipPoint {
  const x0 = Math.max(0, Math.floor(mouseX) + offset);
  const y0 = Math.max(0, Math.floor(mouseY) + offset);
  return {
    x: Math.min(x0, displayWidth - boxWidth),
    y: Math.min(y0, displayHeight - boxHeight),
  };
}

/** What an element desc says about its tooltip (null: none / SetTooltipOn false). */
export interface TooltipSpec {
  rootId: number;
  layoutId: number;
  stringId: number;
  tableId: number;
  /** p80 when the desc carries one (seconds). */
  delaySeconds?: number;
}

/**
 * StartTooltipAtMouse's reads: p73 for the text, p71 for the root (required),
 * p72 for the layout (else `ownLayoutId`); p75 gates the whole thing.
 */
export function tooltipSpecFromProps(
  props: ReadonlyMap<number, BaseProperty> | null | undefined,
  ownLayoutId = 0,
  /** UIElement::SetTooltip's m_TTText — takes the place of p73 when given. */
  overrideText?: { stringId: number; tableId?: number },
): TooltipSpec | null {
  if (!props) return null;
  const on = props.get(TOOLTIP_ON_PROPERTY);
  if (!on || on.valueBool !== true) return null;
  const own = props.get(TOOLTIP_TEXT_PROPERTY)?.valueString;
  const text = overrideText && overrideText.stringId > 0
    ? { stringId: overrideText.stringId, tableId: overrideText.tableId ?? TOOLTIP_STRING_TABLE }
    : own && own.stringId > 0 ? { stringId: own.stringId, tableId: own.tableId } : null;
  if (!text) return null;
  const root = props.get(TOOLTIP_ROOT_PROPERTY);
  const rootId = root?.valueEnum ?? root?.valueInt;
  if (typeof rootId !== 'number' || rootId === 0) return null;
  const layout = props.get(TOOLTIP_LAYOUT_PROPERTY)?.valueDataFile;
  const layoutId = typeof layout === 'number' && layout !== 0 ? layout : ownLayoutId;
  if (layoutId === 0) return null;
  const delay = props.get(TOOLTIP_DELAY_PROPERTY)?.valueFloat;
  return {
    rootId, layoutId, stringId: text.stringId, tableId: text.tableId || TOOLTIP_STRING_TABLE,
    ...(typeof delay === 'number' ? { delaySeconds: delay } : {}),
  };
}

/** A single hex attribute value ("0x0600..."). */
const hex = (id: number): string => `0x${(id >>> 0).toString(16).padStart(8, '0')}`;
const css = (style: Record<string, string>): string => Object.entries(style).map(([k, v]) => `${k}:${v};`).join('');

export interface TooltipBoxOptions {
  /** The rendered text run (a canvas / span at layout scale). */
  text: HTMLElement;
  /** The run's size in layout px (a canvas's width / height at scale 1). */
  textWidth: number;
  textHeight: number;
  /** Data URL for a media id (null when not loaded). */
  texUrl: (id: number) => string | null;
  /** Position inside the 800x600 frame. */
  x: number;
  y: number;
  rootId?: number;
  margins?: { left: number; right: number; top: number; bottom: number };
  /** The text child's inset inside the root (the root's geometry; default 2 / 2 — the chargen root's). */
  insetX?: number;
  insetY?: number;
  /** An explicit z-index (the HUD tooltip rides ZLayer.TOOLTIP; default 1000 inside the pre-world frame). */
  zIndex?: string;
}

/**
 * The tooltip element as retail's CreateRootElement builds it: the root with
 * its fill tile, the four edge strips (each `data-tex`-stamped) and the text
 * child at the inset + margins. Absolutely positioned, non-interactive.
 */
export function buildDatTooltip(opts: TooltipBoxOptions): HTMLDivElement {
  const margins = opts.margins ?? { left: TOOLTIP_TEXT_MARGIN, right: TOOLTIP_TEXT_MARGIN, top: TOOLTIP_TEXT_MARGIN, bottom: TOOLTIP_TEXT_MARGIN };
  const insetX = opts.insetX ?? TOOLTIP_TEXT_INSET;
  const insetY = opts.insetY ?? TOOLTIP_TEXT_INSET;
  const size = tooltipBoxSize(opts.textWidth, opts.textHeight, {
    insetX, insetY, marginLeft: margins.left, marginRight: margins.right, marginTop: margins.top, marginBottom: margins.bottom,
  });
  const box = document.createElement('div');
  box.className = 'ac-dat-tooltip';
  box.dataset.layout = hex(TOOLTIP_LAYOUT);
  box.dataset.element = hex(opts.rootId ?? TOOLTIP_ROOT_ELEMENT);
  box.dataset.tex = hex(TOOLTIP_FILL);
  const fill = opts.texUrl(TOOLTIP_FILL);
  box.setAttribute('style',
    `position:absolute;left:${opts.x}px;top:${opts.y}px;width:${size.width}px;height:${size.height}px;`
    + `pointer-events:none;z-index:${opts.zIndex ?? '1000'};overflow:visible;`
    + (fill ? `background-image:url(${fill});background-repeat:repeat;` : `background:${TOOLTIP_FILL_FALLBACK};`));
  const edge = opts.texUrl(TOOLTIP_EDGE);
  for (const piece of TOOLTIP_EDGE_PIECES) {
    const strip = document.createElement('div');
    strip.dataset.tex = hex(TOOLTIP_EDGE);
    strip.dataset.framePiece = hex(piece.element);
    strip.setAttribute('style', `position:absolute;pointer-events:none;${css(piece.style)}`
      + (edge ? `background-image:url(${edge});background-repeat:repeat;` : 'background:#000;'));
    box.appendChild(strip);
  }
  const text = document.createElement('div');
  text.className = 'ac-dat-tooltip-text';
  text.dataset.element = hex(TOOLTIP_TEXT_ELEMENT);
  text.setAttribute('style',
    `position:absolute;left:${insetX + margins.left}px;top:${insetY + margins.top}px;`
    + `width:${opts.textWidth}px;height:${opts.textHeight}px;`);
  text.appendChild(opts.text);
  box.appendChild(text);
  return box;
}

/** The style declarations that change what is under the mouse (shown / hidden / stacked / moved). */
const HIT_STYLE_PROPS = /(?:^|;)\s*(display|visibility|z-index|left|top|right|bottom|transform|pointer-events)\s*:[^;]*/gi;
const hitStyle = (style: string | null | undefined): string =>
  (style ?? '').match(HIT_STYLE_PROPS)?.map((d) => d.replace(/^;/, '').replace(/\s+/g, '')).join(';') ?? '';

/**
 * BUG.stale-hover-tooltip — whether a MutationObserver batch can change the
 * element under a still mouse (UIElement::OnVisibilityChanged's
 * m_bPerformMouseHitTest): an element added or removed, a class or `hidden`
 * change, or a style change to display / visibility / stacking / placement /
 * pointer-events. A tooltip box (`.ac-dat-tooltip`) coming and going, and
 * text, paint or size changes (a colour, a background image, a vital bar's
 * width) never do, so a HUD that repaints every frame doesn't re-hit-test
 * every frame.
 */
export function hudMutationsMayMoveMouseOver(
  records: ArrayLike<Pick<MutationRecord, 'type' | 'target' | 'attributeName' | 'oldValue' | 'addedNodes' | 'removedNodes'>>,
): boolean {
  const isTooltip = (n: Node | null): boolean => !!(n as Element | null)?.closest?.('.ac-dat-tooltip');
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type === 'childList') {
      if (isTooltip(r.target)) continue;
      const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
      if (nodes.some((n) => n.nodeType === 1 && !(n as Element).classList?.contains('ac-dat-tooltip'))) return true;
      continue;
    }
    if (r.type !== 'attributes' || isTooltip(r.target)) continue;
    if (r.attributeName !== 'style') return true;
    const now = (r.target as Element).getAttribute?.('style');
    if (hitStyle(r.oldValue) !== hitStyle(now)) return true;
  }
  return false;
}

/** What the hover machine needs from its host (UIElementManager's collaborators). */
export interface TooltipHoverHost<T> {
  /** Timer::local_time, in seconds. */
  now(): number;
  /** m_tooltipEnable (Misc.TooltipEnable). */
  enabled(): boolean;
  /** m_tooltipDelay (Misc.TooltipDelay) — the fallback when the element has no p80. */
  delaySeconds(): number;
  /** m_tooltipDuration. */
  durationSeconds(): number;
  /** The element's p80, when it carries one. */
  elementDelaySeconds?(target: T): number | undefined;
  /** The element's p75 (SetTooltipOn). */
  tooltipOn(target: T): boolean;
  /** StartTooltipAtMouse — create + place the tooltip (the mouse in the host's coordinates). */
  show(target: T, mouseX: number, mouseY: number): void;
  /** AddToDeleteQueue(m_pTooltipElement). */
  hide(): void;
}

/**
 * UIElementManager's hover / tooltip state machine over a generic element
 * type: m_pElementLastEntered, m_bHoverStarted, m_bMouseHasLeftTheWindow,
 * m_lastMouseMoveTime, m_tooltipStart. Drive it with mouseMove /
 * mouseLeave and call `check()` (CheckTooltip) whenever `nextCheckAt()`
 * comes due.
 */
export class TooltipHover<T> {
  private lastEntered: T | null = null;
  private hoverStarted = false;
  private mouseLeft = false;
  private lastMouseMove = Number.NEGATIVE_INFINITY;
  private tooltipStart: number | null = null;
  private mouseX = 0;
  private mouseY = 0;

  constructor(private readonly host: TooltipHoverHost<T>) {}

  /** The element the mouse is in (null once it left every tooltip element). */
  get entered(): T | null { return this.lastEntered; }
  /** A tooltip element exists (m_pTooltipElement != null). */
  get shown(): boolean { return this.tooltipStart !== null; }
  get hovering(): boolean { return this.hoverStarted; }

  /** MouseMoveHandler @ 0045e710: stamp the time, then SwitchMouseOver(hit). */
  mouseMove(target: T | null, x: number, y: number): void {
    this.lastMouseMove = this.host.now();
    this.mouseLeft = false;
    this.mouseX = x;
    this.mouseY = y;
    this.switchMouseOver(target);
  }

  /** MouseLeaveEvent @ 0045c2a0. */
  mouseLeave(): void {
    this.mouseLeft = true;
    this.switchMouseOver(null);
  }

  /** ResetTooltip @ 0045c360 — drop the tooltip and the hover (the elements were rebuilt). */
  reset(): void {
    this.stopHover();
    this.lastEntered = null;
  }

  /**
   * UIElement::SetTooltip @ 004617c0 / ClearTooltip: a changed text on the
   * element that owns the SHOWN tooltip → UIElementManager::ResetTooltip
   * (the tooltip goes, nothing is entered until the next mouse move, which
   * re-enters the element and restarts the delay). A change on any other
   * element, or while no tooltip is up, changes nothing.
   */
  tooltipChanged(target: T): void {
    if (this.tooltipStart !== null && this.lastEntered === target) this.reset();
  }

  /**
   * CORE.17.k.b.b.a.g.d — UIElementManager::ResetTooltip + UIElement::
   * StartTooltipAtMouse(0.0), the path UIElement_SmartBoxWrapper::
   * RecvNotice_SmartBoxObjectFound @ 004e5ad0 takes while m_dragElement is
   * set: whatever tooltip is up goes, `target` counts as entered and hovered,
   * and its tooltip shows at once at the given mouse — no delay, no mouse
   * move (none arrives during a drag: the drag element holds the capture).
   * The gate is the caller's (PlayerModule::ShowTooltips); m_tooltipEnable is
   * MouseHover's check, not this path's. An element with nothing to show
   * (SetTooltipOn clear) shows nothing.
   */
  startTooltipAtMouse(target: T, x: number, y: number): void {
    this.stopHover();
    this.lastEntered = target;
    this.mouseX = x;
    this.mouseY = y;
    this.mouseLeft = false;
    this.lastMouseMove = this.host.now();
    if (!this.host.tooltipOn(target)) return;
    this.hoverStarted = true;
    this.tooltipStart = this.host.now();
    this.host.show(target, x, y);
  }

  /**
   * VISUAL.preworld-hover-tooltips — our page was rebuilt under a still
   * mouse (a click re-renders the chargen page; retail's elements persist).
   * The element now under the mouse counts as entered with NO new mouse-move
   * stamp, so the delay still runs from the last real move and the tooltip
   * pops after a click exactly as retail's does.
   */
  reenter(target: T | null): void {
    if (this.mouseLeft) return;
    this.switchMouseOver(target);
  }

  /** SwitchMouseOver @ 0045b560: a different element ends the hover + tooltip. */
  private switchMouseOver(target: T | null): void {
    if (target === this.lastEntered) return;
    this.stopHover();
    this.lastEntered = target;
  }

  /** StopHover @ 00459280. */
  private stopHover(): void {
    this.hoverStarted = false;
    if (this.tooltipStart !== null) {
      this.tooltipStart = null;
      this.host.hide();
    }
  }

  private delayFor(target: T): number {
    const own = this.host.elementDelaySeconds?.(target);
    return typeof own === 'number' ? own : this.host.delaySeconds();
  }

  /**
   * CheckTooltip @ 0045b6e0. Returns true when something changed (a tooltip
   * started or expired).
   */
  check(): boolean {
    const now = this.host.now();
    if (!this.hoverStarted && !this.mouseLeft) {
      const el = this.lastEntered;
      if (el !== null && this.delayFor(el) + this.lastMouseMove < now) {
        // StartHover → UIElement::MouseHover: the hover "starts" only for an
        // element with SetTooltipOn while tooltips are enabled.
        if (this.host.tooltipOn(el) && this.host.enabled()) {
          this.hoverStarted = true;
          this.tooltipStart = now;
          this.host.show(el, this.mouseX, this.mouseY);
          return true;
        }
      }
      return false;
    }
    if (this.tooltipStart !== null && now - this.tooltipStart > this.host.durationSeconds()) {
      this.tooltipStart = null;
      this.host.hide();
      // SwitchMouseOver(null): the hover ends and nothing is entered until
      // the mouse moves again.
      this.hoverStarted = false;
      this.lastEntered = null;
      return true;
    }
    return false;
  }

  /**
   * The host time at which `check()` next has something to do (null: nothing
   * pending). Retail re-runs CheckTooltip every frame; an element whose
   * MouseHover cannot start a tooltip (no SetTooltipOn, or tooltips off)
   * would just be polled for nothing, so nothing is pending for it here.
   */
  nextCheckAt(): number | null {
    if (this.tooltipStart !== null) return this.tooltipStart + this.host.durationSeconds();
    if (!this.hoverStarted && !this.mouseLeft && this.lastEntered !== null
      && this.host.tooltipOn(this.lastEntered) && this.host.enabled()) {
      return this.lastMouseMove + this.delayFor(this.lastEntered);
    }
    return null;
  }
}
