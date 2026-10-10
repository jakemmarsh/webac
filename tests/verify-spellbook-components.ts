/**
 * Spellbook detail components (was FAITHFUL.329) — RETIRED WITH THE SPELLBOOK DETAIL BLOCK (decision 2026-06-10).
 *
 * FAITHFUL.329 originally surfaced the spell component list in the spellbook's bottom-detail
 * area. That detail block was an invention: the DAT footer (0x21000032
 * element 0x10000297) carries ONLY the Schools:/Levels: filter captions,
 * the radio rows, and the Delete button — no spell-detail area (see
 * verification/panel-specs/magic-spellbook.md). Per Jake's decision (2b,
 * 2026-06-10) the block was dropped and the DAT footer restored
 * (VISUAL.136/.138).
 *
 * The spell-bar tooltip no longer carries component names either — retail's
 * shortcut tooltip is the spell name alone (CORE.17.k.b.b.a.g,
 * SpellCastSubMenu::UpdateFromPlayerModule @ 004c6570); that is proven
 * behaviourally by tests/verify-spell-tooltip-components.ts.
 *
 * DEBT.test-harness-hygiene: converted from a GameUI.ts source pin — the real
 * renderMagicPanel runs against a recording layout-handle double.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withSpellRowTemplate } from './_harness/spell-row-stub.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { MagicSchool } from '../packages/shared/src/magic/SpellEngine.js';

describe('FAITHFUL.329 (retired placement) — detail block removed, footer is the DAT captions', () => {
  let H: GameUIFixture;
  const texts: Array<[number, string]> = [];
  beforeAll(async () => {
    H = await mountGameUI();
    const doc = H.win.document;
    H.ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = doc.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [0x100002a8, 0x100002a9, 0x100002aa, 0x100002ab, 0x100002ac, 0x10000297,
          0x100002a3, 0x100002a4, 0x10000298, 0x10000299, 0x1000029a, 0x1000029b, 0x100005c0, 0x100002a5, 0x100002a6]) {
          const el = doc.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements,
          setState: () => {}, setText: (id: number, t: string) => { texts.push([id, t]); }, setInteractive: () => {},
          setVisible: () => {}, setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      render: withSpellRowTemplate((id: number, parent: HTMLElement) => H.ui.layoutRenderer.renderPanel(id, parent)),
    };
    H.ui.setSpellData([{
      id: 27, name: 'Flame Bolt I', desc: 'UNIQUE-DESCRIPTION-TEXT', school: MagicSchool.WarMagic, level: 1,
      power: 1, manaCost: 15, difficulty: 50, duration: 0, components: [1, 2, 3], targetType: 2,
    }]);
    if (!H.ui.magicVisible) H.ui.toggleMagicPanel();
  });
  afterAll(() => H.teardown());

  it('the footer paints the DAT captions Schools: (0x100002a3) and Levels: (0x100002a4)', () => {
    expect(texts).toContainEqual([0x100002a3, 'Schools:']);
    expect(texts).toContainEqual([0x100002a4, 'Levels:']);
  });

  it('the spellbook renders no selected-spell detail block (no description / mana / components text), even after selecting the row', () => {
    const panel = H.ui.magicPanel as HTMLElement;
    const row = panel.querySelector('[data-spell-id]') as HTMLElement | undefined;
    expect(row).toBeTruthy();
    row!.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
    const text = (H.ui.magicPanel as HTMLElement).textContent ?? '';
    expect(text).toContain('Flame Bolt I');
    expect(text).not.toContain('UNIQUE-DESCRIPTION-TEXT');
    expect(text).not.toMatch(/Components|Mana:|\b15\b/);
  });

  it('the component-name helper that fed the retired tooltip line is gone', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((H.mod.GameUI.prototype as any).getSpellComponentNames).toBeUndefined();
  });
});
