/**
 * FAITHFUL.383 — Spell-bar slot assignments round-trip to ACE via
 *  AddSpellFavorite / RemoveSpellFavorite so they survive logout.
 *
 * Pre-fix `assignSpellToBar` updated the local `spellBarSlots`
 * array but never shipped any GameAction to ACE. ACE
 * Player_Character.cs:295-314 has HandleActionAddSpellFavorite +
 * HandleActionRemoveSpellFavorite that persist into
 * CharacterPropertiesSpellBar; without the round-trip every relogin
 * restored an empty bar.
 *
 * Behavior:
 *  - When a slot is reassigned to a different spell, the previous
 *    occupant must be removed first (ACE replaces by spellId+barId,
 *    not by position, so a stale entry would survive otherwise).
 *  - Reassigning the same spell to the same slot is a no-op for the
 *    remove path.
 *
 * ACE refs:
 *   reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionAddSpellFavorite.cs
 *   reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionRemoveSpellFavorite.cs
 *   reference/ACE/Source/ACE.Server/WorldObjects/Player_Character.cs:295-314
 *
 * `GameUI.assignSpellToBar`/`setSpellData`/`setSpellCallbacks` are all
 * public and callable without a DAT-backed LayoutRenderer (the spell-bar
 * panel's own refresh no-ops until the panel has actually been rendered —
 * same "no DAT needed" shape as the enchantment-panel precedent), so the
 * round-trip behavior is driven directly against real code below. The
 * `main.ts` wiring block (forwarding the callbacks to `gameActions.*`) stays a
 * source citation — `main.ts` has module-scope side effects and is never
 * imported in this test tree, per the established precedent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const UI = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf8');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('main.ts wires the callbacks to the gameActions senders (FAITHFUL.383, citation — main.ts not imported in this test tree; the senders themselves are behavioural in verify-game-actions.ts)', () => {
  const block = MAIN.match(/setSpellCallbacks\(\{[\s\S]+?\n  \}\);/)?.[0] ?? '';

  it('onAddSpellFavorite forwards to gameActions.addSpellFavorite', () => {
    expect(block).toMatch(/onAddSpellFavorite:[\s\S]+?gameActions\.addSpellFavorite\(spellId, position, barIndex\)/);
  });

  it('onRemoveSpellFavorite forwards to gameActions.removeSpellFavorite', () => {
    expect(block).toMatch(/onRemoveSpellFavorite:[\s\S]+?gameActions\.removeSpellFavorite\(spellId, barIndex\)/);
  });

  it('cites FAITHFUL.383 in the wiring docblock', () => {
    expect(block).toMatch(/FAITHFUL\.383/);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('FAITHFUL.383 — assignSpellToBar round-trips AddSpellFavorite/RemoveSpellFavorite (behavioral, requires happy-dom devDep)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let MagicSchool: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const uiMod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = uiMod.GameUI;
    const spellMod = await import('../packages/shared/src/magic/SpellEngine.js');
    MagicSchool = spellMod.MagicSchool;
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function freshUI() {
    domWindow.localStorage.clear();
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new GameUICtor(container);
  }

  function makeSpell(id: number, name: string) {
    return {
      id, name, school: MagicSchool.War, level: 1, power: 1, manaCost: 10,
      difficulty: 50, duration: 0, components: [], targetType: 2,
    };
  }

  it('assigning a spell to an empty slot only calls onAddSpellFavorite (no prior occupant to remove)', () => {
    const ui = freshUI();
    const added: Array<[number, number, number]> = [];
    const removed: Array<[number, number]> = [];
    ui.setSpellData([makeSpell(100, 'Spell A'), makeSpell(200, 'Spell B')]);
    ui.setSpellCallbacks({
      onAddSpellFavorite: (spellId: number, position: number, barIndex: number) => added.push([spellId, position, barIndex]),
      onRemoveSpellFavorite: (spellId: number, barIndex: number) => removed.push([spellId, barIndex]),
    });

    ui.assignSpellToBar(0, 2); // spellIndex 0 (Spell A, id 100) -> slot 2, active bar 0

    expect(added).toEqual([[100, 2, 0]]);
    expect(removed).toEqual([]);
  });

  // CORE.17.k.b.b.a.g.c — the bar is retail's ordered favorites list
  // (SpellCastSubMenu::AddFavorite @ 004c7060 → ItemList_InsertSpellShortcut;
  // ACE CharacterExtensions.AddSpellToBar shifts the entries at and after the
  // index): a drop INSERTS at the index, it never replaces the occupant, so a
  // different spell dropped on an occupied slot ships only its own Add.
  it('dropping a DIFFERENT spell on an occupied slot inserts it there (no removal of the occupant)', () => {
    const ui = freshUI();
    const added: Array<[number, number, number]> = [];
    const removed: Array<[number, number]> = [];
    ui.setSpellData([makeSpell(100, 'Spell A'), makeSpell(200, 'Spell B')]);
    ui.setSpellCallbacks({
      onAddSpellFavorite: (spellId: number, position: number, barIndex: number) => added.push([spellId, position, barIndex]),
      onRemoveSpellFavorite: (spellId: number, barIndex: number) => removed.push([spellId, barIndex]),
    });

    ui.assignSpellToBar(0, 2); // Spell A → the list's end (ACE clamps 2 to the end)
    ui.assignSpellToBar(1, 0); // Spell B inserted before it

    expect(removed).toEqual([]);
    expect(added).toEqual([[100, 2, 0], [200, 0, 0]]);
    expect(ui.spellBarSlots[0].slice(0, 2).map((s: { id: number } | null) => s?.id)).toEqual([200, 100]);
  });

  it('dropping a spell already on the bar MOVES it: RemoveSpellFavorite then AddSpellFavorite (RemoveSpellFromMenu → RemoveSpellFromPlayerModule)', () => {
    const ui = freshUI();
    const added: Array<[number, number, number]> = [];
    const removed: Array<[number, number]> = [];
    ui.setSpellData([makeSpell(100, 'Spell A')]);
    ui.setSpellCallbacks({
      onAddSpellFavorite: (spellId: number, position: number, barIndex: number) => added.push([spellId, position, barIndex]),
      onRemoveSpellFavorite: (spellId: number, barIndex: number) => removed.push([spellId, barIndex]),
    });

    ui.assignSpellToBar(0, 2);
    ui.assignSpellToBar(0, 2); // the same spell dropped again: a move (its old slot 0 is before 2 → index 1)

    expect(removed).toEqual([[100, 0]]);
    expect(added).toEqual([[100, 2, 0], [100, 1, 0]]);
  });

  it('an out-of-range spellIndex is a no-op; a slot past the end and −1 both append (the index shipped as retail does)', () => {
    const ui = freshUI();
    const added: Array<[number, number, number]> = [];
    const removed: Array<[number, number]> = [];
    ui.setSpellData([makeSpell(100, 'Spell A')]);
    ui.setSpellCallbacks({
      onAddSpellFavorite: (spellId: number, position: number, barIndex: number) => added.push([spellId, position, barIndex]),
      onRemoveSpellFavorite: (spellId: number, barIndex: number) => removed.push([spellId, barIndex]),
    });

    ui.assignSpellToBar(5, 2); // spellIndex out of range (only 1 known spell)
    expect(added).toEqual([]);
    ui.assignSpellToBar(0, 9); // past the end: appended, the request shipped as given
    expect(added).toEqual([[100, 9, 0]]);
    ui.assignSpellToBar(0, -1); // −1: a move to the end, shipped as m_numSpells after the add
    expect(removed).toEqual([[100, 0]]);
    expect(added).toEqual([[100, 9, 0], [100, 1, 0]]);
  });
});

describe('GameUI.spellCallbacks declares the round-trip callbacks (FAITHFUL.383)', () => {
  it('onAddSpellFavorite signature matches ACE AddSpellFavorite wire format', () => {
    expect(UI).toMatch(/onAddSpellFavorite\?:\s*\(spellId: number, position: number, barIndex: number\)\s*=>\s*void/);
  });

  it('onRemoveSpellFavorite signature matches ACE RemoveSpellFavorite wire format', () => {
    expect(UI).toMatch(/onRemoveSpellFavorite\?:\s*\(spellId: number, barIndex: number\)\s*=>\s*void/);
  });

  it('cites FAITHFUL.383 in the spellCallbacks docblock', () => {
    expect(UI).toMatch(/FAITHFUL\.383/);
  });
});
