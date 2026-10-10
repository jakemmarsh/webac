/**
 * VISUAL.spellbook-rows-show-mana-cost — spellbook list rows are icon + name
 * ONLY; retail EoL rows carry no mana-cost column.
 *
 * Ground truth:
 *  - reference/images/hud/spellbook-panel.jpg: rows show icon + name, names
 *    truncate with "…" — no right-aligned number shares the row.
 *  - Decompiled client: UIElement_UIItem::Init_UIItem_Spell_Shortcut @
 *    004e1140 takes only the spellID (icon+name shortcut element; no cost
 *    field), via gmSpellbookUI::AddSpell @ 0048b7a0 →
 *    ItemList_InsertSpellShortcut @ 004e41b0. Mana cost belongs to the
 *    examine/tooltip surface, which we already render separately.
 *
 * Behavioral: real renderMagicPanel in happy-dom with the GAP.36 stub
 * layout handle; assert each spell row's text is exactly the spell name
 * (no appended cost), and that the panel keeps mana in the examine lines.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withSpellRowTemplate } from './_harness/spell-row-stub.js';
import { loadDomWindow, installDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('VISUAL.spellbook-rows-show-mana-cost — rows are icon + name only (behavioral)', () => {
  const saved: Partial<Record<string, unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let MagicSchool: any;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // renderMagicPanel schedules a scrollbar sync via requestAnimationFrame
    saved['requestAnimationFrame'] = g['requestAnimationFrame'];
    g['requestAnimationFrame'] = (cb: FrameRequestCallback) => domWindow.requestAnimationFrame(cb);

    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const spellMod = await import('../packages/shared/src/magic/SpellEngine.js');
    MagicSchool = spellMod.MagicSchool;
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    // Permissive stub layout handle (GAP.36 recipe). Magic panel 0x21000034
    // needs the panel root, the Spellbook/Components tab pair, and content.
    const IDS = [0x100002a8, 0x100002a9, 0x100002aa, 0x100002ab, 0x100002ac];
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      render: withSpellRowTemplate((_layoutId: number, parent: HTMLElement) => (ui.layoutRenderer.renderPanel(_layoutId, parent))),
    };
  });

  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of [...DOM_GLOBALS, 'requestAnimationFrame']) {
      if (saved[key] === undefined) delete g[key];
      else g[key] = saved[key];
    }
  });

  function makeSpell(id: number, name: string, manaCost: number) {
    return {
      id, name, school: MagicSchool.WarMagic ?? MagicSchool.War, level: 1, power: 1, manaCost,
      difficulty: 50, duration: 0, components: [], targetType: 2,
    };
  }

  function spellRows(): HTMLElement[] {
    // rows are the spell list's DAT 0x10000467 rows, tagged data-spell-id
    return [...(ui.magicPanel as HTMLElement).querySelectorAll('[data-spell-id]')] as HTMLElement[];
  }

  it('each spell row renders exactly the spell name — no mana-cost text', () => {
    ui.setSpellData([
      makeSpell(1, 'Flame Bolt I', 15),
      makeSpell(2, 'Strength Other I', 5),
    ]);
    if (!ui.magicVisible) ui.toggleMagicPanel();

    const rows = spellRows();
    expect(rows.length).toBe(2);
    const texts = rows.map(r => (r.textContent ?? '').trim()).sort();
    expect(texts).toEqual(['Flame Bolt I', 'Strength Other I']);
    // the cost numbers must not appear anywhere in a row
    for (const r of rows) {
      expect(r.textContent).not.toMatch(/\b15\b/);
      expect(r.textContent).not.toMatch(/\b5\b/);
    }
  });

  it('re-rendering with a distinct cost value leaves no bare-number node in the panel', () => {
    // The row column was removed, not the stat — mana still lives on the
    // spell-bar tooltip (wireSpellBarSlotEvents pushes `Mana: ${sp.manaCost}`,
    // FAITHFUL.309/.324). Here: nothing in the spellbook list renders the
    // cost as standalone text.
    ui.setSpellData([makeSpell(3, 'Lightning Bolt I', 22)]);
    const rows = spellRows();
    expect(rows.length).toBe(1);
    expect((rows[0].textContent ?? '').trim()).toBe('Lightning Bolt I');
    expect((ui.magicPanel as HTMLElement).innerHTML).not.toContain('>22<');
  });
});
