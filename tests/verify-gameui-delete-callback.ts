/**
 * ASSESS: char-select DELETE button must invoke the real onDeleteCharacter
 * wire callback via the in-game confirmation dialog — NOT a blocking
 * window.confirm() + local-array filter (which froze the renderer during the
 * 2026-06-10 live verification and never sent a packet).
 *
 * Drives the real GameUI under happy-dom: render char-select, click DELETE,
 * accept the confirmation dialog, assert the callback fired with the selected
 * slot. happy-dom via tests/_harness/dom.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI char-select DELETE → onDeleteCharacter wire callback', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  let confirmCalled = false;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // happy-dom doesn't expose rAF as a global — stub it (synchronous is fine).
    const g2 = globalThis as Record<string, unknown>;
    if (typeof g2.requestAnimationFrame !== 'function') {
      g2.requestAnimationFrame = (cb: (t: number) => void) => { cb(0); return 0; };
      g2.cancelAnimationFrame = () => {};
    }
    // A blocking confirm() must NOT be used — trip a flag if it ever is.
    (domWindow as { confirm?: () => boolean }).confirm = () => { confirmCalled = true; return true; };
    (globalThis as { confirm?: () => boolean }).confirm = (domWindow as { confirm: () => boolean }).confirm;
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  /** A char-select with one selected character; returns the UI, its container and the deleted-slot log. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function selectScreen(): { ui: any; container: any; deleted: Array<{ id: string; name: string }> } {
    const deleted: Array<{ id: string; name: string }> = [];
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container, {
      onDeleteCharacter: (slot: { id: string; name: string }) => { deleted.push(slot); return true; },
    });
    ui.showCharacterSelect([{ id: '12345', name: 'Deleteme Test', deleteTime: 0 }]);
    ui.selectScreen.selectCharacter(0);
    (ui as unknown as { renderCharacterSelect(): void }).renderCharacterSelect();
    return { ui, container, deleted };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function clickDelete(container: any): void {
    const buttons = Array.from(container.querySelectorAll('button')) as Array<{ textContent: string; dispatchEvent(e: unknown): void }>;
    const deleteBtn = buttons.find(b => (b.textContent ?? '').toUpperCase().includes('DELETE'));
    expect(deleteBtn).toBeTruthy();
    deleteBtn!.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dialogButtons = (): any[] => Array.from(domWindow.document.querySelectorAll('.ac-dialog-button'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entry = (): any => domWindow.document.querySelector('.ac-dialog-entry');

  it('DELETE opens the type-5 entry dialog naming the character; only the typed response deletes (_stricmp), via Please Wait (no window.confirm)', () => {
    confirmCalled = false;
    const { container, deleted } = selectScreen();
    clickDelete(container);
    const text = domWindow.document.querySelector('.ac-dialog-text');
    expect(text.textContent).toContain('Deleteme Test');
    expect(entry()).toBeTruthy();
    // Done with nothing typed: closed, nothing deleted.
    dialogButtons()[0].dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    expect(deleted).toEqual([]);
    expect(entry()).toBeNull();
    // Again (the one-at-a-time context was cleared): "delete" in any case + Done deletes.
    clickDelete(container);
    entry().value = 'delete';
    dialogButtons()[0].dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    expect(confirmCalled).toBe(false);
    expect(deleted.map((d) => d.id)).toEqual(['12345']);
    expect(domWindow.document.getElementById('charsel-pleasewait')).toBeTruthy();
  });

  it('Cancel deletes nothing even with DELETE typed, and a second DELETE click opens a fresh dialog', () => {
    const { container, deleted } = selectScreen();
    clickDelete(container);
    entry().value = 'DELETE';
    dialogButtons()[1].dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    expect(deleted).toEqual([]);
    clickDelete(container);
    expect(domWindow.document.querySelectorAll('.ac-dialog-entry').length).toBe(1);
  });

  it('with no wire handler nothing is mutated locally (the offline list filter is gone)', () => {
    const { ui, container } = selectScreen();
    ui.callbacks.onDeleteCharacter = undefined;
    clickDelete(container);
    entry().value = 'DELETE';
    dialogButtons()[0].dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    expect(ui.selectScreen.characters.length).toBe(1);
  });
});
