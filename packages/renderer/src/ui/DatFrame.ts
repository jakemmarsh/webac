/**
 * CORE.17.k.b.b.a.b — the chargen panel frame template
 * 0x2100004c:0x100002dd, drawn from its DAT media instead of a CSS border.
 *
 * Ground truth (client_local_English.dat, layout 0x2100004c): the template
 * is a 100x100 text element (type 12) whose own media is the 48x48 tile
 * 0x06004cc2 (uniform black at alpha 175/255 — the same tile the HUD's
 * message area and the panel bodies use), with eight image children
 * anchored by their edge flags (1 = anchored to that side of the parent,
 * 2 = free):
 *
 *   0x100002de  (0,0)   34x34  edges 1,1,2,2  0x06004cc3  top-left corner
 *   0x100002df  (66,0)  34x34  edges 2,1,1,2  0x06004cc4  top-right corner
 *   0x100002e0  (0,68)  34x35  edges 1,2,2,1  0x06004cc5  bottom-left corner
 *   0x100002e1  (66,68) 34x35  edges 2,2,1,1  0x06004cc6  bottom-right corner
 *   0x100000e8  (0,34)  5x35   edges 1,1,2,1  0x06004cb8  left edge (5x10 tile)
 *   0x100002e2  (34,0)  32x7   edges 1,1,1,2  0x06004cc7  top edge (10x7 tile)
 *   0x100002e3  (34,96) 32x7   edges 1,2,1,1  0x06004cc7  bottom edge
 *   0x100000ea  (95,34) 5x35   edges 2,1,1,1  0x06004cb8  right edge
 *
 * The bottom row sits 3 px past the template's own 100 px height (the
 * 35-tall bottom corners start at y 68, the bottom edge at y 96) — retail
 * draws that overhang below the element rect, so the pieces here keep the
 * negative bottom offset rather than clipping. The edge strips end 31 px
 * above the bottom (the template's 100 − 69) so the taller bottom corners
 * overlap them by a pixel, as in the DAT.
 *
 * Every chargen text panel inherits this frame through the text templates
 * 0x100002e4 (margins 9 / 26 / 15 / 15, left-justified), 0x100002e6 (= e4 +
 * the 0x100002dc scrollbar child 0x100002e7 at (67,15) 37x70, right-
 * anchored) and 0x100002e5 (margins 6, centred both ways — the summary
 * page's name field); the map / skill boxes / 3D viewports use 0x100002dd
 * directly. Census of the inheritors (probe over 0x21000046–4b):
 *   heritage    0x100003c4 (e6)
 *   profession  0x100003ec (e4, margins 8/8/5/5), 0x100003e0 (e4)
 *   skills      0x100003f6 (dd), 0x100003fa (dd), 0x100003fd (e4)
 *   appearance  0x100003ab (e6), 0x100003ba (dd)
 *   town        0x10000409 (e4), 0x1000040a (dd)
 *   summary     0x100003ff (dd), 0x10000402 (e5), 0x10000404 (e6), 0x10000405 (dd)
 */

export const CHARGEN_FRAME_LAYOUT = 0x2100004c;
export const CHARGEN_FRAME_TEMPLATE = 0x100002dd;
/** The text templates that inherit the frame (see the header). */
export const CHARGEN_FRAME_TEXT_TEMPLATE = 0x100002e4;
export const CHARGEN_FRAME_TEXT_CENTRED_TEMPLATE = 0x100002e5;
export const CHARGEN_FRAME_SCROLL_TEXT_TEMPLATE = 0x100002e6;
export const CHARGEN_FRAME_SCROLLBAR_CHILD = 0x100002e7;

/** The template root's own media — the 48x48 black tile, alpha 175/255. */
export const CHARGEN_FRAME_FILL = 0x06004cc2;
/** CSS fallback for the fill when the tile is not loaded (175/255 = 0.686). */
export const CHARGEN_FRAME_FILL_FALLBACK = 'rgba(0,0,0,0.686)';

export type FrameRepeat = 'no-repeat' | 'repeat-x' | 'repeat-y';

export interface FramePiece {
  /** The template child element id. */
  element: number;
  /** The child's image media (state-less). */
  media: number;
  /** Absolute placement inside the frame box, from the child's rect + edge flags. */
  style: Record<string, string>;
  /** Tiles at the media's natural size (the edge strips) or draws once (the corners). */
  repeat: FrameRepeat;
}

