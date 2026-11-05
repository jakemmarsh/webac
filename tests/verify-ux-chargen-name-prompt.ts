/**
 * UX.chargen-name-prompt — the "[ Name ]" prompt never ends up in a typed name.
 *
 * playwebac.com 2026-11-05 (build 53202d5a4, a new player on Coldeve, mouse
 * driven): the Summary page opens with retail's prompt selected whole; a
 * click into the field dropped the selection and put the cursor after the
 * prompt, typing gave "Quellio Davrenn[ Name ]" and FINISH refused it as
 * NameBanned (14 of 131 creates in a week hit that refusal). Retail did the
 * same (gmCGSummaryPage::ListenToElementMessage @ 0047bf40 only sets
 * m_bNameEntered; UIElement_Text::MouseDown @ 00469370 places the cursor in a
 * focused field), so this is a named browser-UX exception: while the prompt
 * is untouched a press selects it whole, the first edit of any kind replaces
 * all of it, Ctrl / Cmd+A selects the field, and FINISH strips any copy left.
 *
 * Drives the real GameUI chargen in happy-dom, end of retail / Dark Majesty
 * (no 1999 text) and the 1999 summary page (Chargen1999 set).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NameFilterRules } from '@ac/shared';
import { mountGameUI, openChargen, type GameUIFixture } from './_harness/gameui.js';
import { CreateStep } from '../packages/renderer/src/ui/CharacterCreate.js';
import { stripNamePrompt, textReplacingPrompt } from '../packages/renderer/src/ui/ChargenSummary.js';
import { snapshotWizard } from '../packages/renderer/src/ui/ChargenDraft.js';
import { scriptedRandomSource } from '../packages/renderer/src/ui/ChargenRandomize.js';
import type { Chargen1999 } from '../packages/renderer/src/ui/Chargen1999.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const PROMPT = '[ Name ]';

/** The English NameFilterTable entry's rules (as in verify-chargen-finish-refuses-invalid-name.ts). */
const RULES: NameFilterRules = {
  maximumSameCharactersInARow: 2,
  maximumVowelsInARow: 3,
  firstNCharactersMustHaveAVowel: 4,
  vowelContainingSubstringLength: 5,
  extraAllowedCharacters: "'-",
  compoundLetterGroups: ['th', 'ch', 'ph'],
};

const charGenShape = {
  starterAreas: ['Holtburg South', 'Rithwic East', 'Shoushi West'].map((name) => ({ name, locations: [] })),
  heritageGroups: new Map([1, 2, 3].map((h) => [h, {
    name: `h${h}`, iconImage: 0, setupId: 0, environmentSetupId: 0, attributeCredits: 330, skillCredits: 50,
    primaryStartAreas: [h - 1], secondaryStartAreas: [], skills: [],
    templates: [{ name: 'Adventurer', iconImage: 0, title: 0, strength: 10, endurance: 10, coordination: 10, quickness: 10, focus: 10, self: 10, normalSkillsList: [], primarySkillsList: [] }],
    genders: new Map(),
  }])),
};
const text1999: Chargen1999 = {
  heritageText: (h) => `heritage-${h}`,
  templateText: (h, t) => `template-${h}-${t}`,
  sexText: (h, g) => `sex-${h}-${g}`,
  pageHelp: (page) => `help-${page}`,
};

describe('textReplacingPrompt / stripNamePrompt', () => {
  it('keeps only what one edit of the prompt typed', () => {
    expect(textReplacingPrompt(PROMPT, 'Q')).toBe('Q'); // typed over the whole selection
    expect(textReplacingPrompt(PROMPT, `${PROMPT}Quellio`)).toBe('Quellio'); // cursor after the prompt
    expect(textReplacingPrompt(PROMPT, `Quellio${PROMPT}`)).toBe('Quellio'); // cursor before it
    expect(textReplacingPrompt(PROMPT, '[ NaQme ]')).toBe('Q'); // cursor inside it
    expect(textReplacingPrompt(PROMPT, '[ NName ]')).toBe('N'); // a letter the prompt holds
    expect(textReplacingPrompt(PROMPT, '[ Name ')).toBe(''); // Backspace at the end
    expect(textReplacingPrompt(PROMPT, PROMPT)).toBe('');
  });
  it('strips every copy of the prompt and nothing else', () => {
    expect(stripNamePrompt(`Quellio Davrenn${PROMPT}`, PROMPT)).toBe('Quellio Davrenn');
    expect(stripNamePrompt('Brenna Qaeol', PROMPT)).toBe('Brenna Qaeol');
    expect(stripNamePrompt('Name Brenna', PROMPT)).toBe('Name Brenna');
  });
});

