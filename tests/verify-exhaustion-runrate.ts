/**
 * BUG.exhaustion-does-not-slow-movement — exhaustion (stamina = 0) must
 * collapse the player's run rate to walk speed (rate 1.0), and recovery
 * must restore the burden/skill-based rate.
 *
 * Ground truth (both references agree the exhausted rate is exactly 1.0):
 *
 * - RETAIL CLIENT (authoritative for client movement):
 *   CACQualities::InqRunRate (acclient @ 00592800, decompiled) zeroes the
 *   effective Run skill when current enchanted stamina is 0 —
 *     `if (local_10 == 0) local_20 = 0;`
 *   — then calls MovementSystem::GetRunRate(load, runSkill, 1.0), giving
 *   (loadMod·0 + 4)/4 = 1.0 regardless of burden.
 *
 * - ACE SERVER: Monster_Navigation.cs:358-361 substitutes burden = 3.0f
 *   when player.IsExhausted (Creature.cs:25 — Stamina.Current == 0);
 *   getBurdenMod(3.0) = 0 collapses the same formula to 1.0. ACE
 *   re-broadcasts on the 0-transition (Player_Vitals.cs:145-156 →
 *   OnExhausted → HandleRunRateUpdate) and on recovery.
 *
 * The shipped fix: shared getPlayerRunRate(burden, skill, isExhausted)
 * implements the retail skill-zero clamp; main.ts updateRunRate feeds
 * playerState.vitals.isExhausted() into it and a GameLoop tick watcher
 * recomputes on 0-transitions (main.ts is a self-executing bootstrap module
 * that can't be imported in a test environment — this file behaviorally
 * exercises the importable halves: the rate function against real
 * VitalSystem exhaustion state driven through real stamina drain/regen).
 */
import { describe, it, expect } from 'vitest';
import { GameLoop } from '../packages/renderer/src/GameLoop.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { VitalId, getRunRate, getClientRunRate, getPlayerRunRate, getBurdenMod } from '@ac/shared';

function makePlayer(): PlayerState {
  const ps = new PlayerState();
  ps.initFromCreation({
    name: 'ExhaustTest', heritage: 1, gender: 1,
    attributes: { strength: 100, endurance: 100, coordination: 100, quickness: 100, focus: 10, self: 10 },
    skills: [],
  } as never);
  ps.vitals.initToMax(ps.attributes);
  return ps;
}

describe('getPlayerRunRate — retail exhaustion clamp (CACQualities::InqRunRate @ 00592800)', () => {
  it('exhausted → rate is exactly 1.0 (walk) for any skill and any burden', () => {
    for (const skill of [0, 50, 300, 650, 800, 1200]) {
      for (const burden of [0, 0.25, 0.5, 1.0, 2.0, 3.0]) {
        expect(getPlayerRunRate(burden, skill, true)).toBe(1.0);
      }
    }
  });

  it('not exhausted → the plain run-rate formula (ACE\'s up to Run 800; above it the client keeps the curve, GetRunRate @ 006b0950)', () => {
    for (const skill of [0, 50, 300, 650, 800, 1200]) {
      for (const burden of [0, 0.25, 0.5, 1.0]) {
        expect(getPlayerRunRate(burden, skill, false)).toBe(getClientRunRate(burden, skill));
        if (skill <= 800) expect(getPlayerRunRate(burden, skill, false)).toBe(getRunRate(burden, skill));
      }
    }
    expect(getPlayerRunRate(0, 1200, false)).toBeLessThan(getRunRate(0, 1200));
  });

  it('retail skill-zero form and ACE burden-3.0 form agree exactly', () => {
    // ACE Monster_Navigation.cs:358-361 models exhaustion as burden = 3.0;
    // getBurdenMod(3.0) = 0 collapses the formula to the same 1.0 the
    // retail client reaches by zeroing the skill. Pin the equivalence so a
    // future formula change can't silently split the two.
    expect(getBurdenMod(3.0)).toBe(0);
    for (const skill of [50, 300, 650]) {
      expect(getPlayerRunRate(0.4, skill, true)).toBe(getRunRate(3.0, skill));
    }
  });

  it('exhausted rate is a real slowdown vs any normal running rate', () => {
    // Run skill 300, unburdened: (0.66·6.6 + 4)/4 ≈ 1.65 — must exceed 1.0
    expect(getRunRate(0, 300)).toBeGreaterThan(1.0);
    expect(getPlayerRunRate(0, 300, true)).toBeLessThan(getRunRate(0, 300));
  });
});

