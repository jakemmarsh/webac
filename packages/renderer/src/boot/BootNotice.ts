/**
 * BOOT.notice-plate — the one plate the client shows before any DAT is loaded:
 * the capability screen (boot/Capability.ts) and a failed game-data download
 * (main.ts showPatchError). Both are browser UX with no retail screen
 * (CLAUDE.md, browser-UX exception), but they should look like the same
 * product as every later refusal, which is retail's DialogFactory OK message
 * dialog (layout 0x2100003C element 0x24; GameUI.buildMessageDialog).
 *
 * No DAT is open at this point, so the plate is CSS that reproduces that
 * dialog from its DAT values:
 *
 *  - geometry: 0x2100003C:0x24 — plate 0x3d 400x95 (base 0x21000042:0x100002af),
 *    text region 0x3e at (15,15) 370x18, button row 0x10000338 at y 48 (15 px
 *    above the plate's bottom), OK button 0x26 80x32 at x 160 (centred).
 *  - text: DIALOG_TEXT_TEMPLATE (the 0x3e instance: cream 0xFFFFF7CC, centred,
 *    outline p33/p34 0xFF110F07). The outline is the eight ±1 px neighbours,
 *    `UIElement_Text::DrawSelf @ 00467aa0` pass 0's mode-0x9000 fallback.
 *    Font 0x40000001 is the Palatino bitmap face (docs: CORE.17.h.g.b), so the
 *    CSS stack is Palatino's.
 *  - plate chrome: single pixels of the 0x21000042 nine-slice textures — the
 *    fill 0x06005ddb, the 6 px top/bottom edge 0x06005d3d, the 4 px side edge
 *    0x06005d3e, and the gold brackets of corner 0x06005d39 (light over the
 *    edge's light line, dark over its dark line, 6 px arms).
 *  - button: the 0x21000040:0x100002cd faces — normal 0x06004c99, pressed
 *    0x06004c98 (the stretched middle slice): a 5 px gold ring around a red
 *    fill, a highlight band at rows 6–7 and a shadow band at rows 25–26.
 *    The label is the template's own white with no outline at rest, and the
 *    pressed state's black outline (CORE.17.k.b.b.b).
 *
 * tests/verify-boot-notice.ts re-reads every pixel colour and every size from
 * the DAT, and drives the plate's behaviour.
 */
import { DIALOG_TEXT_TEMPLATE } from '../ui/ConnectionNotices.js';
import { cssFromArgb } from '../ui/DatTextStyle.js';
import { OUTLINE_NEIGHBOUR_OFFSETS } from '../ui/ACFontRenderer.js';
import { DEFAULT_TEXT_OUTLINE_ARGB } from '../ui/TextOutline.js';
import { ZLayer, zLayer } from '../ui/ZIndexRegistry.js';

/** One colour, read from pixel (x, y) of DAT texture `texture`. */
export interface DatPixelColor {
  readonly texture: number;
  readonly x: number;
  readonly y: number;
  readonly argb: number;
}

const px = (texture: number, x: number, y: number, argb: number): DatPixelColor => Object.freeze({ texture, x, y, argb });

/** The 0x2100003C:0x24 OK-dialog geometry (pixels). */
export const BOOT_NOTICE_GEOMETRY = Object.freeze({
  plateWidth: 400,
  plateBaseHeight: 95,
  /** Text region 0x3e's offset in the plate (both axes) and its width. */
  inset: 15,
  textWidth: 370,
  /** 0x3e's height: one line of font 0x40000001. */
  lineHeight: 18,
  /** Button row 0x10000338's y in the plate. */
  buttonRowY: 48,
  buttonWidth: 80,
  buttonHeight: 32,
  /** 0x21000040:0x100002cd label margins p35 / p36. */
  buttonLabelMargin: 7,
});

