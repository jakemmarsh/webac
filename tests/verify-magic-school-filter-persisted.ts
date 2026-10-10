/**
 * FAITHFUL.454 + BUG.spellbook-school-filter-single-select — the spellbook's
 * school/level filter is the character's SpellbookFilters bitmask.
 *
 *  Retail (gmSpellbookUI, acclient EoL): each school and level button is an
 *  independent toggle of its own bit. UpdateFilter @ 0048b5e0 ORs or clears
 *  the clicked button's bit and sends Event_SpellbookFilterEvent;
 *  ResetFilterButtons @ 0048af90 lights each button whose bit is set;
 *  IsFilteredOut @ 0048aeb0 hides a spell whose school or level bit is clear.
 *  ACE seeds a character with 0x3FFF (ShardDbContext default 16383), so a
 *  fresh spellbook shows all five schools and all eight levels lit.
 *
 *  Pre-fix the school filter was single-select (one MagicSchool | null), so
 *  0x3FFF decoded to "All" and drew all five school gems off.
 *
 *  The click path runs through the real renderMagicPanel against a
 *  layout-handle double; the default + restore run on real GameUI instances.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { MagicSchool } from '../packages/shared/src/magic/SpellEngine.js';

import { isSpellbookFilteredOut, toggleSpellbookFilter, SPELLBOOK_FILTERS_DEFAULT } from '../packages/renderer/src/ui/spellbookFilter.js';

const CREATURE = 0x1, ITEM = 0x2, LIFE = 0x4, WAR = 0x8, VOID = 0x2000, L1 = 0x10, L8 = 0x800;

describe('gmSpellbookUI::IsFilteredOut / UpdateFilter port (spellbookFilter.ts)', () => {
  it('the default mask is ACE\'s 0x3FFF and hides nothing', () => {
    expect(SPELLBOOK_FILTERS_DEFAULT).toBe(0x3fff);
    for (const school of [1, 2, 3, 4, 5]) {
      for (let lvl = 1; lvl <= 9; lvl++) expect(isSpellbookFilteredOut(school, lvl, 0x3fff)).toBe(false);
    }
  });
  it('a spell is hidden when its school bit OR its level bit is clear', () => {
    expect(isSpellbookFilteredOut(MagicSchool.WarMagic, 1, WAR | L1)).toBe(false);
    expect(isSpellbookFilteredOut(MagicSchool.WarMagic, 1, LIFE | L1)).toBe(true);
    expect(isSpellbookFilteredOut(MagicSchool.WarMagic, 1, WAR | L8)).toBe(true);
    expect(isSpellbookFilteredOut(MagicSchool.VoidMagic, 8, VOID | L8)).toBe(false);
  });
  it('an unknown school or a level outside 1..9 is hidden (IsFilteredOut default case)', () => {
    expect(isSpellbookFilteredOut(0, 1, 0x3fff)).toBe(true);
    expect(isSpellbookFilteredOut(MagicSchool.WarMagic, 0, 0x3fff)).toBe(true);
    expect(isSpellbookFilteredOut(MagicSchool.WarMagic, 10, 0x3fff)).toBe(true);
  });
  it('a click flips only its own bit', () => {
    expect(toggleSpellbookFilter(0x3fff, WAR)).toBe(0x3fff & ~WAR);
    expect(toggleSpellbookFilter(0x3fff & ~WAR, WAR)).toBe(0x3fff);
    expect(toggleSpellbookFilter(CREATURE | ITEM, L1)).toBe(CREATURE | ITEM | L1);
  });
});

describe('spellbook filter buttons toggle + persist the SpellbookFilters bitmask (behavioural)', () => {
  let H: GameUIFixture;
  const SCHOOL_ROWS: Record<number, number> = {
    [MagicSchool.CreatureEnchantment]: 0x10000298, [MagicSchool.ItemEnchantment]: 0x10000299,
    [MagicSchool.LifeMagic]: 0x1000029a, [MagicSchool.WarMagic]: 0x1000029b, [MagicSchool.VoidMagic]: 0x100005c0,
  };
  const LEVEL1_ROW = 0x1000029c;
  let rows = new Map<number, HTMLElement>();
  const sent: number[] = [];
  beforeAll(async () => {
    H = await mountGameUI();
    const doc = H.win.document;
    H.ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = doc.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [0x100002a8, 0x100002a9, 0x100002aa, 0x100002ab, 0x100002ac, 0x10000297, 0x100002a3, 0x100002a4,
          ...Object.values(SCHOOL_ROWS), LEVEL1_ROW]) {
          const el = doc.createElement('div');
          // the radio-row template's gem child (0x21000044:0x10000328)
          const gem = doc.createElement('div');
          gem.setAttribute('data-element-id', '0x10000328');
          el.appendChild(gem);
          root.appendChild(el);
          elements.set(id, el);
        }
        rows = elements;
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      // The panels window's frame (0x2100006e) the spellbook mounts in.
      render: (_id: number, parent: HTMLElement) => {
        const root = doc.createElement('div');
        parent.appendChild(root);
        return { root, elements: new Map(), setState: () => {}, setVisible: () => {}, onClick: () => {}, destroy: () => root.remove() };
      },
    };
    H.ui.getTexURL = (id: number) => `tex-${id.toString(16)}`;
    H.ui.onSpellbookFilterChanged = (f: number) => { sent.push(f); };
    H.ui.setSpellbookFilters(0x3fff);
    if (!H.ui.magicVisible) H.ui.toggleMagicPanel();
  });
  afterAll(() => H.teardown());

  const persisted = (): unknown => JSON.parse(H.win.localStorage.getItem('ac_options_settings_v1') ?? '{}').spellbookFilters;
  const click = (id: number): void => {
    rows.get(id)!.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
  };
  // wireRadio paints the gem child with GEM_TEX.on 0x06004d17 / off 0x06004d15.
  const gemOn = (id: number): boolean => {
    const gem = rows.get(id)!.querySelector('[data-element-id="0x10000328"]') as HTMLElement;
    return gem.style.backgroundImage.includes('tex-6004d17');
  };

  it('with 0x3FFF every school row and level row is lit (ResetFilterButtons)', () => {
    expect(Object.values(SCHOOL_ROWS).map(gemOn)).toEqual([true, true, true, true, true]);
    expect(gemOn(LEVEL1_ROW)).toBe(true);
  });

  it('clicking War clears only the War bit, sends and persists the mask; clicking again restores it', () => {
    sent.length = 0;
    click(SCHOOL_ROWS[MagicSchool.WarMagic]);
    expect(H.ui.encodeSpellbookFilters()).toBe(0x3fff & ~WAR);
    expect(sent).toEqual([0x3fff & ~WAR]);
    expect(persisted()).toBe(0x3fff & ~WAR);
    click(SCHOOL_ROWS[MagicSchool.WarMagic]);
    expect(H.ui.encodeSpellbookFilters()).toBe(0x3fff);
    expect(sent).toEqual([0x3fff & ~WAR, 0x3fff]);
  });

  it('two schools can be off at once — the filter is not single-select', () => {
    click(SCHOOL_ROWS[MagicSchool.LifeMagic]);
    click(SCHOOL_ROWS[MagicSchool.VoidMagic]);
    expect(H.ui.encodeSpellbookFilters()).toBe(0x3fff & ~LIFE & ~VOID);
    // SCHOOL_ROWS iterates by MagicSchool value: War, Life, Item, Creature, Void.
    expect(Object.values(SCHOOL_ROWS).map(gemOn)).toEqual([true, false, true, true, false]);
    click(SCHOOL_ROWS[MagicSchool.LifeMagic]);
    click(SCHOOL_ROWS[MagicSchool.VoidMagic]);
    expect(H.ui.encodeSpellbookFilters()).toBe(0x3fff);
  });

  it('a level row flips its level bit', () => {
    click(LEVEL1_ROW);
    expect(H.ui.encodeSpellbookFilters()).toBe(0x3fff & ~L1);
    click(LEVEL1_ROW);
    expect(H.ui.encodeSpellbookFilters()).toBe(0x3fff);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('SpellbookFilters default + restore from the localStorage cache (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function freshUI() {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new GameUICtor(container);
  }

  it('GameUI.OPTIONS_DEFAULTS.spellbookFilters is 0x3FFF', () => {
    expect(GameUICtor.OPTIONS_DEFAULTS.spellbookFilters).toBe(0x3fff);
  });

  it('a fresh instance (no persisted state) starts at 0x3FFF', () => {
    domWindow.localStorage.clear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = freshUI();
    expect(ui.encodeSpellbookFilters()).toBe(0x3fff);
  });

  it.each([0, WAR | L1, CREATURE | ITEM | LIFE | WAR | L8, 0x3fff])('constructor restores a cached mask of %i', (mask) => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ spellbookFilters: mask }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = freshUI();
    expect(ui.encodeSpellbookFilters()).toBe(mask);
  });

  it.each([-1, 2.5, 'war'])('constructor ignores an invalid cached mask (%s) and keeps 0x3FFF', (bad) => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ spellbookFilters: bad }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = freshUI();
    expect(ui.encodeSpellbookFilters()).toBe(0x3fff);
  });
});
