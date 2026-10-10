/**
 * GAP.77 — Augmentations. PREMISE CORRECTION.
 *
 * The reconciliation flagged: "AugmentationSystem effect engine has ZERO
 * consumers outside its own file — orphaned simulation." True, and now
 * fixed by deletion — but the interesting finding underneath is that
 * AugmentationDevice.cs (the server-side gem-use handler) needs almost no
 * client-side participation at all:
 *
 *  1. Every augmentation type reaches the client through wire shapes the
 *     client already handles generically: the Yes/No purchase prompt is a
 *     server-formatted ConfirmationRequest (onConfirmationRequest,
 *     main.ts:8427 — any confirmationType, text supplied by the server),
 *     the resulting stat change is a PrivateUpdateAttribute/PrivateUpdateSkill/
 *     PrivateUpdatePropertyInt (all already generically handled), the visual
 *     flash is one of 4 PlayScript.AugmentationUse* cases that already share
 *     one body (main.ts:9655-9662), and the ~43-entry augmentation section of
 *     CharacterInfoReport.ts already displays every PropertyInt the server
 *     can send (exceeding ACE's own AugmentationType enum, matching the
 *     decompiled retail UpdateAugmentations switch table).
 *
 *  2. RegenBonus (Innate Renewal / PropertyInt.AugmentationFasterRegen) used
 *     to feed a client-side regen prediction (GameLoop.gameTick →
 *     VitalSystem.regenTick). SWEEP1006B.hud-status.client-predicts-vital-
 *     regeneration-5 removed that prediction: retail never regenerates vitals
 *     client-side (only UpdateStat<Attribute_2nd> @ 00557d80 and the
 *     PlayerDescription change a vital), so the aug has NO client-side
 *     participation any more. VitalSystem.regenTick stays as the ACE formula
 *     port (Creature_Vitals.cs), exercised directly below.
 *
 *     STATS.regen-prediction-diverges — PREMISE CORRECTION of this file's
 *     earlier "gate it on Sleeping": ACE applies the multiplier in EVERY
 *     stance. Creature_Vitals.cs:129-131 is
 *       `var augMod = 1.0f;
 *        if (this is Player player && player.AugmentationFasterRegen > 0)
 *            augMod += player.AugmentationFasterRegen;`
 *     — no ForwardCommand test (that quote was not ACE's code).
 *
 * This test drives the real GameLoop + PlayerState + VitalSystem — no
 * source-text pins.
 */
import { describe, it, expect } from 'vitest';
import { GameLoop } from '../packages/renderer/src/GameLoop.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { VitalId, RegenStance, PropertyInt } from '@ac/shared';

function freshPlayer(): PlayerState {
  const p = new PlayerState();
  p.initFromCreation({
    name: 'Test', heritage: 1, gender: 1, level: 1,
    totalXp: 0n, availableXp: 0n, skillCredits: 0,
    attributes: { strength: 10, endurance: 80, coordination: 10, quickness: 10, focus: 10, self: 10 },
    skills: new Map(),
  });
  // End=80 => Health max = round(80/2) = 40, plenty of room for regen to
  // apply without clipping. Str+End=90 <= 200 => attributeMod stays 1.0.
  p.vitals.setCurrent(VitalId.Health, 1, p.attributes);
  // A server-sent HealthRate of 1 (FAITHFUL.377 path) keeps the arithmetic in
  // whole points; the player-weenie default 0.3 is covered elsewhere.
  p.vitals.setRegenRate(VitalId.Health, 1);
  return p;
}

describe('GAP.77 — augmentation-driven regen wiring', () => {
  it('serverIntProps mirror is the wiring path — no augmentation-specific handler needed', () => {
    const player = freshPlayer();
    // Same generic path onPrivateUpdatePropertyInt uses (main.ts:7057).
    player.serverIntProps.set(PropertyInt.AugmentationFasterRegen, 2);
    expect(player.serverIntProps.get(PropertyInt.AugmentationFasterRegen)).toBe(2);
  });

  it('GameLoop never regenerates vitals, even with an augmentation level (retail: server-owned)', () => {
    const player = freshPlayer();
    player.serverIntProps.set(PropertyInt.AugmentationFasterRegen, 2);
    const loop = new GameLoop(10);
    loop.setPlayerState(player);
    loop.start();
    const before = player.vitals.getCurrent(VitalId.Health);
    loop.update(30);
    expect(player.vitals.getCurrent(VitalId.Health)).toBe(before);
  });

  /** The ACE formula port, driven directly (no client caller any more). */
  function regenOnce(player: PlayerState, stance: RegenStance): number {
    const aug = player.serverIntProps.get(PropertyInt.AugmentationFasterRegen) ?? 0;
    const before = player.vitals.getCurrent(VitalId.Health);
    player.vitals.regenTick(5.2, player.attributes, stance, undefined, aug);
    return player.vitals.getCurrent(VitalId.Health) - before;
  }

  it('VitalSystem.regenTick applies the augmentation level while Standing too (ACE has no stance gate)', () => {
    const player = freshPlayer();
    player.serverIntProps.set(PropertyInt.AugmentationFasterRegen, 2);
    // Standing, Str+End=90 => attributeMod=1.0, stanceMod=1.0, augMod =
    // 1 + 2 = 3.0 (Creature_Vitals.cs:129-131) => 1 * 1.0 * 1.0 * 3.0 = 3.
    expect(regenOnce(player, RegenStance.Standing)).toBe(3);
  });

  it('VitalSystem.regenTick applies the augmentation level while Sleeping', () => {
    const player = freshPlayer();
    player.serverIntProps.set(PropertyInt.AugmentationFasterRegen, 2);
    // Sleeping stanceMod=3.0, augMod=3.0 => 9.
    expect(regenOnce(player, RegenStance.Sleeping)).toBe(9);
  });

  it('VitalSystem.regenTick with no augmentation level sent', () => {
    const player = freshPlayer();
    // Sleeping stanceMod=3.0, augMod=1.0 => 3.
    expect(regenOnce(player, RegenStance.Sleeping)).toBe(3);
  });
});