/** The plate chrome (0x21000042:0x100002af) and dialog button (0x21000040:0x100002cd) colours. */
export const BOOT_NOTICE_COLORS = Object.freeze({
  /** The navy that fills ~90% of 0x06005ddb's 297x65 (the rest is a faint lighter mottle). */
  plateFill: px(0x06005ddb, 148, 0, 0xFF080D18),
  /** 0x06005d3d, rows 0–5 (the top and bottom edges, drawn unflipped at both). */
  edgeRows: Object.freeze([
    px(0x06005d3d, 2, 0, 0xD2181208),
    px(0x06005d3d, 2, 1, 0xFFB9B9B9),
    px(0x06005d3d, 2, 2, 0xFF3D3D3D),
    px(0x06005d3d, 2, 3, 0xD2181208),
    px(0x06005d3d, 2, 4, 0xE1150F07),
    px(0x06005d3d, 2, 5, 0x4B3E2C15),
  ]),
  /** 0x06005d3e, columns 0–3 (the left and right edges, unflipped at both). */
  edgeCols: Object.freeze([
    px(0x06005d3e, 0, 2, 0xD2181208),
    px(0x06005d3e, 1, 2, 0xFF949494),
    px(0x06005d3e, 2, 2, 0xFF434343),
    px(0x06005d3e, 3, 2, 0xD2181208),
  ]),
  cornerLight: px(0x06005d39, 2, 1, 0xFFE5CE84),
  cornerDark: px(0x06005d39, 3, 2, 0xFF814C17),
  /** 0x06004c99 (normal middle slice), column 7. */
  buttonRing: Object.freeze([
    px(0x06004c99, 7, 0, 0xFF281D0E),
    px(0x06004c99, 7, 1, 0xFFE0C77E),
    px(0x06004c99, 7, 2, 0xFFB48943),
    px(0x06004c99, 7, 3, 0xFF814C17),
    px(0x06004c99, 7, 4, 0xFF281D0E),
  ]),
  buttonHighlight: px(0x06004c99, 7, 6, 0xFFB70000),
  buttonFill: px(0x06004c99, 7, 16, 0xFF5C0000),
  buttonShadow: px(0x06004c99, 7, 25, 0xFF280000),
  /** 0x06004c98 (pressed middle slice), column 7. */
  pressedTop: px(0x06004c98, 7, 6, 0xFF5A0B00),
  pressedEdge: px(0x06004c98, 7, 8, 0xFFB61E00),
  pressedFill: px(0x06004c98, 7, 16, 0xFF860E00),
  pressedBottom: px(0x06004c98, 7, 25, 0xFFE72200),
});

/** The dialog button label: 0x21000040:0x100002cd has no p27, so UIElement_Text's default white. */
export const BOOT_NOTICE_BUTTON_LABEL_ARGB = 0xFFFFFFFF;

/** Font 0x40000001's face (Palatino Linotype bitmap), as the nearest web-safe stack. */
export const BOOT_NOTICE_FONT_STACK = '"Palatino Linotype", Palatino, "Book Antiqua", "URW Palladio L", Georgia, serif';

