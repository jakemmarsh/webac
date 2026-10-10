/**
 * Spellbook detail desc (was FAITHFUL.310) — RETIRED WITH THE SPELLBOOK DETAIL BLOCK (decision 2026-06-10).
 *
 * FAITHFUL.310 originally surfaced the spell's DAT desc string in the spellbook's bottom-detail
 * area. That detail block was an invention: the DAT footer (0x21000032
 * element 0x10000297) carries ONLY the Schools:/Levels: filter captions,
 * the radio rows, and the Delete button — no spell-detail area (see
 * verification/panel-specs/magic-spellbook.md). Per Jake's decision (2b,
 * 2026-06-10) the block was dropped and the DAT footer restored
 * (VISUAL.136/.138).
 *
 * The data itself still surfaces in the spell-bar tooltip (FAITHFUL.309),
 * which these pins verify — the FEATURE survives, only the invented
 * placement is gone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withSpellRowTemplate } from './_harness/spell-row-stub.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import type { SpellDefinition } from '@ac/shared';

const DESC = 'UNIQUE-DESC Increases the target\'s Strength by 10 points.';
const SPELL = {
  id: 2, name: 'Strength Other I', desc: DESC, school: 4, level: 1, power: 1,
  manaCost: 15, difficulty: 1, duration: 1800,
} as unknown as SpellDefinition;

describe('FAITHFUL.310 (retired placement) — detail block removed (behavioural, real renderMagicPanel)', () => {
  let H: GameUIFixture;
  const texts: Array<[number, string]> = [];
  beforeAll(async () => {
    H = await mountGameUI();
    H.ui.getTexURL = () => null;
    const makeHandle = (_id: number, parent: HTMLElement) => {
      const root = H.win.document.createElement('div') as HTMLElement;
      parent.appendChild(root);
      const els = new Map<number, HTMLElement>();
      return {
        root,
        elements: {
          get: (id: number) => {
            let el = els.get(id);
            if (!el) { el = H.win.document.createElement('div') as HTMLElement; root.appendChild(el); els.set(id, el); }
            return el;
          },
          set: () => {},
        },
        setText: (id: number, t: string) => { texts.push([id, t]); },
        setState: () => {}, setInteractive: () => {}, setVisible: () => {}, setTexture: () => {},
        onClick: () => {}, setFill: () => {}, setPalette: () => {},
        setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
        close: () => root.remove(), destroy: () => root.remove(),
      };
    };
    H.ui.layoutRenderer = {
      renderPanel: (id: number, parent: HTMLElement) => makeHandle(id, parent),
      render: withSpellRowTemplate((id: number, parent: HTMLElement) => makeHandle(id, parent)),
      getTextureDataURLWithAlpha: () => null,
    };
  });
  afterAll(() => H.teardown());

  it('with a spell selected, the spellbook shows no selected-spell detail (desc / mana / components); the DAT footer captions are painted instead', () => {
    H.ui.setSpellData([SPELL]);
    H.ui.magicPanelTab = 'spells';
    H.ui.selectedSpellIndex = 0;
    texts.length = 0;
    H.ui.renderMagicPanel();
    expect(H.ui.magicPanel).toBeTruthy();
    const text = H.ui.magicPanel.textContent ?? '';
    expect(text).toContain('Strength Other I'); // the list row itself renders
    expect(text).not.toContain('UNIQUE-DESC');
    // CORE.5.c.c: the DAT footer captions painted onto 0x100002a3/a4
    expect(texts).toContainEqual([0x100002a3, 'Schools:']);
    expect(texts).toContainEqual([0x100002a4, 'Levels:']);
  });
  // The spell-bar tooltip half ("carries NO desc — the spell name") is covered
  // behaviourally by tests/verify-spell-tooltip-desc.ts
  // ('spellShortcutTooltip returns the name — never the desc').
});
