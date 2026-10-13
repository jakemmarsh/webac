/**
 * A plugin window's redraw keeps the text box being typed in (ui/automation/keepFocus.ts). Mag-Tools' window redraws every
 * second; before this, the box was rebuilt mid-word and the next keys fell through to the game (a space jumped): found live
 * 2026-10-13 adding a periodic command.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redrawKeepingFocus } from '../packages/renderer/src/ui/automation/keepFocus.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

function form(root: HTMLElement, values: string[]): HTMLInputElement[] {
  root.innerHTML = '';
  return values.map((v, i) => { const e = root.ownerDocument.createElement('input'); e.value = v; if (i === 1) e.dataset.name = 'Periodic'; root.appendChild(e); return e; });
}

describe('redrawKeepingFocus', () => {
  it('puts focus and the caret back in the rebuilt box (by name, else by place), with what was typed', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const [, b] = form(root, ['', '/mt opt']);
    b!.focus(); b!.setSelectionRange(3, 3);
    redrawKeepingFocus(root, () => form(root, ['', '/mt']));
    const now = root.ownerDocument.activeElement as HTMLInputElement;
    expect(now.dataset.name).toBe('Periodic');
    expect(now.isConnected).toBe(true);
    expect(now.value).toBe('/mt opt');
    expect(now.selectionStart).toBe(3);
    root.remove();
  });

  it('leaves focus alone when nothing in the window had it', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    form(root, ['a']);
    redrawKeepingFocus(root, () => form(root, ['a']));
    expect(document.activeElement).toBe(outside);
    root.remove(); outside.remove();
  });
});

type Ui = { setPreviewFeatures(on: boolean): void; toggleVcsWindow(): void; hudContainer: HTMLElement; vtankWindows: Map<string, { el: HTMLElement; redraw: () => void }> };
let H: GameUIFixture;
beforeAll(async () => { H = await mountGameUI(); });
afterAll(() => H.teardown());

describe('GameUI: a plugin window redrawn while typing', () => {
  it('the Chat System\'s Action box keeps focus across a redraw (every plugin window redraws through the same path)', () => {
    const ui = H.ui as unknown as Ui;
    ui.setPreviewFeatures(true);
    ui.toggleVcsWindow();
    const win = ui.vtankWindows.get('vcs')!;
    const box = win.el.querySelector<HTMLInputElement>('input')!;
    expect(box).not.toBeNull();
    box.focus();
    box.value = '3';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    win.redraw();
    const now = H.win.document.activeElement as HTMLInputElement | null;
    expect(now?.tagName).toBe('INPUT');
    expect(win.el.contains(now)).toBe(true);
    ui.toggleVcsWindow();
    ui.setPreviewFeatures(false);
  });
});