export const CHARGEN_FRAME_PIECES: readonly FramePiece[] = [
  { element: 0x100002de, media: 0x06004cc3, style: { left: '0', top: '0', width: '34px', height: '34px' }, repeat: 'no-repeat' },
  { element: 0x100002df, media: 0x06004cc4, style: { right: '0', top: '0', width: '34px', height: '34px' }, repeat: 'no-repeat' },
  { element: 0x100002e0, media: 0x06004cc5, style: { left: '0', bottom: '-3px', width: '34px', height: '35px' }, repeat: 'no-repeat' },
  { element: 0x100002e1, media: 0x06004cc6, style: { right: '0', bottom: '-3px', width: '34px', height: '35px' }, repeat: 'no-repeat' },
  { element: 0x100000e8, media: 0x06004cb8, style: { left: '0', top: '34px', bottom: '31px', width: '5px' }, repeat: 'repeat-y' },
  { element: 0x100002e2, media: 0x06004cc7, style: { left: '34px', right: '34px', top: '0', height: '7px' }, repeat: 'repeat-x' },
  { element: 0x100002e3, media: 0x06004cc7, style: { left: '34px', right: '34px', bottom: '-3px', height: '7px' }, repeat: 'repeat-x' },
  { element: 0x100000ea, media: 0x06004cb8, style: { right: '0', top: '34px', bottom: '31px', width: '5px' }, repeat: 'repeat-y' },
];

/** The text margins of 0x100002e4 (p35 left / p36 right / p37 top / p38 bottom). */
export const CHARGEN_FRAME_TEXT_MARGINS = { left: 9, right: 26, top: 15, bottom: 15 } as const;

/**
 * The 0x100002dc scrollbar child of 0x100002e6: (67,15) 37x70 with edges
 * 2,1,1,1 in the 100x100 template → right-anchored 4 px past the frame's
 * right edge, 15 px in from the top and bottom. Media: track 0x06004d33
 * (37x17 tile), thumb 0x1 0x06004d34 (the 37x39 red gem), the two 37x17
 * arrow buttons 0x06004d35 (the up arrow) / 0x06004d36 (the down arrow).
 * The retail heritage frame (reference/images/preworld/char-create-ref1.png,
 * lore panel) shows the up arrow at the top with the gem directly under it
 * and the down arrow at the bottom; the DAT lists 0x10000071 (0,83) with
 * 0x06004d35 and 0x10000072 (0,0) with 0x06004d36, so UIElement_Scrollbar
 * assigns the arrow media by role rather than by the child's slot — the
 * retail frame is followed here.
 */
export const CHARGEN_FRAME_SCROLLBAR = {
  right: -4, top: 15, bottom: 15, width: 37,
  track: 0x06004d33, thumb: 0x06004d34, thumbHeight: 39, buttonHeight: 17,
  topButton: 0x06004d35, bottomButton: 0x06004d36,
} as const;

/**
 * The art and geometry a live DAT scrollbar is drawn with (GameUI
 * bindDatScrollbarWidget). `up` / `down` are the normal / hover / pressed
 * button media; `thumb` is either the HUD widget's 3-slice proportional
 * thumb or one fixed-size image.
 */
export interface DatScrollbarSkin {
  width: number;
  buttonHeight: number;
  track: number;
  up: readonly [number, number, number];
  down: readonly [number, number, number];
  thumb: 'hud' | { tex: number; height: number };
}

/** The HUD base widget 0x10000367@0x2100003e (gold chain, blue 3-slice thumb). */
export const HUD_SCROLLBAR_SKIN: DatScrollbarSkin = {
  width: 16, buttonHeight: 16, track: 0x06004c5f,
  up: [0x06004c69, 0x06004c6a, 0x06004c6b], down: [0x06004c6c, 0x06004c6d, 0x06004c6e],
  thumb: 'hud',
};

/**
 * The chargen bar 0x2100004c:0x100002dc (VISUAL.chargen-skills-list-rows.b):
 * p130 = false, so the widget is not proportional and the 37x39 gem keeps its
 * size; the arrow buttons carry one media each (no hover / pressed art).
 */
export const CHARGEN_SCROLLBAR_SKIN: DatScrollbarSkin = {
  width: CHARGEN_FRAME_SCROLLBAR.width, buttonHeight: CHARGEN_FRAME_SCROLLBAR.buttonHeight,
  track: CHARGEN_FRAME_SCROLLBAR.track,
  up: [CHARGEN_FRAME_SCROLLBAR.topButton, CHARGEN_FRAME_SCROLLBAR.topButton, CHARGEN_FRAME_SCROLLBAR.topButton],
  down: [CHARGEN_FRAME_SCROLLBAR.bottomButton, CHARGEN_FRAME_SCROLLBAR.bottomButton, CHARGEN_FRAME_SCROLLBAR.bottomButton],
  thumb: { tex: CHARGEN_FRAME_SCROLLBAR.thumb, height: CHARGEN_FRAME_SCROLLBAR.thumbHeight },
};

/**
 * One arrow-button step of a DAT listbox (UIElement_ListBox::InqScrollDelta
 * @ 0046dc10, the 0xd / 0xe messages UIElement_Scrollbar::HandleMoveSteps
 * broadcasts): the content height divided by the row count, capped at the
 * viewport height. No rows → no step.
 */
export function listBoxScrollDelta(contentHeight: number, rows: number, viewportHeight: number): number {
  if (rows <= 0) return 0;
  return Math.min(Math.trunc(contentHeight / rows), viewportHeight);
}

/**
 * One arrow-button step of a DAT text element (UIElement_Text::InqScrollDelta
 * @ 004689b0): the glyph-line height of the line at the top of the view,
 * capped at the element's region height. No line → no step.
 */
