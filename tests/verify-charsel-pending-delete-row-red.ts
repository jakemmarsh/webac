/**
 * VISUAL.charsel-pending-delete-row-red — a character-select row is exactly
 * retail's: gmCharacterManagementUI::RebuildCharacterList @ 004ec3a0 SetTexts
 * the row's text child with CharacterSet::GetName and nothing else, and for a
 * row whose CharacterSet::GetGreyedOutFor @ 004fdfa0 != 0 (the identity's
 * secondsGreyedOut_; ACE GameMessageCharacterList.cs:28 deleteTime > 0) sets
 * colour property 0x19 = RGBA(1,0,0,1) as the text's 0x1b font colour — red.
 * No "(deletion pending)" suffix, no dimming, no "Level N Heritage" line.
 * gmCharacterManagementUI::UpdateButtons @ 004ec240 disables ENTER (state
 * 0xd) for a greyed-out selection and shows RESTORE in DELETE's place.
 *
 * Drives the real GameUI in happy-dom (no DATs: text renders as styled spans).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import type { CharacterSlot } from '../packages/renderer/src/ui/CharacterSelect.js';

function slot(id: string, name: string, extra: Partial<CharacterSlot> = {}): CharacterSlot {
  return { id, name, level: 42, heritage: 1, gender: 1, location: '', lastPlayed: 0, ...extra };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type El = any;

describe('VISUAL.charsel-pending-delete-row-red', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); }, 60_000);
  afterAll(() => H?.teardown());

  function rows(): El[] {
    return Array.from(H.container.querySelectorAll('.char-slot'));
  }
  function runs(row: El): El[] {
    return Array.from(row.querySelectorAll('[data-ac-run-text]'));
  }
  function enterButton(): El {
    return Array.from(H.container.querySelectorAll('button'))
      .find((b: El) => b.querySelector('[data-ac-run-text]')?.getAttribute('data-ac-run-text') === 'ENTER');
  }

  it('the retail red is RGBA(1,0,0,1)', () => {
    expect(H.mod.CHARSEL_PENDING_DELETE_COLOR).toBe('#ff0000');
  });

  it('a pending-deletion row is its name alone, in red, undimmed', () => {
    H.ui.showCharacterSelect([slot('1', 'Alpha'), slot('2', 'Doomed', { deleteTime: 120 })], 11);
    const doomed = rows().find(r => runs(r)[0]?.getAttribute('data-ac-run-text') === 'Doomed');
    expect(doomed).toBeDefined();
    const texts = runs(doomed);
    expect(texts.map((t: El) => t.getAttribute('data-ac-run-text'))).toEqual(['Doomed']);
    expect(doomed.textContent).not.toMatch(/deletion pending/i);
    expect(doomed.textContent).not.toMatch(/Level/);
    const c = texts[0].style.color;
    expect(c === '#ff0000' || c === 'rgb(255, 0, 0)').toBe(true);
    expect(doomed.style.opacity).toBe('');
  });

  it('normal rows are their name alone, all in one colour (no Level/Heritage line)', () => {
    H.ui.showCharacterSelect([slot('1', 'Alpha'), slot('2', 'Beta')], 11);
    const all = rows();
    expect(all).toHaveLength(2);
    for (const r of all) {
      expect(runs(r)).toHaveLength(1);
      expect(r.textContent).not.toMatch(/Level|Aluvian/);
      expect(r.style.opacity).toBe('');
    }
    // VISUAL.charselect-name-row — every row draws in the template text's
    // own colour (0x21000004:0x100003a5, cream 0xfffff2cc with DATs; the
    // UI fallback colour here without them), selected or not: selection is
    // the template's highlight slices, not a text colour change.
    const colours = all.map(r => runs(r)[0].style.color);
    expect(new Set(colours).size).toBe(1);
    for (const c of colours) expect(c).not.toMatch(/255, 0, 0|#ff0000/);
  });

  it('ENTER is disabled for a pending-deletion selection and fires nothing', () => {
    let entered = 0;
    H.ui.callbacks.onEnterWorld = () => { entered++; };
    H.ui.showCharacterSelect([slot('2', 'Doomed', { deleteTime: 5 })], 11);
    H.ui.selectScreen.selectCharacter(0);
    H.ui.renderCharacterSelect();
    const btn = enterButton();
    expect(btn).toBeDefined();
    expect(btn.disabled).toBe(true);
    btn.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
    expect(entered).toBe(0);
  });

  it('ENTER stays enabled for a normal selection', () => {
    let entered = 0;
    H.ui.callbacks.onEnterWorld = () => { entered++; };
    H.ui.showCharacterSelect([slot('1', 'Alpha')], 11);
    H.ui.selectScreen.selectCharacter(0);
    H.ui.renderCharacterSelect();
    const btn = enterButton();
    expect(btn.disabled).toBe(false);
    btn.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
    expect(entered).toBe(1);
  });
});
