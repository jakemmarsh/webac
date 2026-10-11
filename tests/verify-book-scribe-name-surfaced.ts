/**
 * BUG.book-scribe-name-not-surfaced, corrected by
 * VISUAL.char-panel-body-too-bright.a.a.a.b: the book window is gmBookUI on
 * its DAT layout 0x21000019, and gmBookUI::OpenBook @ 004bbca0 uses the
 * whole-book scribe only to title the window — a scribed book (scribeID != 0)
 * is titled with its inscription, any other with the book's name. The scribe's
 * name is kept, not drawn (the former "— <scribe>" line was invented).
 *
 * Also the read path ACE needs: BookData never carries page text, so opening
 * a book asks for page 0 (SetCurPage → Event_BookPageData) and the
 * BookPageDataResponse fills it.
 *
 * Drives the real GameUI with a real LayoutRenderer over the local DAT.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);
const BOOK = 0x80001234;
const ME = 0x50000001;

describe.skipIf(!hasDats)('gmBookUI on 0x21000019 (happy-dom + real LayoutRenderer)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let sent: string[] = [];

  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`, getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}` };
    ui = fx.ui;
    ui.layoutRenderer = new LayoutRenderer(local, tex as never, null);
    ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    ui.playerGuid = ME;
    // 10 px glyphs, 18 px lines: the laid-out page text records its lines.
    ui.loadFontRenderer = () => ({
      isReady: true, lineHeight: 18, outlinePadding: { x: 1, y: 1 },
      measureText: (t: string) => t.length * 10,
      renderTextToCanvas: () => document.createElement('canvas'),
      renderWrappedTextToCanvas: () => document.createElement('canvas'),
    });
    ui.setBookCallbacks({
      bookName: () => 'Ancient Tome',
      pageData: (_b: number, n: number) => sent.push(`pageData ${n}`),
      addPage: () => sent.push('addPage'),
      modifyPage: (_b: number, n: number) => sent.push(`modify ${n}`),
      deletePage: (_b: number, n: number) => sent.push(`delete ${n}`),
      bookData: () => sent.push('bookData'),
    });
  });
  afterAll(() => fx?.teardown());
  afterEach(() => { ui.hideBookPanel(); sent = []; });

  const panel = (): HTMLElement => document.querySelector('.ac-book') as HTMLElement;
  const el = (id: number): HTMLElement => panel().querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
  const runs = (node: HTMLElement): string => ([...node.querySelectorAll('[data-ac-run-text]')] as HTMLElement[]).map((r) => r.dataset.acRunText).join('|');
  const page = (authorId: number, authorName: string, pageText = '', textIncluded = false) =>
    ({ authorId, authorName, textIncluded, ignoreAuthor: false, pageText });

  it('opens in panels-window slot 0x10000182; a scribed book is titled with its inscription', () => {
    ui.openBook(BOOK, 2, [page(7, 'Asheron')], 'To my apprentice', 7, 'Asheron');
    expect(ui.panelsSlot.current?.slot).toBe(0x10000182);
    expect(runs(el(0x1000010f))).toBe('To my apprentice');
    expect(panel().textContent ?? '').not.toContain('— Asheron');
  });

  it('an unscribed book is titled with the book\'s name', () => {
    ui.openBook(BOOK, 2, [page(7, 'Asheron')], 'unused', 0, '');
    expect(runs(el(0x1000010f))).toBe('Ancient Tome');
  });

  it('opening asks for page 0\'s text; the response draws it, one line per "\\n"', () => {
    ui.openBook(BOOK, 2, [page(7, 'Asheron')], '', 0, '');
    expect(sent).toEqual(['pageData 0']);
    ui.bookPageDataResponse(BOOK, 0, page(7, 'Asheron', 'First line\nSecond line', true));
    const cell = el(0x10000111).querySelector('.ac-book-page-text') as HTMLElement;
    expect(cell.dataset.acLines).toBe('2');
    expect(runs(cell)).toBe('First line|Second line');
  });

  it('Prev ghosted on page 0; Next turns and requests the next page', () => {
    ui.openBook(BOOK, 2, [page(7, 'A', 'x', true), page(7, 'A')], '', 0, '');
    expect(el(0x10000114).dataset.acState ?? ui.bookPanelHandle.getState?.(0x10000114)?.toString(16)).toBe('d');
    el(0x10000115).click();
    expect(sent).toEqual(['pageData 1']);
  });

  it('our own page is an editor; the page menu lists every page the book can hold', () => {
    ui.openBook(BOOK, 3, [page(ME, 'Me', 'draft', true)], '', 0, '');
    const editor = el(0x10000111).querySelector('textarea.ac-book-editor') as HTMLTextAreaElement;
    expect(editor.value).toBe('draft');
    // RECON.dom-chrome-sweep.a — the editor draws its desc's DAT font (the
    // panels-window wrapper scope must still resolve 0x21000019:0x10000111).
    expect(editor.dataset.acDatEdit).toBe('1');
    expect(editor.style.color).toBe('transparent');
    expect(el(0x10000111).querySelector('.ac-dat-edit-layer canvas')).not.toBeNull();
    expect(runs(el(0x1000047b))).toBe('Page 1');
    el(0x10000470).click();
    const rows = [...panel().querySelectorAll('.ac-book-menu-row')] as HTMLElement[];
    expect(rows.length).toBe(3);
    // Picking page 2 (past the list) saves our page and asks for a new one.
    editor.value = 'final';
    rows[1].click();
    expect(sent).toEqual(['modify 0', 'addPage']);
  });

  // 0x21000043:0x10000475 holds the listbox 0x10000476 (273x90) and its p114
  // scrollbar 0x10000477 (16x90 at x=273, the HUD widget, p121 hideDisabled):
  // a book of more than 5 pages scrolls its menu with the retail bar, never
  // the browser's own.
  it('the page menu scrolls with its DAT scrollbar 0x10000477, not a native one', () => {
    ui.openBook(BOOK, 8, [page(7, 'A')], '', 0, '');
    el(0x10000470).click();
    const list = panel().querySelector('.ac-book-menu-list') as HTMLElement;
    const bar = panel().querySelector('.ac-book-menu-scrollbar') as HTMLElement;
    expect(list.children.length).toBe(8);
    expect(list.style.width).toBe('273px');
    expect(list.style.height).toBe('90px');
    expect(bar.style.left).toBe('273px');
    expect(bar.style.width).toBe('16px');
    expect(list.style.getPropertyValue('scrollbar-width')).toBe('none');
    // The popup opens upward out of the 18 px button: the button must not clip it.
    expect(el(0x10000470).style.overflow).toBe('visible');
    // happy-dom lays nothing out: 8 rows x 18 px in a 90 px view.
    Object.defineProperty(bar, 'clientHeight', { value: 90, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 144, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 90, configurable: true });
    let top = 0;
    Object.defineProperty(list, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, v); }, configurable: true });
    list.dispatchEvent(new Event('scroll'));
    expect(bar.style.display).not.toBe('none');
    (bar.querySelector('[data-dat-scroll-btn="down"]') as HTMLElement).click();
    expect(top).toBe(18); // one row (UIElement_ListBox::InqScrollDelta)
    // The bar's click does not close the menu.
    expect(panel().querySelector('.ac-book-menu')).not.toBeNull();
  });

  // The page text 0x10000111 (262x240) names its p114 bar 0x1000048a (284,26)
  // 16x240: a long page scrolls under it, never under the browser's own bar.
  it('a long read-only page scrolls under its DAT bar 0x1000048a', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join('\n');
    ui.openBook(BOOK, 2, [page(7, 'A')], '', 0, '');
    ui.bookPageDataResponse(BOOK, 0, page(7, 'A', long, true));
    const host = el(0x10000111);
    expect(host.style.overflowY).toBe('auto');
    expect(host.style.getPropertyValue('scrollbar-width')).toBe('none');
    expect(el(0x1000048a).querySelector('[data-dat-scroll-btn="down"]')).not.toBeNull();
  });

  it('our own (editable) page binds the same bar to the editor', () => {
    ui.openBook(BOOK, 3, [page(ME, 'Me', 'draft', true)], '', 0, '');
    expect(el(0x10000111).querySelector('textarea.ac-book-editor')).not.toBeNull();
    expect(el(0x1000048a).querySelector('[data-dat-scroll-btn="down"]')).not.toBeNull();
  });

  it('a menu that fits (5 pages or fewer) hides the bar (p121)', () => {
    ui.openBook(BOOK, 3, [page(7, 'A')], '', 0, '');
    el(0x10000470).click();
    const list = panel().querySelector('.ac-book-menu-list') as HTMLElement;
    const bar = panel().querySelector('.ac-book-menu-scrollbar') as HTMLElement;
    expect(list.style.height).toBe('54px');
    Object.defineProperty(bar, 'clientHeight', { value: 54, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 54, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 54, configurable: true });
    list.dispatchEvent(new Event('scroll'));
    expect(bar.style.display).toBe('none');
  });
});