describe('the summary name field and its prompt (real GameUI chargen)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H?.teardown());

  function open(era1999 = false): { ui: any; input: HTMLInputElement } {
    const ui = H.ui;
    ui.getTexURL = () => null;
    ui.charGen = charGenShape;
    ui.chargen1999 = era1999 ? text1999 : null;
    ui.paintChargenShadeDisk = () => {};
    ui.renderChargenPreview = () => {};
    ui.renderChargenSummaryView = () => {};
    ui.hideMessageDialog();
    ui.hideConfirmationDialog();
    ui.setNameValidationTables(RULES, null);
    openChargen(ui);
    ui.wizard.setProgressState(CreateStep.Summary);
    ui.wizard.currentStep = CreateStep.Summary;
    ui.renderCharacterCreate();
    const input = H.container.querySelector('#char-name-input') as HTMLInputElement;
    expect([input.value, input.dataset.prompt]).toEqual([PROMPT, '1']);
    expect(H.win.document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, PROMPT.length]);
    return { ui, input };
  }

  /** A key typed at the cursor, as the browser does it: beforeinput, the edit, input. */
  function type(input: HTMLInputElement, text: string): void {
    for (const ch of Array.from(text)) {
      const before = new H.win.InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true });
      if (!input.dispatchEvent(before)) continue;
      input.setRangeText(ch, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, 'end');
      input.dispatchEvent(new H.win.InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
    }
  }
  function backspace(input: HTMLInputElement): void {
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    if (start !== end) input.setRangeText('', start, end, 'end');
    else if (start > 0) input.setRangeText('', start - 1, start, 'end');
    input.dispatchEvent(new H.win.InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
  }
  const press = (input: HTMLInputElement): void => {
    input.dispatchEvent(new H.win.MouseEvent('mousedown', { button: 0, clientX: 200, bubbles: true, cancelable: true }));
    input.dispatchEvent(new H.win.MouseEvent('mouseup', { button: 0, clientX: 200, bubbles: true }));
  };
  function finish(ui: any): { sent: string | null; dialogs: string[] } {
    let sent: string | null = null;
    ui.callbacks.onCharacterCreated = (w: any) => { sent = w.name; return true; };
    const dialogs: string[] = [];
    ui.showMessageDialog = (text: string) => { dialogs.push(text); };
    ui.wizard.attributes.strength += ui.wizard.attributesRemaining;
    ui.doChargenFinish(false);
    ui.noteCharGenVerificationResponse?.();
    delete ui.showMessageDialog;
    return { sent, dialogs };
  }

  for (const era1999 of [false, true]) {
    const era = era1999 ? 'AC1999 summary page' : 'end of retail / Dark Majesty';

    it(`${era}: a click into the untouched prompt selects it whole, and typing gives only the name`, () => {
      const { ui, input } = open(era1999);
      // The cursor somewhere else first (the old click put it after the prompt).
      input.setSelectionRange(PROMPT.length, PROMPT.length);
      press(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, PROMPT.length]);
      type(input, 'Quellio Davrenn');
      expect([input.value, ui.wizard.name, input.dataset.prompt]).toEqual(['Quellio Davrenn', 'Quellio Davrenn', '0']);
      // Once a name is in, a click places the cursor as retail's does (no select-all).
      input.setSelectionRange(3, 3);
      press(input);
      expect(input.selectionStart).toBe(input.selectionEnd);
      expect(finish(ui)).toEqual({ sent: 'Quellio Davrenn', dialogs: [] });
    });

    it(`${era}: typing with the cursor after the prompt (the 2026-11-05 path) still replaces it`, () => {
      const { ui, input } = open(era1999);
      input.setSelectionRange(PROMPT.length, PROMPT.length);
      type(input, 'Quellio Davrenn');
      expect([input.value, ui.wizard.name]).toEqual(['Quellio Davrenn', 'Quellio Davrenn']);
      expect(finish(ui).sent).toBe('Quellio Davrenn');
    });
  }

  it('typing without a click replaces the selected prompt (retail\'s SelectAll path, unchanged)', () => {
    const { ui, input } = open();
    type(input, 'Brenna');
    expect([input.value, ui.wizard.name]).toEqual(['Brenna', 'Brenna']);
  });

  it('a paste into the prompt keeps only the pasted name, NameInputFilter applied', () => {
    const { ui, input } = open();
    input.setSelectionRange(PROMPT.length, PROMPT.length);
    const before = new H.win.InputEvent('beforeinput', { inputType: 'insertFromPaste', data: 'Quel1lio Da#vrenn', bubbles: true, cancelable: true });
    input.dispatchEvent(before); // the filter refuses '1' and '#', inserts the rest and sends input
    expect([input.value, ui.wizard.name]).toEqual(['Quellio Davrenn', 'Quellio Davrenn']);
  });

  it('an IME composition stays put until it commits; the commit replaces the prompt', () => {
    const { ui, input } = open();
    input.setSelectionRange(PROMPT.length, PROMPT.length);
    input.setRangeText('Bre', PROMPT.length, PROMPT.length, 'end');
    input.dispatchEvent(new H.win.InputEvent('input', { inputType: 'insertCompositionText', data: 'Bre', isComposing: true, bubbles: true }));
    expect(input.value).toBe(`${PROMPT}Bre`);
    expect(ui.wizard.name).toBe('');
    input.setRangeText('Brenna', PROMPT.length, PROMPT.length + 3, 'end');
    input.dispatchEvent(new H.win.Event('compositionend', { bubbles: true }));
    expect([input.value, ui.wizard.name, input.dataset.prompt]).toEqual(['Brenna', 'Brenna', '0']);
  });

  it('Ctrl+A and Cmd+A select the whole field', () => {
    const { input } = open();
    type(input, 'Brenna');
    expect([input.selectionStart, input.selectionEnd]).toEqual([6, 6]);
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      input.setSelectionRange(2, 2);
      const ev = new H.win.KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true, ...mod });
      expect(input.dispatchEvent(ev)).toBe(false); // the default (macOS Ctrl+A: line start) is taken
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);
    }
    // Plain 'a' is just a letter.
    const plain = new H.win.KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true });
    expect(input.dispatchEvent(plain)).toBe(true);
  });

  it('Backspace on the untouched prompt empties the field; Backspace to empty then typing gives the new name', () => {
    const { ui, input } = open();
    input.setSelectionRange(PROMPT.length, PROMPT.length);
    backspace(input);
    expect([input.value, ui.wizard.name, input.dataset.prompt]).toEqual(['', '', '0']);
    type(input, 'Bo');
    backspace(input); backspace(input);
    expect(ui.wizard.name).toBe('');
    type(input, 'Brenna');
    expect([input.value, ui.wizard.name]).toEqual(['Brenna', 'Brenna']);
    // An emptied field at FINISH is no name (NoNameWarning), not a refusal.
    backspace(input); backspace(input); backspace(input); backspace(input); backspace(input); backspace(input);
    const r = finish(ui);
    expect(r.sent).toBeNull();
    expect(r.dialogs).toEqual(['You must enter a name for this character!']);
  });

  it('FINISH strips a prompt still in the name; a genuinely invalid name is still refused (name_banned)', () => {
    const { ui, input } = open();
    ui.wizard.setName(`Quellio Davrenn${PROMPT}`);
    ui.chargenNameEntered = true;
    expect(finish(ui)).toEqual({ sent: 'Quellio Davrenn', dialogs: [] });
    const blocked: string[] = [];
    ui.callbacks.onChargenFinish = (_kind: string, reason: string) => { blocked.push(reason); };
    press(input); // a name is entered: no select-all
    input.setSelectionRange(0, input.value.length);
    type(input, 'Aaaa');
    expect(ui.wizard.name).toBe('Aaaa');
    const r = finish(ui);
    expect(r.sent).toBeNull();
    expect(r.dialogs).toHaveLength(1);
    expect(blocked).toContain('name_banned');
    delete ui.callbacks.onChargenFinish;
  });

  it('a chargen draft keeps the typed name (not the prompt) and restores it into the field', () => {
    const { ui, input } = open();
    input.setSelectionRange(PROMPT.length, PROMPT.length);
    type(input, 'Brenna Qaeol');
    const cap = ui.captureChargenDraft();
    expect([cap.wizard.name, cap.wizard.nameEntered]).toEqual(['Brenna Qaeol', true]);
    ui.showCharacterSelect([], 5);
    ui.chargenRandomSource = scriptedRandomSource([0], [0]);
    ui.showCharacterCreate(cap.wizard);
    expect(ui.lastChargenRestore).toBe('restored');
    const restored = H.container.querySelector('#char-name-input') as HTMLInputElement;
    expect([restored.value, restored.dataset.prompt]).toEqual(['Brenna Qaeol', '0']);
    // A click into a restored name places the cursor; it is not the prompt.
    restored.setSelectionRange(12, 12);
    press(restored);
    expect(restored.selectionStart).toBe(restored.selectionEnd);
    expect(snapshotWizard(ui.wizard, ui.chargenNameEntered).name).toBe('Brenna Qaeol');
    expect(finish(ui).sent).toBe('Brenna Qaeol');
  });
});