/** CSS `rgba()` of a DAT ARGB colour (the chrome carries alpha, unlike text colours). */
export function cssRgbaFromArgb(argb: number): string {
  const alpha = argb >>> 24, r = (argb >>> 16) & 0xff, g = (argb >>> 8) & 0xff, b = argb & 0xff;
  return alpha === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+(alpha / 255).toFixed(3)})`;
}

/** The eight ±1 px neighbours of each glyph in `argb` (mode 0x9000's outline). */
export function outlineTextShadow(argb: number): string {
  const c = cssFromArgb(argb);
  return OUTLINE_NEIGHBOUR_OFFSETS.map(([x, y]) => `${x}px ${y}px 0 ${c}`).join(', ');
}

const solid = (c: DatPixelColor): string => {
  const css = cssRgbaFromArgb(c.argb);
  return `linear-gradient(${css}, ${css})`;
};

/** The plate's background layers: edges, corner brackets, fill — the 0x100002af nine-slice in CSS. */
export function plateBackground(): { image: string; position: string; size: string; color: string } {
  const C = BOOT_NOTICE_COLORS;
  const layers: Array<[string, string, string]> = [];
  // Corner brackets first (on top): a light and a dark line along each arm, over the edges' light/dark lines.
  const ARM = 6;
  const corner = (h: 'left' | 'right', v: 'top' | 'bottom'): void => {
    // The light line is row / column 1 of its band and the dark one row / column 2. The bottom and right
    // bands are the same textures unflipped, so measured from the far side those lines sit at
    // (band - 1 - 1) and (band - 1 - 2): 4 / 3 px up from the bottom, 2 / 1 px in from the right.
    const lightH = v === 'top' ? 1 : C.edgeRows.length - 2;
    const darkH = v === 'top' ? 2 : C.edgeRows.length - 3;
    const lightV = h === 'left' ? 1 : C.edgeCols.length - 2;
    const darkV = h === 'left' ? 2 : C.edgeCols.length - 3;
    const at = (dx: number, dy: number) => `${h} ${dx}px ${v} ${dy}px`;
    layers.push([solid(C.cornerLight), at(lightV, lightH), `${ARM}px 1px`]);
    layers.push([solid(C.cornerDark), at(darkV, darkH), `${ARM}px 1px`]);
    layers.push([solid(C.cornerLight), at(lightV, lightH), `1px ${ARM}px`]);
    layers.push([solid(C.cornerDark), at(darkV, darkH), `1px ${ARM}px`]);
  };
  corner('left', 'top'); corner('right', 'top'); corner('left', 'bottom'); corner('right', 'bottom');
  const rows = C.edgeRows.map((c, i) => `${cssRgbaFromArgb(c.argb)} ${i}px ${i + 1}px`).join(', ');
  const cols = C.edgeCols.map((c, i) => `${cssRgbaFromArgb(c.argb)} ${i}px ${i + 1}px`).join(', ');
  layers.push([`linear-gradient(to bottom, ${rows})`, 'left 0 top 0', `100% ${C.edgeRows.length}px`]);
  layers.push([`linear-gradient(to bottom, ${rows})`, 'left 0 bottom 0', `100% ${C.edgeRows.length}px`]);
  layers.push([`linear-gradient(to right, ${cols})`, 'left 0 top 0', `${C.edgeCols.length}px 100%`]);
  layers.push([`linear-gradient(to right, ${cols})`, 'right 0 top 0', `${C.edgeCols.length}px 100%`]);
  return {
    image: layers.map((l) => l[0]).join(', '),
    position: layers.map((l) => l[1]).join(', '),
    size: layers.map((l) => l[2]).join(', '),
    color: cssRgbaFromArgb(C.plateFill.argb),
  };
}

/** The button's face for one state: its fill bands (background) and its 5 px gold ring (inset shadows). */
export function buttonFace(pressed: boolean): { background: string; boxShadow: string } {
  const C = BOOT_NOTICE_COLORS;
  const ring = C.buttonRing.map((c, i) => `inset 0 0 0 ${i + 1}px ${cssRgbaFromArgb(c.argb)}`).join(', ');
  const r = cssRgbaFromArgb;
  const background = pressed
    ? `linear-gradient(to bottom, ${r(C.pressedTop.argb)} 0 8px, ${r(C.pressedEdge.argb)} 8px, ${r(C.pressedFill.argb)} 50%, ${r(C.pressedEdge.argb)} calc(100% - 7px), ${r(C.pressedBottom.argb)} calc(100% - 7px))`
    : `linear-gradient(to bottom, ${r(C.buttonHighlight.argb)} 0 8px, ${r(C.buttonFill.argb)} 8px calc(100% - 7px), ${r(C.buttonShadow.argb)} calc(100% - 7px))`;
  return { background, boxShadow: ring };
}

export interface BootNoticeButton {
  label: string;
  className?: string;
  onClick: () => void;
}

export interface BootNoticeOptions {
  id: string;
  /** A first line drawn bold (the capability screen's "This browser can't run the game"). */
  title?: string;
  paragraphs: Array<{ text: string; className?: string }>;
  buttons: BootNoticeButton[];
  /** 'black' covers the page (pre-world letterbox); 'clear' leaves what is under it visible (the patch splash). */
  backdrop?: 'black' | 'clear';
}

export interface BootNoticeHandle {
  root: HTMLElement;
  plate: HTMLElement;
  buttons: HTMLButtonElement[];
  close(): void;
}

const STYLE_ID = 'boot-notice-style';

/** :focus-visible needs a rule (inline styles can't select it): a 1 px light-gold ring instead of the UA's blue. */
function installStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `.boot-notice-button:focus { outline: none; }\n`
    + `.boot-notice-button:focus-visible { outline: 1px solid ${cssFromArgb(BOOT_NOTICE_COLORS.cornerLight.argb)}; outline-offset: 1px; }\n`;
  (doc.head ?? doc.body).appendChild(style);
}

/**
 * Put a notice plate over the page, above the boot loading overlay
 * (ZLayer.BOOT_NOTICE over #loading-overlay's DEBUG_OVERLAY), and focus its
 * first button so Enter / Space answer it from the keyboard.
 */
export function showBootNotice(doc: Document, opts: BootNoticeOptions): BootNoticeHandle {
  installStyle(doc);
  const G = BOOT_NOTICE_GEOMETRY;
  const tpl = DIALOG_TEXT_TEMPLATE;
  const root = doc.createElement('div');
  root.id = opts.id;
  root.className = 'boot-notice';
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-modal', 'true');
  Object.assign(root.style, {
    position: 'fixed', inset: '0', zIndex: zLayer(ZLayer.BOOT_NOTICE),
    background: opts.backdrop === 'clear' ? 'transparent' : 'black',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', boxSizing: 'border-box',
  });

  const plate = doc.createElement('div');
  plate.className = 'boot-notice-plate';
  const bg = plateBackground();
  Object.assign(plate.style, {
    position: 'relative', boxSizing: 'border-box',
    width: `${G.plateWidth}px`, maxWidth: '100%', minHeight: `${G.plateBaseHeight}px`,
    padding: `${G.inset}px`,
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    backgroundColor: bg.color, backgroundImage: bg.image, backgroundPosition: bg.position,
    backgroundSize: bg.size, backgroundRepeat: 'no-repeat',
    font: `16px/${G.lineHeight}px ${BOOT_NOTICE_FONT_STACK}`,
    color: cssFromArgb(tpl.colorArgb),
    textShadow: tpl.outline ? outlineTextShadow(tpl.outlineColorArgb) : 'none',
    // 0x3e's p20 = 1: centred.
    textAlign: tpl.hJustify === 1 ? 'center' : 'left',
  });

  const text = doc.createElement('div');
  text.className = 'boot-notice-text';
  Object.assign(text.style, { width: '100%', maxWidth: `${G.textWidth}px`, minHeight: `${G.lineHeight}px` });
  const titleId = `${opts.id}-title`;
  if (opts.title) {
    const title = doc.createElement('div');
    title.id = titleId;
    title.className = 'boot-notice-title';
    title.textContent = opts.title;
    Object.assign(title.style, { fontWeight: 'bold', marginBottom: `${G.lineHeight / 2}px` });
    text.appendChild(title);
    root.setAttribute('aria-labelledby', titleId);
  }
  opts.paragraphs.forEach((p, i) => {
    const para = doc.createElement('p');
    para.className = ['boot-notice-paragraph', p.className].filter(Boolean).join(' ');
    para.textContent = p.text;
    Object.assign(para.style, { margin: i === 0 ? '0' : `${G.lineHeight / 2}px 0 0` });
    text.appendChild(para);
  });
  plate.appendChild(text);

  const buttons: HTMLButtonElement[] = [];
  if (opts.buttons.length) {
    const row = doc.createElement('div');
    row.className = 'boot-notice-buttons';
    // Row 0x10000338 sits 15 px under the text region (y 48 = 15 + 18 + 15) and 15 px above the bottom.
    const gap = G.buttonRowY - G.inset - G.lineHeight;
    Object.assign(row.style, { display: 'flex', justifyContent: 'center', gap: `${gap}px`, marginTop: `${gap}px`, flexWrap: 'wrap' });
    for (const b of opts.buttons) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = ['boot-notice-button', b.className].filter(Boolean).join(' ');
      btn.textContent = b.label;
      const face = (pressed: boolean): void => {
        const f = buttonFace(pressed);
        btn.style.background = f.background;
        btn.style.boxShadow = f.boxShadow;
        btn.style.textShadow = pressed ? outlineTextShadow(DEFAULT_TEXT_OUTLINE_ARGB) : 'none';
        btn.dataset.pressed = pressed ? '1' : '0';
      };
      Object.assign(btn.style, {
        boxSizing: 'border-box', minWidth: `${G.buttonWidth}px`, height: `${G.buttonHeight}px`,
        padding: `0 ${G.buttonLabelMargin + 5}px`, border: 'none', borderRadius: '0', margin: '0',
        font: `16px/${G.buttonHeight}px ${BOOT_NOTICE_FONT_STACK}`, color: cssFromArgb(BOOT_NOTICE_BUTTON_LABEL_ARGB),
        cursor: 'pointer', whiteSpace: 'nowrap',
      });
      face(false);
      btn.addEventListener('mousedown', () => face(true));
      btn.addEventListener('mouseup', () => face(false));
      btn.addEventListener('mouseleave', () => face(false));
      btn.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') face(true); });
      btn.addEventListener('keyup', () => face(false));
      btn.addEventListener('click', () => b.onClick());
      row.appendChild(btn);
      buttons.push(btn);
    }
    plate.appendChild(row);
  }

  root.appendChild(plate);
  doc.body.appendChild(root);
  try { buttons[0]?.focus(); } catch { /* a detached or headless document */ }
  return { root, plate, buttons, close: () => root.remove() };
}
