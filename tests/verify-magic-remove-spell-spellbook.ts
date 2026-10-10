/**
 * FAITHFUL.349 — onMagicRemoveSpell removes from the SPELLBOOK, not from
 *  the active-enchantments bar.
 *
 * ACE `GameEventMagicRemoveSpell.cs:7-10` ("Remove a spell from the
 * player's spellbook") and `GameEventMagicRemoveEnchantment.cs:7-10`
 * ("Remove an enchantment from your character") are DIFFERENT events:
 *
 *   - MagicRemoveSpell (0x01A8): the spell ITEM that bestowed a spell
 *     expired / was unwielded; the spell vanishes from the player's
 *     learned spell list. Sent by Player_Inventory unwield + buff-item
 *     expiry paths.
 *   - MagicRemoveEnchantment (0x02C3): an ACTIVE buff/debuff timer
 *     expired; the icon vanishes from the enchantment bar. The spell
 *     itself remains learned.
 *
 * Pre-FAITHFUL.349 our `onMagicRemoveSpell` handler called
 * `gameUI.removeEnchantment(spellId, layer)` — the wrong UI surface.
 * Result: when an item-bestowed spell expired, the icon stayed in the
 * spellbook until next login (the active-enchantment-bar mutation was a
 * no-op because the spell wasn't an active buff anyway).
 *
 * Fix: route through `magicController.forgetSpell` + refresh the
 * spell-bar/spellbook via `setSpellData`. Mirrors the inverse of the
 * `onMagicUpdateSpell` (FAITHFUL.226 + .335) add path.
 *
 * GAP.86 (2026-07-23) — converted from a main.ts source-text regex pin to
 * behavioral tests that drive the real shipped classes:
 *   - MagicController.forgetSpell/learnSpell/isSpellKnown (pure logic, no
 *     DOM) exercised directly — this is the actual mutation FAITHFUL.349
 *     introduced.
 *   - GameUI.setSpellData (real class, constructed against happy-dom per
 *     the verify-gameui-dom-smoke.ts pattern) exercised directly to prove
 *     the spellbook UI reflects the post-forgetSpell state.
 * main.ts itself is never imported in this suite (nor anywhere else in
 * the test tree — it has WebSocket/game-loop side effects at module
 * scope, see verify-gameui-dom-smoke.ts's docblock), so the one thing
 * that can't be driven behaviorally is WHICH of these two APIs the
 * onMagicRemoveSpell wiring calls; that remains a narrow, explicitly-
 * scoped citation check below rather than a broad regex-matched pin.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MagicController } from '../packages/renderer/src/controllers/MagicController.js';
import { MagicSchool, SpellTargetType } from '@ac/shared';
import type { SpellDefinition } from '@ac/shared';

const REPO = resolve(__dirname, '..');

function spell(id: number, name: string): SpellDefinition {
  return {
    id, name, school: MagicSchool.LifeMagic, level: 1, power: 1, manaCost: 1,
    difficulty: 1, duration: 60, components: [], targetType: SpellTargetType.Self,
  };
}

describe('MagicController.forgetSpell (the real mutation behind FAITHFUL.349)', () => {
  it('removes a learned spell from the spellbook', () => {
    const mc = new MagicController();
    mc.learnSpell(spell(1839, 'Strength Other I'));
    expect(mc.isSpellKnown(1839)).toBe(true);

    const removed = mc.forgetSpell(1839);

    expect(removed).toBe(true);
    expect(mc.isSpellKnown(1839)).toBe(false);
    expect(mc.knownSpells.find(s => s.id === 1839)).toBeUndefined();
  });

  it('returns false and leaves the spellbook untouched when the spell was not known', () => {
    const mc = new MagicController();
    mc.learnSpell(spell(2647, 'Armor Other I'));

    const removed = mc.forgetSpell(9999);

    expect(removed).toBe(false);
    expect(mc.knownSpells).toHaveLength(1);
    expect(mc.isSpellKnown(2647)).toBe(true);
  });

  it('only removes the targeted spell, leaving siblings learned (matches the handler\'s single-spellId dispatch)', () => {
    const mc = new MagicController();
    mc.learnSpell(spell(1839, 'Strength Other I'));
    mc.learnSpell(spell(2647, 'Armor Other I'));
    mc.learnSpell(spell(3865, 'Heal Other I'));

    mc.forgetSpell(2647);

    expect(mc.knownSpells.map(s => s.id).sort()).toEqual([1839, 3865]);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI.setSpellData reflects the post-forgetSpell spellbook (requires happy-dom devDep)', () => {
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

  it('setSpellData(magicController.knownSpells) drops the forgotten spell from the UI-facing list', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui: any = new GameUICtor(container);

    const mc = new MagicController();
    mc.learnSpell(spell(1839, 'Strength Other I'));
    mc.learnSpell(spell(2647, 'Armor Other I'));
    ui.setSpellData(mc.knownSpells);
    expect(ui.knownSpells.map((s: SpellDefinition) => s.id).sort()).toEqual([1839, 2647]);

    mc.forgetSpell(1839);
    ui.setSpellData(mc.knownSpells);

    expect(ui.knownSpells.map((s: SpellDefinition) => s.id)).toEqual([2647]);
  });
});

describe('onMagicRemoveSpell wiring (main.ts) — narrowly-scoped citation', () => {
  // main.ts has WebSocket/game-loop side effects at module scope and is
  // never imported in this test tree (see verify-gameui-dom-smoke.ts);
  // the *behavior* of forgetSpell/setSpellData is proven above against
  // the real classes. This check is scoped to the one fact that can't be
  // driven behaviorally without importing the whole app: which two API
  // calls the handler routes through.
  const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
  const block = MAIN.match(/onMagicRemoveSpell:[\s\S]+?^      \},/m)?.[0] ?? '';

  it('routes to magicController.forgetSpell + gameUI.setSpellData', () => {
    expect(block).toContain('magicController.forgetSpell(data.spellId)');
    expect(block).toContain('gameUI.setSpellData(magicController.knownSpells)');
  });

  it('does not regress to the wrong UI surface (gameUI.removeEnchantment)', () => {
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('gameUI.removeEnchantment');
  });
});