describe('exhaustion transition — real VitalSystem stamina drain and regen', () => {
  it('draining stamina to 0 flips isExhausted and collapses the recomputed rate', () => {
    const ps = makePlayer();
    const runSkill = 300;
    const burden = 0.2;

    expect(ps.vitals.getCurrent(VitalId.Stamina)).toBeGreaterThan(0);
    expect(ps.vitals.isExhausted()).toBe(false);
    const normalRate = getPlayerRunRate(burden, runSkill, ps.vitals.isExhausted());
    expect(normalRate).toBe(getRunRate(burden, runSkill));
    expect(normalRate).toBeGreaterThan(1.0);

    // Burn all stamina (ACE never gates on stamina — cost clamps to 0),
    // e.g. repeated jump costs landing via useStamina.
    ps.vitals.useStamina(ps.vitals.getCurrent(VitalId.Stamina) + 25);
    expect(ps.vitals.getCurrent(VitalId.Stamina)).toBe(0);
    expect(ps.vitals.isExhausted()).toBe(true);
    expect(getPlayerRunRate(burden, runSkill, ps.vitals.isExhausted())).toBe(1.0);
  });

  it('a server stamina update lifts stamina off 0 and restores the rate', () => {
    const ps = makePlayer();
    ps.vitals.useStamina(ps.vitals.getCurrent(VitalId.Stamina) + 1);
    expect(ps.vitals.isExhausted()).toBe(true);

    // The client never predicts regen (retail: vitals move only on server
    // UpdateStat<Attribute_2nd>); ACE's VitalHeartBeat push lifts it.
    const loop = new GameLoop(10);
    loop.setPlayerState(ps);
    loop.start();
    loop.update(30);
    expect(ps.vitals.isExhausted()).toBe(true);
    ps.vitals.setCurrent(VitalId.Stamina, 3, ps.attributes);

    expect(ps.vitals.isExhausted()).toBe(false);
    const burden = 0.2;
    const runSkill = 300;
    expect(getPlayerRunRate(burden, runSkill, ps.vitals.isExhausted())).toBe(getRunRate(burden, runSkill));
  });

  it('a GameLoop tick watcher observes both 0-transitions (the main.ts wiring shape)', () => {
    // main.ts registers gameLoop.onTick(() => { if (isExhausted() !==
    // wasExhausted) updateRunRate(); }). Prove the mechanism end-to-end
    // with the real GameLoop: the watcher fires once per transition.
    const ps = makePlayer();
    const loop = new GameLoop(10);
    loop.setPlayerState(ps);
    const rates: number[] = [];
    let wasExhausted = ps.vitals.isExhausted();
    loop.onTick(() => {
      const exhausted = ps.vitals.isExhausted();
      if (exhausted !== wasExhausted) {
        wasExhausted = exhausted;
        rates.push(getPlayerRunRate(0.2, 300, exhausted));
      }
    });
    loop.start();

    loop.update(0.1); // no transition yet
    expect(rates).toEqual([]);

    ps.vitals.useStamina(ps.vitals.getCurrent(VitalId.Stamina) + 5);
    loop.update(0.1); // watcher sees the →0 transition
    expect(rates).toEqual([1.0]);

    ps.vitals.setCurrent(VitalId.Stamina, 3, ps.attributes); // server vital push
    loop.update(0.1);
    expect(ps.vitals.isExhausted()).toBe(false);
    expect(rates.length).toBe(2); // recovery transition fired exactly once
    expect(rates[1]).toBe(getRunRate(0.2, 300));
    expect(rates[1]).toBeGreaterThan(1.0);
  });
});
