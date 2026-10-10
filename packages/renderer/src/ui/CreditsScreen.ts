/**
 * RECON.charselect-dat-controls.a — the retail Credits screen (`gmCreditsUI`,
 * UI mode 0x10000005), reached from the char-select CREDITS button
 * (gmCharacterManagementUI::ListenToElementMessage @ 004ed5a0, element
 * 0x100003a3 message 1 → QueueUIMode(0x10000005)).
 *
 * Decompiled EoL client (reference/client-eol/decomp):
 *
 *  - **ctor @ 004e7310**: two root elements of UILAYOUT enum 0x10000004
 *    (DidMapper 0x2500000e → layout 0x21000003 "credits"): the picture field
 *    0x10000413 and the text field 0x10000410 — or 0x10000414 / 0x10000412
 *    when the three ICIDM modifier queries (+0x5c, +0x60, +0x58: the
 *    CInputManager_WIN32 Alt/Ctrl/ShiftKeyDown family) all answer true, a
 *    hidden variant reading string table 0x23000009 instead of 0x23000008.
 *    The text area is the text field's child named by its attribute
 *    0x10000002 (element 0x10000411, text style 0x2100003f:0x10000376,
 *    centred). Then Initialize, and input map 9 is registered at priority
 *    3000 (ICIDM +0x34).
 *  - **Initialize @ 004e70a0**: appends `ID_Credits1`, `ID_Credits2`, … from
 *    the text field's string table (attribute 0x10000003) until one is
 *    invalid, places the text area at y = field height, and sets
 *    m_duration = (fieldH + textH) / ((textH / n + fieldH) / speed), with n
 *    the first invalid index (entries + 1) and speed the field's float
 *    attribute 0x10000004 (20; 22 for the hidden variant; 1.0 when absent).
 *    The picture list is the picture field's array attribute 0x10000005.
 *  - **Update @ 004e79d0** = ScrollText then ScrollPictures(delta).
 *    **ScrollText @ 004e7850**: t = clamp(1 − (endTime − now) / duration),
 *    text y = fieldH − ftol(t · (fieldH + textH)); returns how far the text
 *    rose this frame. At t = 1 it makes the "Please Wait" dialog and queues
 *    UI mode 0x1000000a (back to character management).
 *  - **ScrollPictures @ 004e7610 / CreateAndAddPicture @ 004e7520**: the
 *    first picture is created at y = fieldH + 1, each next one at the last
 *    picture's ScreenY1 + 1 (directly below it; UIRegion's y1 is inclusive)
 *    whenever the last picture's top has risen above the field's bottom;
 *    every picture moves up by the text's delta; when the FIRST array slot
 *    has scrolled off the top it is removed with SmartArray's unordered
 *    remove (the last slot moves into slot 0). Pictures cycle through the
 *    list (GetNextPictureID @ 004e6e70, m_lastPicture wraps). Each is a
 *    type-3 element 0x10000415 sized to its image (all seven credits
 *    pictures, 0x06005f14–0x06005f1a, are 400x300 JPEGs, the element's own
 *    size).
 *  - **OnAction @ 004e79a0**: any action of input map 9 leaves the same way
 *    as the end of the scroll. KeyMap 0x14000002 binds map 9 to Escape
 *    (action 0x27) and Return (action 0x25) only; a mouse click does nothing.
 *
 * The retail screen replaces the character-management framework; ours draws
 * over the char-select frame (same 800x600 scaled box) and removes itself,
 * which looks the same: the char-select ctor restores the selected avatar
 * (UIPersistantData) when retail re-creates it. The one-frame "Please Wait"
 * dialog (MakePleaseWaitDialog @ 004e76f0) that the mode switch closes again
 * is not drawn.
 */

import { acStringHash } from '@ac/dat-parser/file-types/LayoutDesc.js';
import type { ElementDesc } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { descRef } from './DatTextStyle.js';

