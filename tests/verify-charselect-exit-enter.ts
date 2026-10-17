/**
 * RECON.charselect-dat-controls — the char-select EXIT and ENTER buttons
 * follow gmCharacterManagementUI (decomp):
 *
 * - EXIT (0x100003a4) → MakeConfirmExitDialog @ 004ed250: a type-1 Yes/No
 *   dialog on ID_CharacterManagement_ConfirmExit ("Are you sure you want to
 *   leave?"), refused while one is open. Yes → RecvNotice_CloseDialog @
 *   004ed760 queues gmEpilogueUI (0x10000009), whose Message media is
 *   Device::Done (ours: the onExitGame callback). No leaves the screen as is.
 *   The old handler hid the whole screen container.
 * - ENTER (0x100003a2) → EnterGame @ 004ed440: MakeEnteringWorldDialog
 *   @ 004ed090 (type-2 wait dialog, ID_Character_EnteringWorld) then
 *   LogOnCharacter.
 * - A character row (0x100003a5) → message 0x1a → EnterGame
 *   (RECON.charselect-dat-controls.b). UIElement::MouseUp @ 00463940 sends
 *   0x1a for input action 10 = KeyMap 0x14000002 left button + activation
 *   0x60 MouseDblClick: double-clicking a name enters; one click only selects.
 *
 * Drives the real GameUI under happy-dom.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'requestAnimationFrame'] as const;

describe('RECON.charselect-dat-controls — char-select EXIT / ENTER', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  beforeAll(() => installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions'));
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function freshSelect(): Promise<{ ui: any; container: HTMLElement }> {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new mod.GameUI(container);
    // The screen reads only id/name (+ deleteTime) from a slot.
    ui.showCharacterSelect([
      { id: '1342177281', name: 'Alpha' },
      { id: '1342177282', name: 'Beta' },
    ] as unknown as Parameters<typeof ui.showCharacterSelect>[0]);
    return { ui, container };
  }
  const button = (container: HTMLElement, element: number): HTMLElement =>
    container.querySelector(`[data-ac-press="21000004:${element.toString(16)}"]`) as HTMLElement;
  const click = (el: Element): void => { el.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true })); };
  const dialogButtons = (): HTMLElement[] => [...domWindow.document.querySelectorAll('.ac-dialog-button')] as HTMLElement[];

  it('BUG.resume-silent-launcher — the page\'s own enter (auto-resume, URL auto-enter) goes through EnterGame: row selected, Entering World up', async () => {
    const { ui, container } = await freshSelect();
    const onEnterWorld = vi.fn();
    ui.callbacks.onEnterWorld = onEnterWorld;
    const beta = { id: '1342177282', name: 'Beta' };
    ui.autoEnterCharacter(beta);
    expect(onEnterWorld).toHaveBeenCalledWith(beta);
    expect(ui.selectScreen.selectedCharacter.name).toBe('Beta');
    // The wait dialog's full-screen blocker covers the World box / EXIT while the enter is under way
    // (GDLE's "still in the world" retries run behind it).
    const wait = container.querySelector('#charsel-enteringworld') as HTMLElement;
    expect(wait).toBeTruthy();
    expect(wait.style.pointerEvents).toBe('auto');
    // The agent tools' enter is refused while it is up, as a second ENTER would be.
    expect(ui.enterCharacterNamed('Alpha')).toBe('already entering the world');
    // A refusal that gives up (retail's char-select OK dialog) re-renders the screen without it.
    ui.showCharacterErrorDialog('refused', [
      { id: '1342177281', name: 'Alpha' }, beta,
    ] as unknown as Parameters<typeof ui.showCharacterSelect>[0]);
    expect(container.querySelector('#charsel-enteringworld')).toBeNull();
  });

  it('EXIT asks ID_CharacterManagement_ConfirmExit and No keeps the char-select screen', async () => {
    const { ui, container } = await freshSelect();
    const onExitGame = vi.fn();
    ui.callbacks.onExitGame = onExitGame;
    const exit = button(container, 0x100003a4);
    expect(exit).toBeTruthy();
    click(exit);
    expect(container.style.display).not.toBe('none');
    const plate = domWindow.document.querySelector('.ac-dialog-plate') as HTMLElement;
    expect(plate).toBeTruthy();
    expect(plate.textContent).toContain('Are you sure you want to leave?');
    // MakeConfirmExitDialog refuses a second dialog while one is open.
    click(exit);
    expect(domWindow.document.querySelectorAll('.ac-dialog-plate').length).toBe(1);

    const [, no] = dialogButtons();
    click(no);
    expect(domWindow.document.querySelector('.ac-dialog-plate')).toBeNull();
    expect(container.querySelector('#charsel-inner')).toBeTruthy();
    expect(onExitGame).not.toHaveBeenCalled();
    // The context is clear again: EXIT reopens the dialog.
    click(exit);
    expect(domWindow.document.querySelector('.ac-dialog-plate')).toBeTruthy();
  });

  it('Yes replaces the screen with the epilogue frame, whose Device::Done is onExitGame', async () => {
    const { ui, container } = await freshSelect();
    const onExitGame = vi.fn();
    ui.callbacks.onExitGame = onExitGame;
    click(button(container, 0x100003a4));
    const [yes] = dialogButtons();
    click(yes);
    expect(domWindow.document.querySelector('.ac-dialog-plate')).toBeNull();
    expect(container.querySelector('#charsel-inner')).toBeNull();
    const epilogue = container.querySelector('#epilogue-inner') as HTMLElement;
    expect(epilogue).toBeTruthy();
    expect(epilogue.dataset.acLayout).toBe('21000036');
    // The root's Message media fires on the next UI tick.
    await vi.waitFor(() => expect(onExitGame).toHaveBeenCalledTimes(1));
  });

  it('ENTER with a selection raises the Entering World wait dialog, then onEnterWorld', async () => {
    const { ui, container } = await freshSelect();
    const order: string[] = [];
    ui.callbacks.onEnterWorld = (slot: { name: string }) => {
      order.push(container.querySelector('#charsel-enteringworld') ? 'dialog-up' : 'no-dialog');
      order.push(slot.name);
    };
    // showCharacterSelect preselects (selectDefault); pick Beta explicitly.
    const beta = [...container.querySelectorAll('.char-slot-name')].find((n) => n.textContent?.includes('Beta'));
    expect(beta).toBeTruthy();
    click(beta!.parentElement!);
    expect(container.querySelector('#charsel-enteringworld')).toBeNull();
    click(button(container, 0x100003a2));
    expect(order).toEqual(['dialog-up', 'Beta']);
    const wait = container.querySelector('#charsel-enteringworld') as HTMLElement;
    const plate = wait.querySelector('.ac-dialog-plate') as HTMLElement;
    expect(plate.style.width).toBe('400px');
    expect(plate.style.height).toBe('84px');
    expect(wait.textContent).toContain('Entering World');
    // EnterGame's guard: a second ENTER does not stack a second dialog.
    ui.showEnteringWorldDialog();
    expect(container.querySelectorAll('#charsel-enteringworld').length).toBe(1);
    // The dialog belongs to the char-select screen: a re-render drops it.
    ui.showCharacterSelect([{ id: '1342177281', name: 'Alpha' }] as never);
    expect(container.querySelector('#charsel-enteringworld')).toBeNull();
  });

  // A click carrying its OS click count (UIEvent.detail), as the browser sends it.
  const clickN = (el: Element, detail: number): void => {
    el.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true, detail }));
  };
  const row = (container: HTMLElement, name: string): HTMLElement =>
    [...container.querySelectorAll('.char-slot')].find((n) => n.textContent?.includes(name)) as HTMLElement;

  it('double-clicking a name selects that character and enters the world (0x100003a5 message 0x1a)', async () => {
    const { ui, container } = await freshSelect();
    const order: string[] = [];
    ui.callbacks.onEnterWorld = (slot: { name: string }) => {
      order.push(container.querySelector('#charsel-enteringworld') ? 'dialog-up' : 'no-dialog');
      order.push(slot.name);
    };
    // The first click re-renders the list, so the second lands on a new row.
    clickN(row(container, 'Beta'), 1);
    expect(order).toEqual([]);
    expect(container.querySelector('#charsel-enteringworld')).toBeNull();
    expect(row(container, 'Beta').dataset.state).not.toBe(undefined);
    clickN(row(container, 'Beta'), 2);
    expect(order).toEqual(['dialog-up', 'Beta']);
    expect(ui.selectScreen.selectedCharacter.name).toBe('Beta');
  });

  it('a single click only selects; it never enters', async () => {
    const { ui, container } = await freshSelect();
    const onEnterWorld = vi.fn();
    ui.callbacks.onEnterWorld = onEnterWorld;
    clickN(row(container, 'Beta'), 1);
    clickN(row(container, 'Alpha'), 1);
    expect(onEnterWorld).not.toHaveBeenCalled();
    expect(ui.selectScreen.selectedCharacter.name).toBe('Alpha');
    expect(container.querySelector('#charsel-enteringworld')).toBeNull();
  });

  it('double-clicking a character pending deletion selects it but EnterGame refuses (GetGreyedOutFor != 0)', async () => {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = new mod.GameUI(container);
    ui.showCharacterSelect([
      { id: '1342177281', name: 'Alpha' },
      { id: '1342177282', name: 'Gamma', deleteTime: 3600 },
    ] as unknown as Parameters<typeof ui.showCharacterSelect>[0]);
    const onEnterWorld = vi.fn();
    ui.callbacks.onEnterWorld = onEnterWorld;
    clickN(row(container, 'Gamma'), 1);
    clickN(row(container, 'Gamma'), 2);
    expect(ui.selectScreen.selectedCharacter.name).toBe('Gamma');
    expect(onEnterWorld).not.toHaveBeenCalled();
    expect(container.querySelector('#charsel-enteringworld')).toBeNull();
    // ENTER, disabled for that selection, goes through the same guard.
    ui.enterSelectedCharacter();
    expect(onEnterWorld).not.toHaveBeenCalled();
  });
});
