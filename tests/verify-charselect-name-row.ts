/**
 * VISUAL.charselect-name-row — the character-select list rows as
 * gmCharacterManagementUI::RebuildCharacterList @ 004ec3a0 builds them from
 * the listbox 0x21000004:0x1000039d's template 0x100003a5 (base
 * 0x21000042:0x10000488): row height max(H / max(slots, characters), H / 20),
 * the template's text style, and its three highlight slices drawn only in the
 * rollover (2) / selected (6, 7) states.
 *
 * Retail A/B evidence (verification/retail-ab/char-select/sheet.png): retail's
 * selected "+Obsprobe" row is ~29 px tall (320 / 11 ACE slots), an olive fill
 * with a yellow rim, the name cream in the plain UI font 6 px in; ours drew a
 * 20 px row, a grey tint with a gold left rule, and a wide gold serif.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import {
  charselRowHeight, charselRowState, charselHighlightSlices,
  CHARSEL_ROW_STATE_NORMAL, CHARSEL_ROW_STATE_ROLLOVER, CHARSEL_ROW_STATE_SELECTED, CHARSEL_ROW_STATE_SELECTED_ROLLOVER,
  CHARSEL_ROW_TEMPLATE_LAYOUT, CHARSEL_ROW_TEMPLATE_ELEMENT,
} from '../packages/renderer/src/ui/CharselListRows.js';
import { findElementByPath, textStyleFromDesc } from '../packages/renderer/src/ui/DatTextStyle.js';
import type { CharacterSlot } from '../packages/renderer/src/ui/CharacterSelect.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

function slot(id: string, name: string): CharacterSlot {
  return { id, name, level: 1, heritage: 1, gender: 1, location: '', lastPlayed: 0 };
}

describe('RebuildCharacterList — the row height', () => {
  it('splits the 320 px listbox between the account slots (ACE 11 → 29 px)', () => {
    expect(charselRowHeight(320, 11, 1)).toBe(29);
    expect(charselRowHeight(320, 11, 0)).toBe(29);
  });
  it('more characters than slots divide by the character count', () => {
    expect(charselRowHeight(320, 4, 5)).toBe(64);
  });
  it('never thinner than H / 0x14 (16 px for 320)', () => {
    expect(charselRowHeight(320, 25, 25)).toBe(16);
    expect(charselRowHeight(320, 0, 0)).toBe(16);
    expect(charselRowHeight(320, undefined, 0)).toBe(16);
  });
});

describe('the row state', () => {
  it('selected wins, rollover adds one', () => {
    expect(charselRowState(false, false)).toBe(CHARSEL_ROW_STATE_NORMAL);
    expect(charselRowState(false, true)).toBe(CHARSEL_ROW_STATE_ROLLOVER);
    expect(charselRowState(true, false)).toBe(CHARSEL_ROW_STATE_SELECTED);
    expect(charselRowState(true, true)).toBe(CHARSEL_ROW_STATE_SELECTED_ROLLOVER);
  });
});

describe.skipIf(!hasDats)('the DAT row template 0x21000004:0x100003a5', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let template: any;
  beforeAll(async () => {
    const dat = await import('@ac/dat-parser');
    dat.setMasterPropertyTypes(dat.parseMasterProperty(openDat(DAT_PATHS.portal).getReader(0x39000001)));
    const base = dat.parseLayoutDesc(openDat(DAT_PATHS.local).getReader(0x21000042));
    const own = dat.parseLayoutDesc(openDat(DAT_PATHS.local).getReader(CHARSEL_ROW_TEMPLATE_LAYOUT));
    const ref = findElementByPath(own, [CHARSEL_ROW_TEMPLATE_ELEMENT])!;
    expect([ref.baseLayout, ref.baseElement]).toEqual([0x21000042, 0x10000488]);
    template = findElementByPath(base, [0x10000488]);
  });

  it('text: font 0x40000000, cream 0xfffff2cc in every state, left / near, 6 px in', () => {
    for (const state of [undefined, 1, 2, 6, 7]) {
      const s = textStyleFromDesc(template, state);
      expect(s.font).toBe(0x40000000);
      expect(s.colorArgb >>> 0).toBe(0xfffff2cc);
      expect(s.hJustify).toBe(2);
      expect(s.marginLeft).toBe(6);
    }
  });

  it('a 29 px row: rim 0–3, body 4–26, bottom rim 27–30 (the template authors 18 px of slices in 16, so 2 px overhang and clip); selected = 0x06005ea7/a9/ab', () => {
    const sl = charselHighlightSlices(template, 29, CHARSEL_ROW_STATE_SELECTED);
    expect(sl.map(s => [s.y, s.height, s.file])).toEqual([[0, 4, 0x06005ea7], [4, 23, 0x06005ea9], [27, 4, 0x06005eab]]);
    expect(charselHighlightSlices(template, 29, CHARSEL_ROW_STATE_SELECTED_ROLLOVER).map(s => s.file))
      .toEqual([0x06005ea7, 0x06005ea9, 0x06005eab]);
  });

  it('rollover = 0x06005eb4/b5/b6; the normal state draws nothing', () => {
    expect(charselHighlightSlices(template, 29, CHARSEL_ROW_STATE_ROLLOVER).map(s => s.file)).toEqual([0x06005eb4, 0x06005eb5, 0x06005eb6]);
    expect(charselHighlightSlices(template, 29, CHARSEL_ROW_STATE_NORMAL).map(s => s.file)).toEqual([0, 0, 0]);
  });

  it('the authored 16 px height keeps the authored slices', () => {
    expect(charselHighlightSlices(template, 16, CHARSEL_ROW_STATE_SELECTED).map(s => [s.y, s.height])).toEqual([[0, 4], [4, 10], [14, 4]]);
  });
});

describe.skipIf(!hasDats)('the character list renders the retail rows (happy-dom)', () => {
  let H: GameUIFixture;
  beforeAll(async () => {
    H = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(openDat(DAT_PATHS.portal).getReader(0x39000001)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`, getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}` };
    H.ui.layoutRenderer = new LayoutRenderer(local, tex as never, null);
    H.ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
  }, 60_000);
  afterAll(() => H?.teardown());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (): any[] => Array.from(H.container.querySelectorAll('.char-slot'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hlTex = (r: any): string[] => Array.from(r.querySelectorAll('.char-slot-hl')).map((n: any) => n.dataset.tex);

  it('rows are 29 px for 11 slots; the selected row carries the three selected slices, the others none', () => {
    H.ui.showCharacterSelect([slot('1', '+Obsprobe'), slot('2', 'Beta')], 11);
    const all = rows();
    expect(all).toHaveLength(2);
    const sel = H.ui.selectScreen.selectedIndex;
    all.forEach((r, i) => {
      expect(r.style.height).toBe('29px');
      expect(r.style.width).toBe('160px');
      expect(r.style.borderLeft ?? '').toBe('');
      if (i === sel) {
        expect(r.dataset.state).toBe('0x6');
        expect(hlTex(r)).toEqual(['0x6005eab', '0x6005ea9', '0x6005ea7']);
      } else {
        expect(r.dataset.state).toBe('0x1');
        expect(hlTex(r)).toEqual([]);
      }
    });
  });

  it('rollover on an unselected row draws the rollover slices and leaving clears them', () => {
    H.ui.showCharacterSelect([slot('1', 'Alpha'), slot('2', 'Beta')], 11);
    const sel = H.ui.selectScreen.selectedIndex;
    const other = rows()[sel === 0 ? 1 : 0];
    other.dispatchEvent(new H.win.MouseEvent('mouseenter'));
    expect(other.dataset.state).toBe('0x2');
    expect(hlTex(other).sort()).toEqual(['0x6005eb4', '0x6005eb5', '0x6005eb6']);
    other.dispatchEvent(new H.win.MouseEvent('mouseleave'));
    expect(hlTex(other)).toEqual([]);
  });

  it('the name draws as the template text, padded p35 = 6 px', () => {
    H.ui.showCharacterSelect([slot('1', 'Alpha')], 11);
    const r = rows()[0];
    expect(r.style.paddingLeft).toBe('6px');
    const text = r.querySelector('[data-ac-desc]');
    expect(text.dataset.acDesc.toLowerCase()).toBe('21000004:100003a5');
  });
});