export function textScrollDelta(lineHeight: number, regionHeight: number): number {
  if (lineHeight <= 0) return 0;
  return Math.min(lineHeight, regionHeight);
}

export interface FrameBox { x: number; y: number; w: number; h: number }

export interface FrameOptions {
  /** Extra class names on the frame box. */
  className?: string;
  /** Extra inline style on the frame box (appended verbatim). */
  extraStyle?: string;
  /** A `data-ac-desc`-style reference recorded on the box for tests / captures. */
  desc?: string;
  /** Append the 0x100002e6 scrollbar chrome (right-anchored, 15 px inset). */
  scrollbar?: boolean;
}

const hex = (id: number): string => `0x${id.toString(16).padStart(8, '0')}`;
const css = (style: Record<string, string>): string => Object.entries(style).map(([k, v]) => `${k}:${v};`).join('');

/**
 * Build the frame as an HTML string: an absolutely positioned box at the
 * DAT rect carrying the tiled fill, the eight template pieces (each with a
 * `data-tex` attribute naming its media) and then `inner`. The caller
 * places its content absolutely inside the box (the box is `position:
 * absolute`; the template's overhanging bottom row stays visible, so the
 * box itself never clips — put `overflow` on an inner scroller).
 */
export function datFrameHtml(
  texUrl: (id: number) => string | null,
  box: FrameBox,
  inner: string,
  opts: FrameOptions = {},
): string {
  const fill = texUrl(CHARGEN_FRAME_FILL);
  const pieces = CHARGEN_FRAME_PIECES.map((p) => {
    const url = texUrl(p.media);
    return `<div data-tex="${hex(p.media)}" data-frame-piece="${hex(p.element)}" style="position:absolute;pointer-events:none;${css(p.style)}${url ? `background-image:url(${url});background-repeat:${p.repeat};` : ''}"></div>`;
  }).join('');
  const scrollbar = opts.scrollbar ? datFrameScrollbarHtml(texUrl) : '';
  // The slices come AFTER the inner text: they are the element's children,
  // which UIRegion draws after the parent's own DrawSelf, so the border
  // covers text running into the margins (VISUAL.chargen-appearance-page).
  return `<div class="ac-dat-frame${opts.className ? ` ${opts.className}` : ''}" data-frame="${hex(CHARGEN_FRAME_LAYOUT)}:${hex(CHARGEN_FRAME_TEMPLATE)}"${opts.desc ? ` data-frame-desc="${opts.desc}"` : ''} style="position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;${fill ? `background-image:url(${fill});background-repeat:repeat;` : `background:${CHARGEN_FRAME_FILL_FALLBACK};`}${opts.extraStyle ?? ''}">${inner}${pieces}${scrollbar}</div>`;
}

/** The 0x100002e6 scrollbar chrome (static — the thumb rests at the top). */
export function datFrameScrollbarHtml(texUrl: (id: number) => string | null): string {
  const s = CHARGEN_FRAME_SCROLLBAR;
  const img = (id: number, style: Record<string, string>, repeat: FrameRepeat = 'no-repeat'): string => {
    const url = texUrl(id);
    return `<div data-tex="${hex(id)}" style="position:absolute;pointer-events:none;${css(style)}${url ? `background-image:url(${url});background-repeat:${repeat};` : ''}"></div>`;
  };
  return `<div class="ac-dat-frame-scrollbar" data-frame-piece="${hex(CHARGEN_FRAME_SCROLLBAR_CHILD)}" style="position:absolute;right:${s.right}px;top:${s.top}px;bottom:${s.bottom}px;width:${s.width}px;pointer-events:none;">`
    + img(s.track, { left: '0', top: '0', right: '0', bottom: '0' }, 'repeat-y')
    + img(s.topButton, { left: '0', top: '0', width: `${s.width}px`, height: `${s.buttonHeight}px` })
    + img(s.thumb, { left: '0', top: `${s.buttonHeight}px`, width: `${s.width}px`, height: `${s.thumbHeight}px` })
    + img(s.bottomButton, { left: '0', bottom: '0', width: `${s.width}px`, height: `${s.buttonHeight}px` })
    + '</div>';
}

/**
 * The text area of a framed text panel: the whole box, with the text
 * template's margins (0x100002e4's 9 / 26 / 15 / 15 unless the instance
 * overrides them, e.g. 0x100003ec's 8 / 8 / 5 / 5) as padding. The margins
 * only place the lines; UIRegion::DrawHere @ 0069fa30 clips the text to the
 * element's own box, so a line that runs into the bottom margin still draws
 * (VISUAL.chargen-appearance-page: retail shows the help text's last line
 * where ours cut it at the margin). Overflow clips at the padding edge.
 */
export function frameTextInsetStyle(margins: { left: number; right: number; top: number; bottom: number } = CHARGEN_FRAME_TEXT_MARGINS): string {
  return `position:absolute;left:0;right:0;top:0;bottom:0;box-sizing:border-box;padding:${margins.top}px ${margins.right}px ${margins.bottom}px ${margins.left}px;`;
}
