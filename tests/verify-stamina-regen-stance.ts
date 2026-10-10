/**
 * GAP.8 — stamina vs running, ACE ground truth (behavioral).
 *
 * SWEEP1006B.hud-status.client-predicts-vital-regeneration-5: the client no
 * longer predicts regen at all (retail changes vitals only on server
 * UpdateStat<Attribute_2nd> @ 00557d80 / PlayerDescription). The stance math
 * below is the ACE formula port in VitalSystem.regenTick, driven directly.
 *
 * Two facts verified against ACE and pinned here:
 *
 * 1. Running NEVER drains stamina. The only stamina consumers in ACE are
 *    jump (Player.cs:898), melee attacks (Player_Melee.cs:302), missile
 *    attacks (Player_Missile.cs:242) and combat events (Player_Combat.cs
 *    :331/:334/:518). There is NO movement-based drain — the task
 *    description's "missing feature" is an intentional absence.
 *
 * 2. Running DOES halve health+stamina regen: ACE GetStanceMod
 *    (Creature_Vitals.cs:210-236) returns 0.5 when CombatMode != NonCombat
 *    or ForwardCommand == RunForward (crouch 2.0 / sitting 2.5 /
 *    sleeping 3.0; mana exempt).
 */
import { describe, it, expect } from 'vitest';
import { GameLoop } from '../packages/renderer/src/GameLoop.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { VitalId, RegenStance, REGEN_INTERVAL } from '@ac/shared';

/** Fresh player (End 100 → 100 max stamina) drained low so regen has headroom. */
function makePlayer(): PlayerState {
  const ps = new PlayerState();
  ps.initFromCreation({
    name: 'RegenTest', heritage: 1, gender: 1,
    attributes: { strength: 100, endurance: 100, coordination: 100, quickness: 10, focus: 10, self: 100 },
    skills: [],
  } as never);
  ps.vitals.initToMax(ps.attributes);
  ps.vitals.setCurrent(VitalId.Stamina, 10, ps.attributes);
  ps.vitals.setCurrent(VitalId.Health, 10, ps.attributes);
  // STATS.regen-prediction-diverges — the prediction now reads the live
  // RegenRate (player-weenie default 0.3 / 3 / 1). Pin server-sent even rates
  // (health 1, stamina 2) so the half-rate comparisons stay whole-point.
  ps.vitals.setRegenRate(VitalId.Health, 1);
  ps.vitals.setRegenRate(VitalId.Stamina, 2);
  return ps;
}

/** Drive the ACE regen formula port (VitalSystem.regenTick) for `seconds`. */
function runLoop(ps: PlayerState, stance: RegenStance | null, seconds: number): void {
  const step = 0.1;
  for (let t = 0; t < seconds; t += step) {
    ps.vitals.regenTick(step, ps.attributes, stance ?? undefined);
  }
}

describe('GameLoop never predicts vital regen (retail gmVitalsUI is server-driven)', () => {
  it('stamina and health hold across a minute of real GameLoop ticks', () => {
    const ps = makePlayer();
    const loop = new GameLoop(10);
    loop.setPlayerState(ps);
    loop.start();
    for (let i = 0; i < 600; i++) loop.update(0.1);
    expect(ps.vitals.getCurrent(VitalId.Stamina)).toBe(10);
    expect(ps.vitals.getCurrent(VitalId.Health)).toBe(10);
  });
});

describe('GAP.8 — running never drains stamina (intentional absence, ACE-verified)', () => {
  it('stamina only ever rises across sustained running regen', () => {
    const ps = makePlayer();
    let last = ps.vitals.getCurrent(VitalId.Stamina);
    for (let i = 0; i < 600; i++) { // 60s of running
      ps.vitals.regenTick(0.1, ps.attributes, RegenStance.Running);
      const cur = ps.vitals.getCurrent(VitalId.Stamina);
      expect(cur, 'running must never drain stamina').toBeGreaterThanOrEqual(last);
      last = cur;
    }
    expect(last).toBeGreaterThan(10); // and regen actually happened
  });
});

describe('GAP.8 — stance halves regen (ACE GetStanceMod formula port)', () => {
  it('running regen is exactly half of standing regen for stamina and health', () => {
    const standing = makePlayer();
    const running = makePlayer();
    const T = REGEN_INTERVAL * 8; // 8 regen ticks — enough to avoid rounding noise
    runLoop(standing, RegenStance.Standing, T);
    runLoop(running, RegenStance.Running, T);
    const standingGain = standing.vitals.getCurrent(VitalId.Stamina) - 10;
    const runningGain = running.vitals.getCurrent(VitalId.Stamina) - 10;
    expect(standingGain).toBeGreaterThan(0);
    // base stamina rate 2/tick: standing 16, running 8 over 8 ticks
    expect(runningGain * 2).toBe(standingGain);

    const standingHp = standing.vitals.getCurrent(VitalId.Health) - 10;
    const runningHp = running.vitals.getCurrent(VitalId.Health) - 10;
    expect(runningHp * 2).toBe(standingHp);
  });

  it('combat stance matches running (both 0.5 per Creature_Vitals.cs:221-222)', () => {
    const combat = makePlayer();
    const running = makePlayer();
    const T = REGEN_INTERVAL * 8;
    runLoop(combat, RegenStance.Combat, T);
    runLoop(running, RegenStance.Running, T);
    expect(combat.vitals.getCurrent(VitalId.Stamina)).toBe(running.vitals.getCurrent(VitalId.Stamina));
  });

  it('mana regen is stance-exempt (Creature_Vitals.cs:216)', () => {
    const standing = makePlayer();
    const running = makePlayer();
    standing.vitals.setCurrent(VitalId.Mana, 10, standing.attributes);
    running.vitals.setCurrent(VitalId.Mana, 10, running.attributes);
    const T = REGEN_INTERVAL * 8;
    runLoop(standing, RegenStance.Standing, T);
    runLoop(running, RegenStance.Running, T);
    expect(running.vitals.getCurrent(VitalId.Mana)).toBe(standing.vitals.getCurrent(VitalId.Mana));
  });

  it('no stance → Standing default', () => {
    const dflt = makePlayer();
    const standing = makePlayer();
    const T = REGEN_INTERVAL * 4;
    runLoop(dflt, null, T);
    runLoop(standing, RegenStance.Standing, T);
    expect(dflt.vitals.getCurrent(VitalId.Stamina)).toBe(standing.vitals.getCurrent(VitalId.Stamina));
  });
});