/** UI mode gmCreditsUI registers for (gmCreditsUI::Register(0x10000005)). */
export const CREDITS_UI_MODE = 0x10000005;
/** UILAYOUT enum 0x10000004 → LayoutDesc 0x21000003 ("credits"). */
export const CREDITS_LAYOUT = 0x21000003;
export const EL_CREDITS_TEXT_FIELD = 0x10000410;
export const EL_CREDITS_TEXT_FIELD_ALT = 0x10000412;
export const EL_CREDITS_TEXT_AREA = 0x10000411;
export const EL_CREDITS_PICTURE_FIELD = 0x10000413;
export const EL_CREDITS_PICTURE_FIELD_ALT = 0x10000414;
export const EL_CREDITS_PICTURE = 0x10000415;
/** Element attributes the ctor / Initialize read. */
const ATTR_TEXT_AREA_CHILD = 0x10000002;
const ATTR_STRING_TABLE = 0x10000003;
const ATTR_SPEED = 0x10000004;
const ATTR_PICTURES = 0x10000005;

/** KeyMap 0x14000002 input map 9: DIK_ESCAPE → 0x27, DIK_RETURN → 0x25. */
export const CREDITS_EXIT_KEYS: ReadonlySet<string> = new Set(['Escape', 'Enter']);

/** The ctor's variant pick: the hidden variant only with all three modifiers held. */
export function creditsUseAltVariant(mods: { altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } | null | undefined): boolean {
  return !!(mods?.altKey && mods.ctrlKey && mods.shiftKey);
}

/** The string id Initialize builds for credits line `i` (1-based). */
export function creditsStringId(i: number): number {
  return acStringHash(`ID_Credits${i}`);
}

/**
 * Initialize's append loop: `ID_Credits1..` until the first missing id. The
 * strings are one text (each carries its own "\n"), split here into lines;
 * the final newline ends the last line rather than opening an empty one.
 */
export function readCreditsText(lookup: (id: number) => string | null): { lines: string[]; entryCount: number } {
  const parts: string[] = [];
  for (let i = 1; ; i++) {
    const s = lookup(creditsStringId(i));
    if (s === null) break;
    parts.push(s);
  }
  const lines = parts.join('').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { lines, entryCount: parts.length };
}

/** Initialize's m_duration (seconds); `entryCount + 1` is the loop's first invalid index. */
export function creditsDuration(fieldH: number, textH: number, entryCount: number, speed: number): number {
  const n = entryCount + 1;
  return (fieldH + textH) / ((textH / n + fieldH) / speed);
}

/** ScrollText @ 004e7850 — the text area's y over time. */
export class CreditsScroll {
  readonly duration: number;
  readonly endTime: number;
  /** The text area's y inside the field (Initialize puts it at the field's height). */
  textY: number;

  constructor(readonly fieldH: number, readonly textH: number, entryCount: number, speed: number, now: number) {
    this.duration = creditsDuration(fieldH, textH, entryCount, speed);
    this.endTime = now + this.duration;
    this.textY = fieldH;
  }

  /** One Update: the text's rise this frame (ScrollPictures' argument) and whether the scroll finished. */
  update(now: number): { delta: number; done: boolean } {
    let t = this.duration !== 0 ? 1 - (this.endTime - now) / this.duration : 1;
    t = Math.max(0, Math.min(1, t));
    const y = this.fieldH - Math.trunc(t * (this.fieldH + this.textH));
    const delta = this.textY - y;
    this.textY = y;
    if (t !== 1) return { delta, done: false };
    return { delta: 0, done: true };
  }
}

export interface CreditsPicture { readonly key: number; readonly id: number; y: number; readonly height: number }

/** ScrollPictures @ 004e7610 + CreateAndAddPicture @ 004e7520 + GetNextPictureID @ 004e6e70. */
export class CreditsPictureColumn {
  /** m_aPictureElements, in SmartArray slot order. */
  readonly pictures: CreditsPicture[] = [];
  private lastPicture = 0;
  private nextKey = 1;

  constructor(
    private readonly ids: readonly number[],
    private readonly fieldH: number,
    private readonly heightOf: (id: number) => number,
    private readonly onAdd: (p: CreditsPicture) => void = () => {},
    private readonly onRemove: (p: CreditsPicture) => void = () => {},
  ) {}

