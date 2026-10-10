/**
 * FAITHFUL.594 — spellbook filter server round-trip (sweep findings #4/#7;
 * found independently by the load-dropped AND parsed-unused finders).
 *
 * Pre-fix: PlayerDescriptionParser read `spellbookFilters` (byte-correct vs
 * ACE GameEventPlayerDescription.cs:383-384, which writes
 * Character.SpellbookFilters unconditionally) but NOTHING consumed it — the
 * classic SAVE-wired/LOAD-dropped shape (memory/faithful-load-side-restore-
 * pattern.md). The school filter only lived in localStorage (FAITHFUL.454),
 * so a fresh machine lost it; level rows were display-only labels.
 *
 * Post-fix:
 *  - GameUI.setSpellbookFilters() takes the ACE SpellBookFilterOptions
 *    bitmask at login as-is (BUG.spellbook-school-filter-single-select: every
 *    school and level is an independent bit, gmSpellbookUI::UpdateFilter).
 *  - School + level toggle clicks flip their bit and send
 *    GameActionSpellbookFilter (single u32 per GameActionSpellbookFilter.cs);
 *    the click path is driven in verify-magic-school-filter-persisted.ts.
 *
 * `setSpellbookFilters(filters)` and `encodeSpellbookFilters()` are real
 * public GameUI methods — driven directly below via the established
 * happy-dom + private-field-cast idiom (`magicVisible` stays false by
 * default, so `setSpellbookFilters`'s conditional `renderMagicPanel()`
 * call never executes; `renderMagicPanel` itself also early-returns
 * without a DAT-parsed `layoutRenderer` regardless). The main.ts login /
 * toggle wiring goes through network/spellbookFilterWire.ts, driven below.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { MagicSchool } from '../packages/shared/src/magic/SpellEngine.js';
import { spellbookLevelBit, spellbookSchoolBit } from '../packages/renderer/src/ui/spellbookFilter.js';


describe('FAITHFUL.594: LOAD + SAVE — the wire seam main.ts calls (network/spellbookFilterWire.ts, behavioural)', () => {
  it('login applies desc.spellbookFilters as-is, and never the -1 parse-abort sentinel', async () => {
    const { applyLoginSpellbookFilters } = await import('../packages/renderer/src/network/spellbookFilterWire.js');
    const got: number[] = [];
    const ui = { setSpellbookFilters: (f: number) => { got.push(f); } };
    expect(applyLoginSpellbookFilters(ui, { spellbookFilters: 0x2a5f })).toBe(true);
    expect(applyLoginSpellbookFilters(ui, { spellbookFilters: -1 })).toBe(false);
    expect(applyLoginSpellbookFilters(ui, {})).toBe(false);
    expect(got).toEqual([0x2a5f]);
  });

  it('a toggle sends GameActionSpellbookFilter as one little-endian u32', async () => {
    const { spellbookFilterPayload } = await import('../packages/renderer/src/network/spellbookFilterWire.js');
    expect([...spellbookFilterPayload(0x3fff)]).toEqual([0xff, 0x3f, 0, 0]);
    expect([...spellbookFilterPayload(-1)]).toEqual([0xff, 0xff, 0xff, 0xff]);
  });
});

// Verbatim from ACE.Entity/Enum/SpellBookFilterOptions.cs
const ACE_BITS = {
  Creature: 0x0001, Item: 0x0002, Life: 0x0004, War: 0x0008,
  Level1: 0x0010, Level2: 0x0020, Level3: 0x0040, Level4: 0x0080,
  Level5: 0x0100, Level6: 0x0200, Level7: 0x0400, Level8: 0x0800,
  Void: 0x2000,
};

describe('FAITHFUL.594: level-bit progression matches ACE Level1..Level8', () => {
  it('level encode mirrors ACE Level1..Level8 progression', () => {
    for (let lvl = 1; lvl <= 8; lvl++) {
      const expected = (ACE_BITS as Record<string, number>)[`Level${lvl}`];
      expect(0x10 << (lvl - 1)).toBe(expected);
    }
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('FAITHFUL.594 — setSpellbookFilters/encodeSpellbookFilters (behavioral, requires happy-dom devDep)', () => {
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function freshUI(): any {
    domWindow.document.body.innerHTML = '';
    domWindow.localStorage.clear();
    // GameUI.ts's optionsSettings field initializer returns the literal
    // GameUI.OPTIONS_DEFAULTS object BY REFERENCE when localStorage has no
    // 'ac_options_settings_v1' entry (only the merge branch, taken when an
    // entry exists, produces a fresh `{...DEFAULTS}` copy). setSpellbookFilters
    // mutates optionsSettings in place, so an empty localStorage would let
    // one test's mutation leak into the shared static DEFAULTS for every
    // later instance/test in this process. Seed an empty JSON object so
    // every fresh instance always takes the copy-producing merge branch
    // (observably identical to DEFAULTS).
    domWindow.localStorage.setItem('ac_options_settings_v1', '{}');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new GameUICtor(container);
  }

  it('a fresh instance starts at ACE\'s default 0x3FFF (every school and level on)', () => {
    const ui = freshUI();
    expect(ui.encodeSpellbookFilters()).toBe(0x3fff);
  });

  it('setSpellbookFilters keeps every school bit — several schools can be on at once', () => {
    const ui = freshUI();
    const mask = ACE_BITS.Creature | ACE_BITS.Item | ACE_BITS.Life | ACE_BITS.War | ACE_BITS.Level8;
    ui.setSpellbookFilters(mask);
    expect(ui.encodeSpellbookFilters()).toBe(mask);
  });

  it('encode(decode(mask)) round-trips any mask', () => {
    for (const mask of [0, ACE_BITS.Void, ACE_BITS.War | ACE_BITS.Life, ACE_BITS.Level3 | ACE_BITS.Level7, 0x3fff, 0x1000]) {
      const ui = freshUI();
      ui.setSpellbookFilters(mask);
      expect(ui.encodeSpellbookFilters()).toBe(mask);
    }
  });

  it('setSpellbookFilters persists the mask to optionsSettings/localStorage', () => {
    const ui = freshUI();
    ui.setSpellbookFilters(ACE_BITS.War | ACE_BITS.Level5);
    expect(ui.optionsSettings.spellbookFilters).toBe(ACE_BITS.War | ACE_BITS.Level5);
    const stored = JSON.parse(domWindow.localStorage.getItem('ac_options_settings_v1'));
    expect(stored.spellbookFilters).toBe(ACE_BITS.War | ACE_BITS.Level5);
  });

  it('a later setSpellbookFilters call replaces (does not accumulate onto) the prior mask', () => {
    const ui = freshUI();
    ui.setSpellbookFilters(ACE_BITS.Level1 | ACE_BITS.Level2);
    ui.setSpellbookFilters(ACE_BITS.Level8);
    expect(ui.encodeSpellbookFilters()).toBe(ACE_BITS.Level8);
  });

  it('does not throw when magicVisible is true (DAT-free layoutRenderer=null path)', () => {
    const ui = freshUI();
    ui.magicVisible = true;
    expect(() => ui.setSpellbookFilters(ACE_BITS.War)).not.toThrow();
  });
});

describe('FAITHFUL.594: school/level bits match ACE (gmSpellbookUI::IsFilteredOut @ 0048aeb0)', () => {
  it('each MagicSchool maps to its ACE bit', () => {
    expect(spellbookSchoolBit(MagicSchool.CreatureEnchantment)).toBe(ACE_BITS.Creature);
    expect(spellbookSchoolBit(MagicSchool.ItemEnchantment)).toBe(ACE_BITS.Item);
    expect(spellbookSchoolBit(MagicSchool.LifeMagic)).toBe(ACE_BITS.Life);
    expect(spellbookSchoolBit(MagicSchool.WarMagic)).toBe(ACE_BITS.War);
    expect(spellbookSchoolBit(MagicSchool.VoidMagic)).toBe(ACE_BITS.Void);
  });
  it('levels 1..8 map to Level1..Level8 and level 9 to 0x1000', () => {
    for (let lvl = 1; lvl <= 8; lvl++) {
      expect(spellbookLevelBit(lvl)).toBe((ACE_BITS as Record<string, number>)[`Level${lvl}`]);
    }
    expect(spellbookLevelBit(9)).toBe(0x1000);
  });
});
