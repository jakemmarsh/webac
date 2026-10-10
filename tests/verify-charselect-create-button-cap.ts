/**
 * BUG.character-select-create-button-not-capped — the Create Character
 * button must disable once the account is at its character-slot cap.
 *
 * ACE GameMessageCharacterList.cs:32-33 writes CharacterList.SlotCount from
 * max_chars_per_account; the decompiled retail client's
 * gmCharacterManagementUI::UpdateButtons (acclient-decompiled.c ~0x004ec240)
 * disables the Create Character button (state 0xd) once
 * numAllowedCharacters_ <= the current character count. Our client parsed
 * slotCount off the wire but never compared it against characters.length —
 * the button (already wired with the correct disabled-state texture via
 * skinBtn's `dis` param) stayed unconditionally enabled.
 *
 * Behavioral suite — drives the real GameUI/CharacterSelectScreen classes
 * under happy-dom (same harness as verify-charselect-no-resurrect.ts;
 * tests/_harness/dom.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { CharacterSelectScreen, type CharacterSlot } from '../packages/renderer/src/ui/CharacterSelect.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

function makeSlot(id: string, name: string): CharacterSlot {
  return { id, name, level: 1, heritage: 1, gender: 1, location: '', lastPlayed: 0 };
}

describe('CharacterSelectScreen.atSlotCap', () => {
  it('is false when slotCount is unknown (undefined)', () => {
    const screen = new CharacterSelectScreen();
    screen.addCharacter(makeSlot('1', 'A'));
    expect(screen.atSlotCap).toBe(false);
  });

  it('is false when character count is below the slot cap', () => {
    const screen = new CharacterSelectScreen();
    screen.slotCount = 3;
    screen.addCharacter(makeSlot('1', 'A'));
    expect(screen.atSlotCap).toBe(false);
  });

  it('is true once character count reaches the slot cap', () => {
    const screen = new CharacterSelectScreen();
    screen.slotCount = 2;
    screen.addCharacter(makeSlot('1', 'A'));
    screen.addCharacter(makeSlot('2', 'B'));
    expect(screen.atSlotCap).toBe(true);
  });
});

describe('BUG.character-select-create-button-not-capped — GameUI render', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  let createNewCalls = 0;

  beforeAll(() => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  // Each case gets its own container — GameUI doesn't clear a pre-existing
  // container on construction, so reusing one across instances leaves stale
  // DOM from the previous instance for querySelector to pick up.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function freshContainer(): any {
    const el = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(el);
    return el;
  }

  it('below the slot cap: Create Character stays enabled and clickable', async () => {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    createNewCalls = 0;
    const container = freshContainer();
    const ui = new mod.GameUI(container, { onCreateNew: () => { createNewCalls++; } });
    ui.showCharacterSelect([makeSlot('1', 'A')], 10);
    const btn = container.querySelector('#btn-create-character');
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
    btn.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(createNewCalls).toBe(1);
  });

  it('at the slot cap: Create Character disables and the click is a no-op', async () => {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    createNewCalls = 0;
    const container = freshContainer();
    const ui = new mod.GameUI(container, { onCreateNew: () => { createNewCalls++; } });
    ui.showCharacterSelect([makeSlot('1', 'A'), makeSlot('2', 'B')], 2);
    const btn = container.querySelector('#btn-create-character');
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
    btn.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(createNewCalls).toBe(0);
  });

  it('with no slotCount passed (unknown cap): Create Character stays enabled', async () => {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    createNewCalls = 0;
    const container = freshContainer();
    const ui = new mod.GameUI(container, { onCreateNew: () => { createNewCalls++; } });
    ui.showCharacterSelect([makeSlot('1', 'A'), makeSlot('2', 'B')]);
    const btn = container.querySelector('#btn-create-character');
    expect(btn.disabled).toBe(false);
  });
});