  private nextPictureId(): number | null {
    if (this.ids.length === 0) return null;
    const id = this.ids[this.lastPicture];
    this.lastPicture = (this.lastPicture + 1) % this.ids.length;
    return id;
  }

  private createAndAdd(): void {
    const id = this.nextPictureId();
    if (id === null) return;
    const n = this.pictures.length;
    // GetHeight(field), or the last picture's ScreenY1 (inclusive bottom) — then +1.
    const above = n === 0 ? this.fieldH : this.pictures[n - 1].y + this.pictures[n - 1].height - 1;
    const p: CreditsPicture = { key: this.nextKey++, id, y: above + 1, height: this.heightOf(id) };
    this.pictures.push(p);
    this.onAdd(p);
  }

  scroll(delta: number): void {
    if (this.pictures.length === 0) {
      this.createAndAdd();
    } else {
      for (const p of this.pictures) p.y -= delta;
      const first = this.pictures[0];
      if (first.y + first.height - 1 < 0) {
        // SmartArray unordered remove of slot 0: the last slot moves into it.
        const num = this.pictures.length - 1;
        if (num !== 0) this.pictures[0] = this.pictures[num];
        this.pictures.length = num;
        this.onRemove(first);
      }
    }
    const n = this.pictures.length;
    if (n !== 0 && this.pictures[n - 1].y < this.fieldH) this.createAndAdd();
  }
}

/** What the screen borrows from GameUI (DAT text, textures, layout descs). */
export interface CreditsScreenKit {
  /** Register a string table on demand (the credits tables are not loaded at boot). */
  loadStringTable(tableId: number): void;
  stringFromTable(tableId: number, id: number): string | null;
  desc(ref: string): ElementDesc | null;
  /** One centred, wrapped credits line in `ref`'s font. */
  renderLine(text: string, ref: string, width: number, hJustify: number): HTMLElement;
  /** Wrapped row count of `text` at `width` in `ref`'s font (1 without fonts). */
  wrappedRows(ref: string, text: string, width: number): number;
  /** Font row pitch of `ref` (0 without fonts). */
  lineHeight(ref: string): number;
  texUrl(id: number): string | null;
  /** Seconds (Timer::compute_time). */
  now?(): number;
  requestFrame?(cb: () => void): number;
  cancelFrame?(handle: number): void;
}

const DEFAULT_TEXT_FIELD = { x: 400, y: 0, width: 400, height: 600 };
const DEFAULT_PICTURE_FIELD = { x: 0, y: 0, width: 400, height: 600 };
const DEFAULT_PICTURE = { width: 400, height: 300 };

function propOf(desc: ElementDesc | null, id: number): unknown {
  const props = desc?.properties as unknown;
  if (!props) return undefined;
  if (props instanceof Map) return props.get(id);
  return (props as Record<number, unknown>)[id];
}

/** The live screen (one per CREDITS click). */
export class CreditsScreen {
  readonly root: HTMLDivElement;
  private readonly textArea: HTMLDivElement;
  private readonly pictureField: HTMLDivElement;
  private readonly scroll: CreditsScroll;
  private readonly column: CreditsPictureColumn;
  private readonly lineTops: number[] = [];
  private readonly lineRows: number[] = [];
  private readonly lines: string[];
  private readonly rendered = new Map<number, HTMLElement>();
  private readonly pictureEls = new Map<number, HTMLElement>();
  private readonly lineRef: string;
  private readonly rowH: number;
  private readonly hJustify: number;
  private readonly textW: number;
  private readonly fieldH: number;
  private frame: number | null = null;
  private closed = false;
  private readonly onKey: (e: KeyboardEvent) => void;

