/**
 * SpellLearn -- reaction to GameEventMagicUpdateSpell (0x02C1).
 *
 * ACE sends this event from exactly one place: Player.LearnSpellWithNetworking
 * (ACE.Server/WorldObjects/Player_Spells.cs:69). That method always emits the
 * player-facing text itself alongside the event -- "You learn the X spell."
 * as a Broadcast GameMessageSystemChat when uiOutput is true (:76-80), or a
 * GameEventCommunicationTransientString "You have learned a new spell." when
 * it is false (:84). The retail client therefore never synthesizes a learn
 * line of its own from the event; doing so prints the message twice.
 *
 * Pure logic: no DOM, no Three.js. Effects are delivered through `deps` so
 * the real decision path is drivable from tests.
 */

import { spellLevelFromPower } from '@ac/shared';
import type { MagicSchool, SpellDefinition } from '@ac/shared';

/** The SpellTable row fields this handler consumes (DAT SpellBase). */
export interface SpellBaseRow {
  name: string;
  desc?: string;
  school: number;
  power: number;
  baseMana: number;
  duration?: number;
  formula: number[];
  icon?: number;
}

export interface SpellLearnDeps {
  /** Parsed DAT SpellTable, or null when it has not loaded yet. */
  spellTable: { spells: Map<number, SpellBaseRow> } | null;
  isSpellKnown(spellId: number): boolean;
  learnSpell(spell: SpellDefinition): void;
  /** Push the updated spellbook into the UI. */
  refreshSpellbook(): void;
}

export type SpellLearnOutcome =
  | 'learned'
  | 'already-known'
  | 'no-spell-table'
  | 'not-in-spell-table';

/**
 * Apply a MagicUpdateSpell event to the local spellbook.
 *
 * Deliberately emits no chat message -- see the module docblock: the server
 * always sends the learn text itself.
 */
export function handleMagicUpdateSpell(
  spellId: number,
  deps: SpellLearnDeps,
): SpellLearnOutcome {
  if (!deps.spellTable) return 'no-spell-table';
  if (deps.isSpellKnown(spellId)) return 'already-known';

  const sb = deps.spellTable.spells.get(spellId);
  if (!sb) return 'not-in-spell-table';

  deps.learnSpell({
    id: spellId,
    name: sb.name,
    desc: sb.desc,
    school: sb.school as MagicSchool,
    level: spellLevelFromPower(sb.power),
    power: sb.power,
    manaCost: sb.baseMana,
    difficulty: sb.power,
    duration: sb.duration ?? 0,
    components: sb.formula,
    targetType: 2, // SingleTarget default
    iconId: sb.icon || undefined,
  });

  deps.refreshSpellbook();
  // BUG.nonpositional-human-table-sounds — no local chime: ACE plays the
  // SkillUpPurple script on the player (Player_Spells.cs:76), whose own hooks
  // are the learn effect; the retail client plays nothing for the event.
  return 'learned';
}
