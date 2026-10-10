/**
 * BUG.charsel-no-default-selection — char select must open with a character
 * selected (ENTER lit), as retail's gmCharacterManagementUI::
 * RebuildCharacterList @ 004ec3a0 always ends in
 * UIElement_ListBox::SetSelectedItem + UpdateButtons. Its pick order:
 *   1. the row at the ClientCharGenState slot (+0x208 — CharGenState::SetSlot;
 *      disassembly `cmp edx,[eax+0x208]` @ 004ec621), the character just
 *      created — our host enters the world straight after CharacterCreate;
 *   2. the row whose iid == m_iidSelectedCharacter (previous selection);
 *   3. the first row in CharacterSet order whose GetGreyedOutFor == 0
 *      (secondsGreyedOut_, i.e. ACE's deleteTime) — scanned BEFORE the sort;
 *   4. else item 0, also captured before the sort.
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

function screenOf(slots: CharacterSlot[]): CharacterSelectScreen {
  const s = new CharacterSelectScreen();
  for (const c of slots) s.addCharacter(c);
  return s;
}

describe('CharacterSelectScreen.selectDefault — RebuildCharacterList pick order', () => {
  it('selects the first non-greyed character in server order', () => {
    const s = screenOf([slot('1', 'Doomed', { deleteTime: 30 }), slot('2', 'Alive'), slot('3', 'Other')]);
    s.selectDefault();
    expect(s.selectedCharacter?.id).toBe('2');
  });

  it('uses server order, not the display sort, for the fallback', () => {
    const s = screenOf([slot('1', 'Zed'), slot('2', 'Abe')]);
    s.sortRetailOrder();
    expect(s.slots[0].id).toBe('2');
    s.selectDefault();
    expect(s.selectedCharacter?.id).toBe('1');
  });

  it('keeps the previous selection, even when it is now pending deletion', () => {
    const s = screenOf([slot('1', 'A'), slot('2', 'B', { deleteTime: 5 })]);
    s.selectDefault('2');
    expect(s.selectedCharacter?.id).toBe('2');
  });

  it('ignores a previous id no longer in the set', () => {
    const s = screenOf([slot('1', 'A'), slot('2', 'B')]);
    s.selectDefault('99');
    expect(s.selectedCharacter?.id).toBe('1');
  });

  it('with every character greyed, falls back to the first in server order', () => {
    const s = screenOf([slot('1', 'B', { deleteTime: 3 }), slot('2', 'A', { deleteTime: 4 })]);
    s.sortRetailOrder();
    expect(s.slots[0].id).toBe('2');
    s.selectDefault();
    expect(s.selectedCharacter?.id).toBe('1');
  });

  it('an empty set selects nothing', () => {
    const s = new CharacterSelectScreen();
    s.selectDefault('1');
    expect(s.selectedIndex).toBe(-1);
  });

  it('a removed character leaves the server-order fallback', () => {
    const s = screenOf([slot('1', 'A'), slot('2', 'B')]);
    s.removeCharacter('1');
    s.selectDefault();
    expect(s.selectedCharacter?.id).toBe('2');
  });
});

describe('GameUI.showCharacterSelect — opens with a selection and a lit ENTER', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function make(): { ui: any; container: any } {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return { ui: new GameUICtor(container, {}), container };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function enterButton(container: any): any {
    const buttons = Array.from(container.querySelectorAll('button')) as Array<{ textContent: string }>;
    return buttons.find(b => (b.textContent ?? '').toUpperCase().includes('ENTER'));
  }

  it('the first show selects the first playable character and enables ENTER', () => {
    const { ui, container } = make();
    ui.showCharacterSelect([slot('1', 'Doomed', { deleteTime: 9 }), slot('2', 'Perf Tester')], 11);
    expect(ui.selectScreen.selectedCharacter?.id).toBe('2');
    const enter = enterButton(container);
    expect(enter).toBeTruthy();
    expect(enter.disabled).toBe(false);
  });

  it('a rebuild on the same screen (delete / restore) keeps the selected character', () => {
    const { ui } = make();
    const set = [slot('1', 'A'), slot('2', 'B')];
    ui.showCharacterSelect(set, 11);
    ui.selectScreen.selectCharacter(ui.selectScreen.slots.findIndex((c: CharacterSlot) => c.id === '2'));
    ui.showCharacterSelect([slot('1', 'A'), slot('2', 'B', { deleteTime: 1 })], 11);
    expect(ui.selectScreen.selectedCharacter?.id).toBe('2');
  });

  it('after the connecting screen the list starts from the default pick', () => {
    const { ui } = make();
    ui.showConnectingScreen();
    ui.showCharacterSelect([slot('1', 'A'), slot('2', 'B')], 11);
    expect(ui.selectScreen.selectedCharacter?.id).toBe('1');
  });

  it('an empty account opens with nothing selected and ENTER disabled', () => {
    const { ui, container } = make();
    ui.showCharacterSelect([], 11);
    expect(ui.selectScreen.selectedCharacter).toBeUndefined();
    const enter = enterButton(container);
    if (enter) expect(enter.disabled).toBe(true);
  });
});
