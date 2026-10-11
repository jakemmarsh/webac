/**
 * BUG.charsel-list-order — char select lists characters in retail's order:
 * gmCharacterManagementUI::RebuildCharacterList @ 004ec3a0 fills the list in
 * CharacterSet order, bubble-sorts it ascending by row text (swap while
 * wcscmp(a, b) > 0 — UTF-16 code-unit order, case-sensitive), then moves
 * every CharacterSet::GetGreyedOutFor != 0 row (pending deletion) to the end,
 * keeping their sorted order. Not last-played order.
 *
 * Drives the real CharacterSelectScreen and GameUI (happy-dom harness).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { CharacterSelectScreen, type CharacterSlot } from '../packages/renderer/src/ui/CharacterSelect.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

function slot(id: string, name: string, extra: Partial<CharacterSlot> = {}): CharacterSlot {
  return { id, name, level: 1, heritage: 1, gender: 1, location: '', lastPlayed: 0, ...extra };
}

function sorted(slots: CharacterSlot[]): string[] {
  const s = new CharacterSelectScreen();
  for (const c of slots) s.addCharacter(c);
  s.sortRetailOrder();
  return s.slots.map(c => c.name);
}

describe('CharacterSelectScreen.sortRetailOrder', () => {
  it('sorts ascending by name regardless of server order or last played', () => {
    expect(sorted([
      slot('1', 'Zorro', { lastPlayed: 99 }),
      slot('2', 'Aldo', { lastPlayed: 1 }),
      slot('3', 'Merek', { lastPlayed: 50 }),
    ])).toEqual(['Aldo', 'Merek', 'Zorro']);
  });

  it('compares by code unit like wcscmp: upper case before lower case, "+" before letters', () => {
    expect(sorted([slot('1', 'bob'), slot('2', 'Zed'), slot('3', '+Admin'), slot('4', 'Bob')]))
      .toEqual(['+Admin', 'Bob', 'Zed', 'bob']);
  });

  it('a name that is a prefix of another sorts first', () => {
    expect(sorted([slot('1', 'Anna Lee'), slot('2', 'Anna')])).toEqual(['Anna', 'Anna Lee']);
  });

  it('moves pending-deletion characters to the end, still name-sorted', () => {
    expect(sorted([
      slot('1', 'Carl', { deleteTime: 10 }),
      slot('2', 'Beth'),
      slot('3', 'Adam', { deleteTime: 20 }),
      slot('4', 'Dora'),
    ])).toEqual(['Beth', 'Dora', 'Adam', 'Carl']);
  });

  it('the selection follows its character through the sort', () => {
    const s = new CharacterSelectScreen();
    for (const c of [slot('1', 'Zed'), slot('2', 'Abe')]) s.addCharacter(c);
    s.selectCharacter(0);
    s.sortRetailOrder();
    expect(s.selectedIndex).toBe(1);
    expect(s.selectedCharacter?.id).toBe('1');
  });
});

describe('GameUI.showCharacterSelect — rows render in retail order', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('draws the list name-sorted with pending deletions last, selecting the first playable in server order', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container, {});
    ui.showCharacterSelect([
      slot('1', 'Perf Tester'),
      slot('2', 'Doomed', { deleteTime: 9 }),
      slot('3', 'Alpha'),
    ], 11);
    const rows = Array.from(container.querySelectorAll('.char-slot')) as Array<{ querySelector(s: string): { getAttribute(a: string): string } | null }>;
    const names = rows.map(r => r.querySelector('[data-ac-run-text]')?.getAttribute('data-ac-run-text'));
    expect(names).toEqual(['Alpha', 'Perf Tester', 'Doomed']);
    // The default pick scans server order before the sort: 'Perf Tester'.
    expect(ui.selectScreen.selectedCharacter?.id).toBe('1');
    expect(ui.selectScreen.selectedIndex).toBe(1);
    // The listbox 0x1000039d names no scrollbar: the rows' scroller never shows an OS bar.
    const row = container.querySelector('.char-slot') as unknown as HTMLElement;
    let scroller: HTMLElement | null = row.parentElement;
    while (scroller && scroller.style.overflowY !== 'auto') scroller = scroller.parentElement;
    expect(scroller).not.toBeNull();
    expect(scroller!.style.getPropertyValue('scrollbar-width')).toBe('none');
  });
});
