/**
 * FAITHFUL.413 → BUG.nonpositional-human-table-sounds (2026-09-28): a spell
 * learn plays NO local chime. The old EnchantUp played from the human table
 * 0x20000001 non-positionally; ACE's LearnSpellWithNetworking plays the
 * SkillUpPurple script on the player (Player_Spells.cs:76), whose own hooks
 * are the learn effect, and the retail client adds nothing.
 *
 * Original FAITHFUL.413 notes (superseded):
 *  - Spell-learn (GameEventMagicUpdateSpell) plays Sound.EnchantUp.
 *  - (The LevelUp PlayScript's invented aura + chime were removed by
 *    BUG.playscript-fallback-invented-art: the player's PhysicsScriptTable
 *    entry plays the retail script, sounds included.)
 *
 * Pre-fix both events landed silently — only chat text + visual aura for
 * LevelUp; just chat text for spell-learn. Retail AC paired these with a
 * celebratory chime so the player got immediate audio feedback for
 * permanent progression beats.
 *
 * Sound.EnchantUp is the closest match in our existing palette (also used
 * for buff-application chimes — both are permanent-progression-adjacent
 * events that share the canonical "ascending tone" cue).
 *
 * BUG.spell-learn-message-duplicated — the spell-learn assertions below now
 * drive the real shipped handler (packages/renderer/src/magic/SpellLearn.ts)
 * instead of regex-matching main.ts source text, and additionally pin that
 * the handler emits NO chat line of its own: ACE's
 * Player.LearnSpellWithNetworking always sends the learn text itself
 * (Player_Spells.cs:69-86).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  handleMagicUpdateSpell,
  type SpellBaseRow,
  type SpellLearnDeps,
} from '../packages/renderer/src/magic/SpellLearn.js';
import type { SpellDefinition } from '@ac/shared';


/* ------------------------------------------------------------------ */
/*  Spell-learn — behavioral, drives the shipped handler               */
/* ------------------------------------------------------------------ */

const HEAL_SELF_I = 1;
const HEAL_SELF_ROW: SpellBaseRow = {
  name: 'Heal Self I',
  desc: 'Restores health to the caster.',
  school: 2, // LifeMagic
  power: 1,
  baseMana: 10,
  duration: 0,
  formula: [1, 2, 3],
  icon: 0x06001234,
};

function makeDeps(overrides: Partial<SpellLearnDeps> = {}) {
  const known = new Set<number>();
  const learned: SpellDefinition[] = [];
  const deps: SpellLearnDeps = {
    spellTable: { spells: new Map<number, SpellBaseRow>([[HEAL_SELF_I, HEAL_SELF_ROW]]) },
    isSpellKnown: (id) => known.has(id),
    learnSpell: (spell) => { learned.push(spell); known.add(spell.id); },
    refreshSpellbook: vi.fn(),
    ...overrides,
  };
  return { deps, known, learned };
}

describe('Spell-learn handler (BUG.spell-learn-message-duplicated / FAITHFUL.413)', () => {
  it('learns an unknown spell and maps the DAT row onto the spellbook entry', () => {
    const { deps, learned } = makeDeps();

    expect(handleMagicUpdateSpell(HEAL_SELF_I, deps)).toBe('learned');
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({
      id: HEAL_SELF_I,
      name: 'Heal Self I',
      school: 2,
      power: 1,
      manaCost: 10,
      difficulty: 1,
      duration: 0,
      components: [1, 2, 3],
      targetType: 2,
      iconId: 0x06001234,
    });
  });

  it('refreshes the spellbook UI so the new icon appears immediately', () => {
    const { deps } = makeDeps();
    handleMagicUpdateSpell(HEAL_SELF_I, deps);
    expect(deps.refreshSpellbook).toHaveBeenCalledTimes(1);
  });

  it('plays no chime — the handler reaches for no sound dependency', () => {
    const { deps } = makeDeps();
    const touched: string[] = [];
    const spy = new Proxy(deps, {
      get(target, prop, receiver) {
        if (typeof prop === 'string') touched.push(prop);
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(handleMagicUpdateSpell(HEAL_SELF_I, spy)).toBe('learned');
    expect(touched.filter((k) => /sound|chime|audio/i.test(k))).toEqual([]);
  });

  it('emits no chat line — ACE always sends the learn text itself', () => {
    // Record every dependency the handler reaches for while learning a
    // spell. Re-introducing a client-synthesized "You have learned the X
    // spell." line means reaching for some chat/message sink, which shows
    // up here regardless of what it is named.
    const { deps } = makeDeps();
    const touched: string[] = [];
    const spy = new Proxy(deps, {
      get(target, prop, receiver) {
        if (typeof prop === 'string') touched.push(prop);
        return Reflect.get(target, prop, receiver);
      },
    });

    expect(handleMagicUpdateSpell(HEAL_SELF_I, spy)).toBe('learned');
    expect(touched).toContain('learnSpell');
    expect(touched.filter((k) => /message|chat|text|print|log/i.test(k))).toEqual([]);
  });

  it('does nothing for an already-known spell', () => {
    const { deps, learned } = makeDeps();
    handleMagicUpdateSpell(HEAL_SELF_I, deps);
    (deps.refreshSpellbook as ReturnType<typeof vi.fn>).mockClear();

    expect(handleMagicUpdateSpell(HEAL_SELF_I, deps)).toBe('already-known');
    expect(learned).toHaveLength(1);
    expect(deps.refreshSpellbook).not.toHaveBeenCalled();
  });

  it('reports a spell id missing from the SpellTable without learning it', () => {
    const { deps, learned } = makeDeps();
    expect(handleMagicUpdateSpell(9999, deps)).toBe('not-in-spell-table');
    expect(learned).toHaveLength(0);
    expect(deps.refreshSpellbook).not.toHaveBeenCalled();
  });

  it('is inert before the SpellTable has loaded', () => {
    const { deps, learned } = makeDeps({ spellTable: null });
    expect(handleMagicUpdateSpell(HEAL_SELF_I, deps)).toBe('no-spell-table');
    expect(learned).toHaveLength(0);
  });
});
