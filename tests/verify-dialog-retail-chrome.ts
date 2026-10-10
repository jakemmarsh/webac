/**
 * CORE.13.b — Please Wait / confirmation dialogs draw the retail
 * DialogFactory chrome, not a flat CSS box.
 *
 * Ground truth (decompiled retail client + DAT):
 * - DialogFactory::CreateDialog_ @ 00477ad0 instantiates every dialog
 *   from template layout 0x2100003C: dialog type 1 (ConfirmationDialog,
 *   element type 0x13) is element 0x15; type 2 (WaitDialog, element type
 *   0x19 — gmCharacterManagementUI::MakePleaseWaitDialog @ 004eced0
 *   passes property 0x8e = 2) is element 0x31.
 * - Both plates inherit base element 0x100002af in layout 0x21000042: a
 *   navy backdrop 0x06005ddb under a gold nine-slice frame — corners
 *   0x06005d39/3a/3b/3c (13x13 top row, 13x14 bottom row), 6px
 *   top/bottom edges 0x06005d3d, 4px left/right edges 0x06005d3e.
 * - ConfirmationDialog: 400x95 plate, Yes button at x=80 / No at x=240
 *   (80x32 each, template 0x100002cd in 0x21000040 — caps 0x06004c96 |
 *   0x06004c9c around stretched middle 0x06004c99; pressed 95/98/9b),
 *   labels DAT strings 252760419 "Yes" / 183569327 "No".
 * - WaitDialog: 400x84 plate, text region at (15,15) 370x54.
 * - Dialog::UpdatePopupSizeAndPosition @ 004769b0 centers the plate at
 *   (w/2, h/2) of the screen.
 *
 * Behavioral suite — drives the real GameUI under happy-dom (same harness
 * as verify-preworld-uniform-letterbox.ts; tests/_harness/dom.ts).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1920, innerHeight: 1080 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

const PLATE_SLICES = [
  '0x06005ddb', // backdrop
  '0x06005d3d', // top edge
  '0x06005d3d', // bottom edge
  '0x06005d3e', // left edge
  '0x06005d3e', // right edge
  '0x06005d39', // TL corner
  '0x06005d3a', // TR corner
  '0x06005d3b', // BL corner
  '0x06005d3c', // BR corner
];

describe('CORE.13.b — dialogs draw the retail DialogFactory chrome', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};

  beforeAll(() => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function freshUi(): Promise<any> {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new mod.GameUI(container);
  }

  function sliceTexes(plate: HTMLElement): string[] {
    return [...plate.children]
      .filter((c) => (c as HTMLElement).hasAttribute('data-tex'))
      .map((c) => (c as HTMLElement).getAttribute('data-tex')!);
  }

  it('confirmation dialog is the 400x95 retail plate with the full nine-slice frame', async () => {
    const ui = await freshUi();
    ui.showConfirmationDialog('Do you accept?', () => {});
    const plate = domWindow.document.querySelector('.ac-dialog-plate') as HTMLElement;
    expect(plate).toBeTruthy();
    expect(plate.style.width).toBe('400px');
    expect(plate.style.height).toBe('95px');
    // Dialog::UpdatePopupSizeAndPosition → UIElement::CenterAt @ 0045fff0: integer halves, whole pixels.
    expect(plate.style.left).toBe(`${(domWindow.innerWidth >> 1) - 200}px`);
    expect(plate.style.top).toBe(`${(domWindow.innerHeight >> 1) - 47}px`);
    expect(plate.style.transform).toBe('none');
    expect(sliceTexes(plate)).toEqual(PLATE_SLICES);
  });

  it('confirmation buttons sit at the DAT template positions with DAT-string labels', async () => {
    const ui = await freshUi();
    ui.showConfirmationDialog('Do you accept?', () => {});
    const btns = [...domWindow.document.querySelectorAll('.ac-dialog-button')] as HTMLElement[];
    expect(btns.length).toBe(2);
    const [yes, no] = btns;
    expect(yes.style.left).toBe('80px');
    expect(no.style.left).toBe('240px');
    for (const b of btns) {
      expect(b.style.width).toBe('80px');
      expect(b.style.height).toBe('32px');
      expect(b.style.bottom).toBe('15px');
      expect(sliceTexes(b)).toEqual(['0x06004c96', '0x06004c99', '0x06004c9c']);
    }
    // Labels come from renderACText — without the AC font loaded it falls
    // back to a text span; either way the label text must be present.
    expect(yes.textContent).toContain('Yes');
    expect(no.textContent).toContain('No');
  });

  // House abandon asks twice (HouseAbandonDialogCallback_First → _Second):
  // a Yes that opens the next dialog must leave that dialog up.
  it('a Yes whose callback opens another confirmation leaves the new one open', async () => {
    const ui = await freshUi();
    const answers: string[] = [];
    ui.showConfirmationDialog('First?', (yes: boolean) => {
      answers.push(`first:${yes}`);
      if (yes) ui.showConfirmationDialog('Second?', (y2: boolean) => answers.push(`second:${y2}`));
    });
    const click = () => (domWindow.document.querySelector('.ac-dialog-button') as HTMLElement)
      .dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    click();
    expect(answers).toEqual(['first:true']);
    expect(domWindow.document.querySelectorAll('.ac-dialog-plate').length).toBe(1);
    expect(domWindow.document.querySelector('.ac-dialog-text')?.textContent).toContain('Second?');
    click();
    expect(answers).toEqual(['first:true', 'second:true']);
    expect(domWindow.document.querySelectorAll('.ac-dialog-plate').length).toBe(0);
  });

  it('button press swaps all three slices to the pressed art and back', async () => {
    const ui = await freshUi();
    ui.showConfirmationDialog('Do you accept?', () => {});
    const yes = domWindow.document.querySelector('.ac-dialog-button') as HTMLElement;
    yes.dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true }));
    expect(sliceTexes(yes)).toEqual(['0x06004c95', '0x06004c98', '0x06004c9b']);
    yes.dispatchEvent(new domWindow.MouseEvent('mouseup', { bubbles: true }));
    expect(sliceTexes(yes)).toEqual(['0x06004c96', '0x06004c99', '0x06004c9c']);
  });

  it('Yes/No clicks report the response and close the dialog', async () => {
    const ui = await freshUi();
    let result: boolean | null = null;
    ui.showConfirmationDialog('Do you accept?', (accepted: boolean) => { result = accepted; });
    const btns = [...domWindow.document.querySelectorAll('.ac-dialog-button')] as HTMLElement[];
    btns[1].dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(result).toBe(false);
    expect(domWindow.document.querySelector('.ac-dialog-plate')).toBeNull();

    ui.showConfirmationDialog('Again?', (accepted: boolean) => { result = accepted; });
    const yes = domWindow.document.querySelector('.ac-dialog-button') as HTMLElement;
    yes.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(result).toBe(true);
    expect(domWindow.document.querySelector('.ac-dialog-plate')).toBeNull();
  });

  it('connecting-screen Please Wait modal is the 400x84 retail WaitDialog plate', async () => {
    const ui = await freshUi();
    ui.showConnectingScreen();
    const blocker = domWindow.document.querySelector('#charsel-pleasewait') as HTMLElement;
    expect(blocker).toBeTruthy();
    const plate = blocker.querySelector('.ac-dialog-plate') as HTMLElement;
    expect(plate, 'Please Wait must use the shared retail plate chrome').toBeTruthy();
    expect(plate.style.width).toBe('400px');
    expect(plate.style.height).toBe('84px');
    expect(sliceTexes(plate)).toEqual(PLATE_SLICES);
    // Text region 0x3e at (15,15) 370x54, centered, DAT string 7426468.
    const textRegion = [...plate.children].find((c) => !(c as HTMLElement).hasAttribute('data-tex')) as HTMLElement;
    expect(textRegion).toBeTruthy();
    expect(textRegion.style.left).toBe('15px');
    expect(textRegion.style.top).toBe('15px');
    expect(textRegion.style.width).toBe('370px');
    expect(textRegion.style.height).toBe('54px');
    const span = textRegion.querySelector('[data-ac-text]') as HTMLElement | null;
    // replaceACTextElements may already have swapped the span for AC-font
    // canvas output; assert on whichever form is present.
    if (span) expect(span.getAttribute('data-ac-text')).toBe('Please Wait');
    else expect(textRegion.textContent ?? '').toContain('Please Wait');
  });

  it('no dialog site still uses the old flat CSS box (goldDim border chrome)', async () => {
    const ui = await freshUi();
    ui.showConfirmationDialog('Do you accept?', () => {});
    const plate = domWindow.document.querySelector('.ac-dialog-plate') as HTMLElement;
    expect(plate.style.border).toBe('');
    ui.hideConfirmationDialog();
    ui.showConnectingScreen();
    const blocker = domWindow.document.querySelector('#charsel-pleasewait') as HTMLElement;
    const dlg = blocker.querySelector('.ac-dialog-plate') as HTMLElement;
    expect(dlg.style.border).toBe('');
  });
});
