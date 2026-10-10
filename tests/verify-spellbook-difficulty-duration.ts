/**
 * Spellbook detail difficulty/duration (was FAITHFUL.325) — RETIRED WITH THE SPELLBOOK DETAIL BLOCK (decision 2026-06-10).
 *
 * FAITHFUL.325 originally surfaced difficulty + duration in the spellbook's bottom-detail
 * area. That detail block was an invention: the DAT footer (0x21000032
 * element 0x10000297) carries ONLY the Schools:/Levels: filter captions,
 * the radio rows, and the Delete button — no spell-detail area (see
 * verification/panel-specs/magic-spellbook.md). Per Jake's decision (2b,
 * 2026-06-10) the block was dropped and the DAT footer restored
 * (VISUAL.136/.138).
 *
 * The spell-bar tooltip half (no Difficulty/Duration lines — retail's
 * shortcut tooltip is the spell name, SpellCastSubMenu::UpdateFromPlayerModule
 * @ 004c6570) is proven behaviourally in
 * tests/verify-spell-tooltip-difficulty-duration.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withSpellRowTemplate } from './_harness/spell-row-stub.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const SPELL = {
  id: 1, name: 'Strength Other I', desc: 'UNIQUE_DETAIL_DESCRIPTION_TEXT',
  school: 4, level: 1, power: 1, manaCost: 777, difficulty: 4321, duration: 1800,
  components: [], targetType: 0,
};

describe('FAITHFUL.325 (retired placement) — spellbook detail block removed (behavioural, real renderMagicPanel)', () => {
  let H: GameUIFixture;
  const texts = new Map<number, string>();
  beforeAll(async () => {
    H = await mountGameUI();
    const win = H.win;
    const renderPanel = (_layoutId: number, parent: HTMLElement) => {
      const wrapper = win.document.createElement('div');
      parent.appendChild(wrapper);
      const root = win.document.createElement('div');
      wrapper.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const get = elements.get.bind(elements);
      elements.get = (id: number) => {
        let el = get(id);
        if (!el) {
          el = win.document.createElement('div') as HTMLElement;
          el.dataset.elementId = `0x${id.toString(16)}`;
          root.appendChild(el);
          elements.set(id, el);
        }
        return el;
      };
      return {
        root, elements,
        setState: () => {}, setInteractive: () => {}, setVisible: () => {}, setTexture: () => {},
        setText: (id: number, t: string) => { texts.set(id, t); },
        onClick: () => {}, close: () => { wrapper.remove(); },
      };
    };
    H.ui.layoutRenderer = { renderPanel, render: withSpellRowTemplate(renderPanel), setFontResolver: () => {} };
    H.ui.knownSpells = [SPELL];
    H.ui.magicPanelTab = 'spells';
    H.ui.selectedSpellIndex = 0;
    H.ui.toggleMagicPanel();
  }, 60_000);
  afterAll(() => H.teardown());

  it('the DAT footer captions are painted onto 0x100002a3 / 0x100002a4 (Schools: / Levels:)', () => {
    expect(H.ui.magicVisible).toBe(true);
    expect(texts.get(0x100002a3)).toBe('Schools:');
    expect(texts.get(0x100002a4)).toBe('Levels:');
  });

  it('no selected-spell detail block renders (no description / mana / difficulty / duration text)', () => {
    const text = H.ui.magicPanel.textContent ?? '';
    expect(text).toContain('Strength Other I'); // the spell row itself rendered
    expect(text).not.toContain('UNIQUE_DETAIL_DESCRIPTION_TEXT');
    expect(text).not.toMatch(/Difficulty|Duration/);
    expect(text).not.toContain('777');
    expect(text).not.toContain('4321');
  });
});
