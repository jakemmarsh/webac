/**
 * FAITHFUL.359 — Character-name input (char-gen wizard) suppresses
 *  browser autofill/spellcheck/autocapitalize/autocorrect.
 *
 * Same retail-fidelity gap as FAITHFUL.358 for the chat input. The
 * character-creation wizard's name field is a `<input type="text">`
 * that previously inherited browser defaults:
 *   - autocomplete=on → browser suggests prior character names from
 *     other AC sessions or even non-AC forms
 *   - spellcheck=true → red squiggles on most player-chosen names
 *     (any non-dictionary word)
 *   - autocapitalize=on (mobile) → forces the first letter uppercase,
 *     blocking lowercase-first names like "iSlasher"
 *   - autocorrect=on (iOS) → substitutes the half-typed name with a
 *     dictionary word, e.g. typing "Aer" → "Are"
 *
 * Retail AC let the player type any name with any case. Setting all
 * four to "off" matches that.
 *
 * DEBT.test-harness-hygiene: converted from a GameUI.ts source pin — the
 * real Summary-step markup (renderFinishStep) is parsed into the DOM and
 * the live input's attributes are asserted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('char-name-input suppresses browser interference (FAITHFUL.359)', () => {
  let H: GameUIFixture;
  let input: HTMLInputElement;
  beforeAll(async () => {
    H = await mountGameUI();
    const host = H.win.document.createElement('div');
    host.innerHTML = H.ui.renderFinishStep();
    H.container.appendChild(host);
    input = host.querySelector('#char-name-input') as HTMLInputElement;
  });
  afterAll(() => H.teardown());

  it('the Summary step renders the name input', () => {
    expect(input).not.toBeNull();
    expect(input.getAttribute('type')).toBe('text');
  });

  it.each([
    ['autocomplete', 'off'],
    ['spellcheck', 'false'],
    ['autocapitalize', 'off'],
    ['autocorrect', 'off'],
  ])('input declares %s="%s"', (attr, value) => {
    expect(input.getAttribute(attr)).toBe(value);
  });
});
