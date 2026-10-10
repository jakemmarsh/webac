/**
 * FINISH refuses a name outside the DAT name rules.
 *
 * Retail's server answered such a name with CharGenVerificationResponse
 * NameBanned and the client showed ID_Character_Err_NameBanned. ACE does not
 * check the characters, so clicking into the "[ Name ]" prompt (a click
 * places the cursor, gmCGSummaryPage) and typing created a character named
 * "Name ]Brenna Qaeol" (2026-10-08). FINISH now applies the NameFilterTable /
 * TabooTable rules the client already loads, before the request goes out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { NameFilterRules } from '@ac/shared';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

/** The English NameFilterTable entry's rules (as in verify-validate-name-with-rules.ts). */
const RULES: NameFilterRules = {
  maximumSameCharactersInARow: 2,
  maximumVowelsInARow: 3,
  firstNCharactersMustHaveAVowel: 4,
  vowelContainingSubstringLength: 5,
  extraAllowedCharacters: "'-",
  compoundLetterGroups: ['th', 'ch', 'ph'],
};

describe('chargen FINISH and the DAT name rules', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUI: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    GameUI = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  function finishWith(name: string): { sent: number; dialogs: string[] } {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    let sent = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = new GameUI(container, { onCharacterCreated: () => { sent++; } });
    const dialogs: string[] = [];
    ui.showMessageDialog = (text: string) => { dialogs.push(text); };
    ui.setNameValidationTables(RULES, null);
    ui.showCharacterCreate();
    ui.wizard.setName(name);
    ui.chargenNameEntered = true;
    ui.doChargenFinish(false);
    return { sent, dialogs };
  }

  it('"Name ]Brenna Qaeol" (the prompt left in) is refused with the NameBanned text and nothing is sent', () => {
    const r = finishWith('Name ]Brenna Qaeol');
    expect(r.sent).toBe(0);
    expect(r.dialogs).toHaveLength(1);
  });

  it('"Brenna Qaeol" goes out', () => {
    const r = finishWith('Brenna Qaeol');
    expect(r.dialogs).toEqual([]);
    expect(r.sent).toBe(1);
  });

  it('the untouched prompt still gets the no-name warning, not the refusal (DoFinish trims "[] " first)', () => {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = new GameUI(container, {});
    const dialogs: string[] = [];
    ui.showMessageDialog = (text: string) => { dialogs.push(text); };
    ui.setNameValidationTables(RULES, null);
    ui.showCharacterCreate();
    ui.wizard.setName('[ Name ]');
    ui.doChargenFinish(false);
    expect(dialogs).toEqual(['You must enter a name for this character!']);
  });
});