  constructor(
    private readonly kit: CreditsScreenKit,
    parent: HTMLElement,
    alt: boolean,
    private readonly onExit: () => void,
  ) {
    const textFieldId = alt ? EL_CREDITS_TEXT_FIELD_ALT : EL_CREDITS_TEXT_FIELD;
    const pictureFieldId = alt ? EL_CREDITS_PICTURE_FIELD_ALT : EL_CREDITS_PICTURE_FIELD;
    const textDesc = kit.desc(descRef(CREDITS_LAYOUT, textFieldId));
    const picDesc = kit.desc(descRef(CREDITS_LAYOUT, pictureFieldId));
    const textBox = textDesc ?? DEFAULT_TEXT_FIELD;
    const picBox = picDesc ?? DEFAULT_PICTURE_FIELD;
    const areaId = (propOf(textDesc, ATTR_TEXT_AREA_CHILD) as { valueEnum?: number } | undefined)?.valueEnum ?? EL_CREDITS_TEXT_AREA;
    const tableId = (propOf(textDesc, ATTR_STRING_TABLE) as { valueDataFile?: number } | undefined)?.valueDataFile
      ?? (alt ? 0x23000009 : 0x23000008);
    const speed = (propOf(textDesc, ATTR_SPEED) as { valueFloat?: number } | undefined)?.valueFloat ?? 1.0;
    const pictureIds = ((propOf(picDesc, ATTR_PICTURES) as { valueArray?: Array<{ valueDataFile?: number }> } | undefined)?.valueArray ?? [])
      .map(v => v.valueDataFile ?? 0).filter(id => id !== 0);
    const pictureDesc = kit.desc(descRef(CREDITS_LAYOUT, EL_CREDITS_PICTURE)) ?? DEFAULT_PICTURE;

    this.lineRef = descRef(CREDITS_LAYOUT, textFieldId, areaId);
    const areaDesc = kit.desc(this.lineRef);
    this.hJustify = (propOf(areaDesc, 20) as { valueEnum?: number } | undefined)?.valueEnum ?? 1;
    this.textW = textBox.width;
    this.fieldH = textBox.height;
    this.rowH = kit.lineHeight(this.lineRef) || 16;

    kit.loadStringTable(tableId);
    const { lines, entryCount } = readCreditsText(id => kit.stringFromTable(tableId, id));
    this.lines = lines;
    let top = 0;
    for (const line of lines) {
      const rows = line === '' ? 1 : Math.max(1, kit.wrappedRows(this.lineRef, line, this.textW));
      this.lineTops.push(top);
      this.lineRows.push(rows);
      top += rows * this.rowH;
    }
    const textH = top;

    const root = document.createElement('div');
    root.id = 'credits-screen';
    root.dataset.mode = 'credits';
    root.dataset.acLayout = CREDITS_LAYOUT.toString(16);
    Object.assign(root.style, {
      position: 'absolute', left: '0', top: '0', width: '800px', height: '600px',
      background: '#000', overflow: 'hidden', zIndex: '1000',
    });
    this.root = root;

    const textField = document.createElement('div');
    textField.id = 'credits-text-field';
    textField.dataset.acElement = textFieldId.toString(16);
    Object.assign(textField.style, {
      position: 'absolute', left: `${textBox.x}px`, top: `${textBox.y}px`,
      width: `${textBox.width}px`, height: `${textBox.height}px`, overflow: 'hidden',
    });
    const textArea = document.createElement('div');
    textArea.id = 'credits-text-area';
    Object.assign(textArea.style, { position: 'absolute', left: '0', top: '0', width: `${this.textW}px`, height: `${textH}px` });
    textField.appendChild(textArea);
    this.textArea = textArea;

    const pictureField = document.createElement('div');
    pictureField.id = 'credits-picture-field';
    pictureField.dataset.acElement = pictureFieldId.toString(16);
    Object.assign(pictureField.style, {
      position: 'absolute', left: `${picBox.x}px`, top: `${picBox.y}px`,
      width: `${picBox.width}px`, height: `${picBox.height}px`, overflow: 'hidden',
    });
    this.pictureField = pictureField;
    root.append(pictureField, textField);
    parent.appendChild(root);

    const now = this.now();
    this.scroll = new CreditsScroll(this.fieldH, textH, entryCount, speed, now);
    this.column = new CreditsPictureColumn(
      pictureIds, picBox.height, () => pictureDesc.height,
      (p) => this.addPictureEl(p, pictureDesc.width),
      (p) => { this.pictureEls.get(p.key)?.remove(); this.pictureEls.delete(p.key); },
    );
    this.placeText();

    // Input map 9 at priority 3000: Escape / Return leave; the screen owns the keyboard meanwhile.
    this.onKey = (e: KeyboardEvent) => {
      if (this.closed) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (!e.repeat && CREDITS_EXIT_KEYS.has(e.key)) this.close();
    };
    window.addEventListener('keydown', this.onKey, true);
    this.schedule();
  }

