/**
 * DefenderNotification diagnostic log (FAITHFUL.287).
 *
 * Live-fire melee testing on 2026-05-20 revealed an apparent gap: the
 * player took lethal damage from a creature with NO `[DefenderNotification]`
 * log line preceding the death sequence. Initial hypothesis: the wire-
 * format parser was silently failing, or the event wasn't being dispatched.
 *
 * Investigation into ACE source `reference/ACE/Source/ACE.Server/WorldObjects/
 * Player_Combat.cs:524-529` revealed the actual mechanism: on lethal hits
 * (Health.Current <= 0), TakeDamage early-returns to call OnDeath() + Die()
 * BEFORE reaching the `EnqueueSend(new GameEventDefenderNotification(...))`
 * at line 542. So ACE intentionally skips DefenderNotification on one-shot
 * kills — the player goes straight to the death sequence (vitae + corpse +
 * respawn) with no preceding "X hits you for N damage" chat message.
 *
 * This is intentional retail behavior (matching the original AC client) —
 * NOT a client-side bug.
 *
 * FAITHFUL.287 adds a diagnostic console.log to the handler (via the
 * `formatDefenderNotificationLog` helper in @ac/shared) so a future
 * investigator doesn't repeat the same hypothesis-then-investigation cycle.
 * Future "no DefenderNotification log on a death" reports can be quickly
 * classified as either:
 *   (a) Lethal hit — expected per ACE early-return.
 *   (b) Non-lethal hit + no log line — real bug to investigate.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatDefenderNotificationLog } from '@ac/shared';
import { DamageType } from '@ac/shared';
import { showDefenderNotification } from '../packages/renderer/src/ui/ServerMessageText.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile, EOR_ERA_ID } from '../packages/renderer/src/era/EraProfiles.js';

const REPO = resolve(__dirname, '..');
const ACE_COMBAT = resolve(REPO, 'reference/ACE/Source/ACE.Server/WorldObjects/Player_Combat.cs');

describe('formatDefenderNotificationLog (FAITHFUL.287)', () => {
  it('formats attacker, damage, and damage type into a [DefenderNotification] line', () => {
    expect(formatDefenderNotificationLog('Olthoi Ripper', DamageType.Slash, 42, false)).toBe(
      '[DefenderNotification] Olthoi Ripper hit for 42 slashing',
    );
  });

  it('appends CRIT for critical hits', () => {
    expect(formatDefenderNotificationLog('Olthoi Ripper', DamageType.Fire, 100, true)).toBe(
      '[DefenderNotification] Olthoi Ripper hit for 100 fire CRIT',
    );
  });

});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('onDefenderNotification (showDefenderNotification) logs the diagnostic line in every era', () => {
  const facts = { name: 'Drudge Skulker', damageType: DamageType.Bludgeon, severity: 0.3, damage: 12, critical: true, bodyPart: 3 };
  for (const id of [EOR_ERA_ID, 'classic-dereth', 'classicace-customdm', 'classicace-infiltration', 'ac1999-retail']) {
    it(`${id}: the [DefenderNotification] console line, then the era's one hit line on the scroll`, () => {
      const rule = eraClientRules(eraProfile(id)).hitLineText;
      const logged: string[] = [];
      const chat: string[] = [];
      const ui = { displayErrorText: () => { throw new Error('a hit line is never spew'); }, addSystemMessage: (t: string) => { chat.push(t); } };
      const line = showDefenderNotification(ui, rule, facts, (l) => logged.push(l));
      expect(logged).toEqual(['[DefenderNotification] Drudge Skulker hit for 12 bludgeoning CRIT']);
      expect(chat).toEqual([line.text]);
    });
  }
  it('the default logger is console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    showDefenderNotification({ displayErrorText: () => {}, addSystemMessage: () => {} }, 'eor', facts);
    expect(spy).toHaveBeenCalledWith('[DefenderNotification] Drudge Skulker hit for 12 bludgeoning CRIT');
  });
});

describe.skipIf(!aceReferenceExists(ACE_COMBAT))('ACE source pin (FAITHFUL.287)', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_COMBAT, 'utf8');
  });

  it('Player_Combat.TakeDamage short-circuits on Health.Current <= 0 BEFORE DefenderNotification', () => {
    // Find the conditional early-return.
    expect(src).toMatch(/if \(Health\.Current <= 0\)/);

    // The early-return path calls OnDeath + Die + returns.
    const earlyReturnPos = src.search(/if \(Health\.Current <= 0\)/);
    const defNotifPos = src.search(/EnqueueSend\(new GameEventDefenderNotification/);
    expect(earlyReturnPos).toBeGreaterThan(0);
    expect(defNotifPos).toBeGreaterThan(0);
    // The early-return must appear BEFORE the EnqueueSend for the
    // documented behavior to hold.
    expect(earlyReturnPos).toBeLessThan(defNotifPos);
  });

  it('DefenderNotification is sent unconditionally when source is Creature (modulo squelch)', () => {
    // The flow: TakeDamage → (lethal? early-return) → if (source is Creature) → EnqueueSend(DefenderNotification).
    expect(src).toMatch(/if \(source is Creature creature\)/);
    expect(src).toMatch(/EnqueueSend\(new GameEventDefenderNotification/);
  });
});
