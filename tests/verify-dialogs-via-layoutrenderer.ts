/**
 * RECON.dialogs-via-layoutrenderer — the DialogFactory dialogs are drawn from
 * their DAT template through LayoutRenderer, not hand-placed DOM.
 *
 * Ground truth:
 *  - DialogFactory::CreateDialog_ @ 00477ad0 instantiates one element of
 *    template layout 0x2100003C per dialog type: 0x15 Yes/No (buttons 0x17 /
 *    0x19, strings 252760419 "Yes" / 183569327 "No"), 0x24 OK (button 0x26,
 *    228229507 "OK"), 0x31 wait / instructions (no buttons). Each one's plate
 *    is child 0x3d (base 0x21000042:0x100002af) holding the text 0x3e.
 *  - Dialog::UpdatePopupSizeAndPosition @ 004769b0: when the text's glyph
 *    height exceeds 0x3e's height, the plate grows by the difference
 *    (SetSize, so the button row reflows by its DAT edges) and is centred.
 *
 * Drives the real GameUI under happy-dom with a real LayoutRenderer over the
 * local DAT (the same fixture as verify-charselect-button-art-once.ts).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasDats)('DialogFactory dialogs render from 0x2100003C (happy-dom + real LayoutRenderer)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let layoutRenderer: any;

  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000002)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`, getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}` };
    layoutRenderer = new LayoutRenderer(local, tex as never, null);
  });
  afterAll(() => fx?.teardown());
  afterEach(() => {
    fx.ui.hideConfirmationDialog();
    fx.ui.hideMessageDialog();
    document.querySelectorAll('.ac-dat-dialog').forEach((el) => el.remove());
  });

  /** A GameUI wired to the real LayoutRenderer; `lineHeight` sets the stub font's line pitch. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function ui(lineHeight = 18): any {
    const u = fx.ui;
    u.layoutRenderer = layoutRenderer;
    u.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    // 10 px per glyph: the 370 px text box holds 37 characters a line.
    u.loadFontRenderer = () => ({
      isReady: true, lineHeight, outlinePadding: { x: 1, y: 1 },
      measureText: (t: string) => t.length * 10,
      renderTextToCanvas: () => document.createElement('canvas'),
      renderWrappedTextToCanvas: () => document.createElement('canvas'),
    });
    return u;
  }
  const node = (root: Element, id: number): HTMLElement =>
    root.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
  const dialogOf = (id: number): HTMLElement =>
    document.querySelector(`.ac-dat-dialog[data-dialog-element="0x${id.toString(16)}"]`) as HTMLElement;
  const px = (v: string): number => Number.parseFloat(v);

  // VISUAL.confirmation-dialog-text-glyphs — Dialog::UpdatePopupSizeAndPosition → UIElement::CenterAt
  // @ 0045fff0 centres with integer halves. translate(-50%, -50%) put the 95 px plate on a half
  // pixel and the pixelated glyph canvases dropped a row ("to" read "lo", "No" read "Nu").
  describe('dialogs sit on whole pixels', () => {
    const view = (w: number, h: number): void => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
    };
    // Labels 7 px a glyph and 18 px tall, so "Yes" is 21 px wide (odd, like the live font).
    function sizedUi(): any {
      const u = ui();
      const canvasFor = (t: string) => { const c = document.createElement('canvas'); c.width = t.length * 7; c.height = 18; return c; };
      u.loadFontRenderer = () => ({
        isReady: true, lineHeight: 18, outlinePadding: { x: 4, y: 4 },
        measureText: (t: string) => t.length * 7,
        renderTextToCanvas: canvasFor,
        renderWrappedTextToCanvas: canvasFor,
      });
      return u;
    }

    it('the plate\'s top-left is the integer screen centre minus its integer half-size, with no translate', () => {
      view(1600, 900);
      sizedUi().showConfirmationDialog('Do you accept?', () => {});
      const dlg = dialogOf(0x15);
      expect(dlg.style.left).toBe('600px');
      expect(dlg.style.top).toBe(`${450 - 47}px`); // 95 px plate: 95 >> 1 = 47, not 47.5
      expect(dlg.style.transform).toBe('none');
    });

    it('an odd window centres the same way and a resize re-places the open plate', () => {
      view(1601, 901);
      sizedUi().showConfirmationDialog('Do you accept?', () => {});
      const dlg = dialogOf(0x15);
      expect([dlg.style.left, dlg.style.top]).toEqual(['600px', `${450 - 47}px`]);
      view(1025, 769);
      window.dispatchEvent(new Event('resize'));
      expect([dlg.style.left, dlg.style.top]).toEqual([`${512 - 200}px`, `${384 - 47}px`]);
    });

    it('a button label is centred as CalcJustification does, (80 >> 1) - (21 >> 1) = 30, not flex\'s 29.5', () => {
      view(1600, 900);
      sizedUi().showConfirmationDialog('Do you accept?', () => {});
      const yes = node(dialogOf(0x15), 0x17).querySelector('.layout-text canvas') as HTMLCanvasElement;
      expect(yes.width).toBe(21);
      expect(yes.style.position).toBe('absolute');
      expect(yes.style.left).toBe('30px');
      expect(yes.style.top).toBe('7px'); // (32 >> 1) - (18 >> 1)
    });
  });

  it('Yes/No: element 0x15 plate, text in 0x3e, buttons 0x17 / 0x19 carry the DAT labels and answer', () => {
    const answers: boolean[] = [];
    ui().showConfirmationDialog('Do you accept?', (a: boolean) => answers.push(a));
    const dlg = dialogOf(0x15);
    expect(dlg).toBeTruthy();
    expect(px(dlg.style.width)).toBe(400);
    expect(px(dlg.style.height)).toBe(95);
    // No hand-placed fallback nine-slice on the wrapper: the chrome comes from the layout.
    expect(dlg.querySelector(':scope > [data-tex]')).toBeNull();
    expect(node(dlg, 0x3d)).toBeTruthy();
    const text = node(dlg, 0x3e);
    expect(text.querySelector('[data-ac-line="Do you accept?"]')).toBeTruthy();
    const yes = node(dlg, 0x17), no = node(dlg, 0x19);
    // The 0x100002cd button labels, drawn through the template's desc (white, the DAT font).
    const label = (btn: HTMLElement): HTMLElement => btn.querySelector(':scope > .layout-text > *') as HTMLElement;
    expect(label(yes).dataset.acRunText).toBe('Yes');
    expect(label(no).dataset.acRunText).toBe('No');
    expect(label(yes).dataset.acDesc).toBeTruthy();
    // Yes at x=80, No at x=240 in the row at y=48 (the template's own positions).
    expect(px(yes.style.left)).toBe(80);
    expect(px(no.style.left)).toBe(240);
    yes.click();
    expect(answers).toEqual([true]);
    expect(dialogOf(0x15)).toBeNull();
    ui().showConfirmationDialog('Again?', (a: boolean) => answers.push(a));
    node(dialogOf(0x15), 0x19).click();
    expect(answers).toEqual([true, false]);
  });

  it('UpdatePopupSizeAndPosition: overflowing text grows the plate by the overflow and the button row follows', () => {
    ui().showConfirmationDialog('Short', () => {});
    const rowTop = px(node(dialogOf(0x15), 0x1000032f).style.top);
    fx.ui.hideConfirmationDialog();
    // Three 18 px lines in the 18 px box: 36 px of overflow.
    ui().showConfirmationDialog('x'.repeat(37 * 2 + 10), () => {});
    const dlg = dialogOf(0x15);
    expect(node(dlg, 0x3e).querySelector('.ac-dialog-text')?.getAttribute('data-ac-lines')).toBe('3');
    expect(px(dlg.style.height)).toBe(95 + 36);
    expect(px(node(dlg, 0x3d).style.height)).toBe(95 + 36);
    expect(px(node(dlg, 0x1000032f).style.top)).toBe(rowTop + 36);
  });

  it('OK message: element 0x24, one OK button 0x26 at x=160 that closes it', () => {
    const u = ui();
    let oks = 0;
    expect(u.showMessageDialog('The server is full.', () => { oks += 1; })).toBe(true);
    // MakeErrorMessageDialog refuses a second one while the first is open.
    expect(u.showMessageDialog('Second')).toBe(false);
    const dlg = dialogOf(0x24);
    const ok = node(dlg, 0x26);
    expect(px(ok.style.left)).toBe(160);
    expect(ok.classList.contains('ac-message-dialog-ok')).toBe(true);
    ok.click();
    expect(oks).toBe(1);
    expect(u.messageDialogOpen).toBe(false);
    expect(dialogOf(0x24)).toBeNull();
  });

  it('PopupString: each popup is its own 0x24 dialog, closed by its own OK', () => {
    const u = ui();
    u.showPopupStringDialog('Welcome to Asheron\'s Call');
    u.showPopupStringDialog('Second notice');
    expect(u.popupStringDialogCount).toBe(2);
    const dialogs = [...document.querySelectorAll('.ac-dat-dialog[data-dialog-element="0x24"]')] as HTMLElement[];
    expect(dialogs.length).toBe(2);
    node(dialogs[0], 0x26).click();
    expect(u.popupStringDialogCount).toBe(1);
  });

  it('wait dialog (Entering World): element 0x31, the 400x84 plate with no buttons, text centred in 0x3e', () => {
    const u = ui();
    const blocker = u.buildWaitDialog('test-wait', 'Entering World');
    const dlg = blocker.querySelector('.ac-dat-dialog[data-dialog-element="0x31"]') as HTMLElement;
    expect(dlg).toBeTruthy();
    expect(px(dlg.style.width)).toBe(400);
    expect(px(dlg.style.height)).toBe(84);
    expect(dlg.querySelector('.ac-dialog-button, [data-element-id="0x17"]')).toBeNull();
    const cell = node(dlg, 0x3e).querySelector('.ac-dialog-text') as HTMLElement;
    expect(cell.getAttribute('data-ac-lines')).toBe('1');
    // Centred both ways (p20 = p21 = 1) in the 370x54 box: (370 - 140) / 2, (54 - 18) / 2.
    const line = cell.querySelector('[data-ac-line="Entering World"]') as HTMLElement;
    expect([px(line.style.left), px(line.style.top)]).toEqual([115, 18]);
    blocker.remove();
  });

  it('text entry (type 5): element 0x2c, the real delete text with the name, an input in the 0x2c edit box, Done 0x2e / Cancel 0x2f', async () => {
    const { DELETE_CHARACTER_CONFIRMATION_STRING_ID } = await import('../packages/renderer/src/ui/GameUI.js');
    const { getStringParts } = await import('@ac/dat-parser');
    const parts = getStringParts(DELETE_CHARACTER_CONFIRMATION_STRING_ID)!;
    expect(parts[0]).toBe('WARNING! ');
    expect(parts[1]).toContain("type 'DELETE' in the box below and press the Done button.");
    const typed: string[] = [];
    ui().showTextEntryDialog(parts.join('Bob'), (t: string) => typed.push(t));
    const dlg = dialogOf(0x2c);
    expect(px(dlg.style.width)).toBe(400);
    const input = node(dlg, 0x2c).querySelector('input.ac-dialog-entry') as HTMLInputElement;
    expect(input).toBeTruthy();
    const label = (id: number): string | undefined => (node(dlg, id).querySelector(':scope > .layout-text > *') as HTMLElement).dataset.acRunText;
    expect(label(0x2e)).toBe('Done');
    expect(label(0x2f)).toBe('Cancel');
    input.value = 'DELETE';
    node(dlg, 0x2e).click();
    expect(typed).toEqual(['DELETE']);
    expect(dialogOf(0x2c)).toBeNull();
  });

  // UIElement::SetParent @ 00462a50 → UpdateForParentSizeChange: the edit
  // frame 0x1000047e is authored at x=0 with L3/R3 edges, so it is centred
  // in the 400 plate whether or not the text grows it. A one-line prompt
  // (the launcher's Custom… bridge entry) used to leave it flush left.
  it('text entry (type 5): the edit frame 0x1000047e is centred in the plate, with or without growth', () => {
    for (const text of ['Enter the address.', 'x'.repeat(37 * 4)]) {
      ui().showTextEntryDialog(text, () => {});
      const dlg = dialogOf(0x2c);
      const frame = node(dlg, 0x1000047e);
      expect(px(frame.style.left)).toBe(120);
      expect(px(frame.style.width)).toBe(160);
      expect(px(node(dlg, 0x2c).style.left)).toBe(4);
      fx.ui.hideConfirmationDialog();
    }
    // The one-line prompt keeps the template's 125 px plate and frame row.
    ui().showTextEntryDialog('Enter the address.', () => {});
    const dlg = dialogOf(0x2c);
    expect(px(dlg.style.height)).toBe(125);
    expect(px(node(dlg, 0x1000047e).style.top)).toBe(43);
  });
});