  get isOpen(): boolean { return !this.closed; }
  /** The text area's current y (for probes). */
  get textY(): number { return this.scroll.textY; }
  get duration(): number { return this.scroll.duration; }
  get lineCount(): number { return this.lines.length; }
  get pictures(): readonly CreditsPicture[] { return this.column.pictures; }

  /** One gmCreditsUI::Update at `now` (seconds). */
  tick(now: number = this.now()): void {
    if (this.closed) return;
    if (!this.root.isConnected) { this.dispose(); return; }
    const { delta, done } = this.scroll.update(now);
    if (done) { this.close(); return; }
    this.column.scroll(delta);
    for (const p of this.column.pictures) {
      const el = this.pictureEls.get(p.key);
      if (el) el.style.top = `${p.y}px`;
    }
    this.placeText();
  }

  /** OnAction / end of scroll: leave for character management. */
  close(): void {
    if (this.closed) return;
    this.dispose();
    this.onExit();
  }

  private dispose(): void {
    this.closed = true;
    window.removeEventListener('keydown', this.onKey, true);
    if (this.frame !== null) {
      if (this.kit.cancelFrame) this.kit.cancelFrame(this.frame);
      else cancelAnimationFrame(this.frame);
    }
    this.frame = null;
    this.root.remove();
  }

  private now(): number {
    return this.kit.now ? this.kit.now() : performance.now() / 1000;
  }

  private schedule(): void {
    const step = (): void => {
      this.frame = null;
      if (this.closed) return;
      this.tick();
      if (!this.closed) this.schedule();
    };
    this.frame = this.kit.requestFrame ? this.kit.requestFrame(step) : requestAnimationFrame(step);
  }

  private addPictureEl(p: CreditsPicture, width: number): void {
    const el = document.createElement('div');
    el.className = 'credits-picture';
    el.dataset.acElement = EL_CREDITS_PICTURE.toString(16);
    el.dataset.acImage = p.id.toString(16);
    Object.assign(el.style, {
      position: 'absolute', left: '0', top: `${p.y}px`, width: `${width}px`, height: `${p.height}px`,
    });
    const url = this.kit.texUrl(p.id);
    if (url) {
      el.style.backgroundImage = `url(${url})`;
      el.style.backgroundSize = `${width}px ${p.height}px`;
    }
    this.pictureField.appendChild(el);
    this.pictureEls.set(p.key, el);
  }

  /** Draw only the lines inside the field (the text is thousands of lines tall). */
  private placeText(): void {
    const y = this.scroll.textY;
    this.textArea.style.top = `${y}px`;
    const viewTop = -y;
    const viewBottom = viewTop + this.fieldH;
    const first = this.firstLineAt(viewTop);
    const want = new Set<number>();
    for (let i = first; i < this.lines.length && this.lineTops[i] < viewBottom; i++) {
      if (this.lineTops[i] + this.lineRows[i] * this.rowH <= viewTop) continue;
      want.add(i);
    }
    for (const [i, el] of this.rendered) {
      if (!want.has(i)) { el.remove(); this.rendered.delete(i); }
    }
    for (const i of want) {
      if (this.rendered.has(i) || this.lines[i] === '') continue;
      const el = this.kit.renderLine(this.lines[i], this.lineRef, this.textW, this.hJustify);
      el.classList.add('credits-line');
      Object.assign(el.style, { position: 'absolute', left: '0', top: `${this.lineTops[i]}px` });
      this.textArea.appendChild(el);
      this.rendered.set(i, el);
    }
  }

  private firstLineAt(top: number): number {
    let lo = 0;
    let hi = this.lineTops.length - 1;
    if (hi < 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineTops[mid] <= top) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
}
