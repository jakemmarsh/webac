/**
 * Phase 33 — Player Character (PlayerState, GameLoop, ACE movement formulas)
 *
 * Tests:
 *  - PlayerState tracks attributes/skills/vitals correctly
 *  - GameLoop ticks at 10Hz; it never predicts vital regen (server-owned)
 *  - the ACE movement formulas CameraController/main.ts run on
 * (The standalone PlayerController + shared PlayerMovement were never
 * reachable from the shipped client — CameraController owns movement — and
 * were deleted in DEBT.shared-dead-server-logic.)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AttributeId, VitalId, SkillAdvancementClass, getRunRate, getJumpHeight, getJumpStaminaCost,
  getEncumbranceCapacity, getBurden, getBurdenMod, BACKWARDS_FACTOR, SIDESTEP_FACTOR,
} from '@ac/shared';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import type { CharacterInfo } from '../packages/renderer/src/player/PlayerState.js';
import { GameLoop } from '../packages/renderer/src/GameLoop.js';

function makeCharacterInfo(): CharacterInfo {
  return {
    name: 'TestHero',
    heritage: 1,
    gender: 0,
    level: 5,
    totalXp: 10000n,
    availableXp: 5000n,
    skillCredits: 50,
    attributes: {
      strength: 60,
      endurance: 100,
      coordination: 50,
      quickness: 40,
      focus: 30,
      self: 50,
    },
    skills: new Map([
      [1, SkillAdvancementClass.Specialized],
      [6, SkillAdvancementClass.Trained],
    ]),
  };
}

describe('Phase 33 — Player Character', () => {

  // ============================================================
  // C2: PlayerState
  // ============================================================
  describe('PlayerState', () => {
    let state: PlayerState;

    beforeEach(() => {
      state = new PlayerState();
    });

    it('should create with default attributes', () => {
      expect(state.attributes.getCurrent(AttributeId.Strength)).toBe(10);
      expect(state.attributes.getCurrent(AttributeId.Self)).toBe(10);
    });

    it('should initialize from character info', () => {
      const info = makeCharacterInfo();
      state.initFromCreation(info);

      expect(state.name).toBe('TestHero');
      expect(state.heritage).toBe(1);
      expect(state.gender).toBe(0);
      expect(state.level).toBe(5);

      // Check attributes
      expect(state.attributes.getCurrent(AttributeId.Strength)).toBe(60);
      expect(state.attributes.getCurrent(AttributeId.Endurance)).toBe(100);
      expect(state.attributes.getCurrent(AttributeId.Self)).toBe(50);
    });

    it('should compute correct vital max from attributes', () => {
      const info = makeCharacterInfo();
      state.initFromCreation(info);

      // Health = floor(Endurance / 2) = floor(100 / 2) = 50
      expect(state.health.max).toBe(50);
      // Stamina = Endurance = 100
      expect(state.stamina.max).toBe(100);
      // Mana = Self = 50
      expect(state.mana.max).toBe(50);
    });

    it('should initialize vitals to max after creation', () => {
      const info = makeCharacterInfo();
      state.initFromCreation(info);

      // After initFromCreation, vitals should be at max
      expect(state.health.current).toBe(state.health.max);
      expect(state.stamina.current).toBe(state.stamina.max);
      expect(state.mana.current).toBe(state.mana.max);
    });

    it('should report healthFraction correctly', () => {
      const info = makeCharacterInfo();
      state.initFromCreation(info);

      // Full health
      expect(state.healthFraction).toBeCloseTo(1.0);

      // Take damage
      state.vitals.takeDamage(25);
      expect(state.healthFraction).toBeCloseTo(0.5);
    });

    it('should track XP and level', () => {
      const info = makeCharacterInfo();
      state.initFromCreation(info);

      expect(state.xp.totalXp).toBe(10000n);
      expect(state.xp.availableXp).toBe(5000n);
      expect(state.xp.totalSkillCredits).toBe(50);
    });

    it('should detect death when health reaches 0', () => {
      const info = makeCharacterInfo();
      state.initFromCreation(info);

      expect(state.isDead).toBe(false);
      state.vitals.takeDamage(1000); // overkill
      expect(state.isDead).toBe(true);
    });

    it('should serialize to object', () => {
      const info = makeCharacterInfo();
      state.initFromCreation(info);

      const data = state.serialize() as any;
      expect(data.name).toBe('TestHero');
      expect(data.level).toBe(5);
      expect(data.totalXp).toBe('10000');
      expect(data.health).toBe(50);
      expect(typeof data.vitae).toBe('number');
    });
  });

  // ============================================================
  // C3: GameLoop
  // ============================================================
  describe('GameLoop', () => {
    it('should create with default 10Hz tick rate', () => {
      const loop = new GameLoop();
      expect(loop.ticksPerSecond).toBe(10);
    });

    it('should not tick when not running', () => {
      const loop = new GameLoop();
      let tickCount = 0;
      loop.onTick(() => tickCount++);
      loop.update(1.0); // 1 second
      expect(tickCount).toBe(0);
    });

    it('should tick at fixed rate when running', () => {
      const loop = new GameLoop(10);
      loop.start();
      let tickCount = 0;
      loop.onTick(() => tickCount++);

      // Feed 1 second of time in small increments
      for (let i = 0; i < 60; i++) {
        loop.update(1 / 60);
      }

      // At 10Hz over 1 second, should have ~10 ticks
      expect(tickCount).toBeGreaterThanOrEqual(9);
      expect(tickCount).toBeLessThanOrEqual(11);
    });

    it('should track elapsed time', () => {
      const loop = new GameLoop(10);
      loop.start();
      loop.update(0.5);
      loop.update(0.5);
      expect(loop.totalElapsed).toBeCloseTo(1.0, 1);
    });

    it('never regenerates vitals client-side — only server updates move them (retail gmVitalsUI)', () => {
      // SWEEP1006B.hud-status.client-predicts-vital-regeneration-5: retail
      // changes a vital's current value only via UpdateStat<Attribute_2nd>
      // (@ 00557d80) / PlayerDescription; there is no client regen clock.
      const loop = new GameLoop(10);
      const state = new PlayerState();
      state.initFromCreation(makeCharacterInfo());
      state.vitals.takeDamage(20);
      const healthBefore = state.vitals.getCurrent(VitalId.Health);
      expect(healthBefore).toBe(30);

      loop.setPlayerState(state);
      loop.start();
      for (let i = 0; i < 60 * 60; i++) loop.update(1 / 60); // one minute

      expect(state.vitals.getCurrent(VitalId.Health)).toBe(healthBefore);
      // A server vital update is what moves it.
      state.vitals.setCurrent(VitalId.Health, 41, state.attributes);
      loop.update(1);
      expect(state.vitals.getCurrent(VitalId.Health)).toBe(41);
    });

    it('should tick enchantments', () => {
      const loop = new GameLoop(10);
      const state = new PlayerState();
      const info = makeCharacterInfo();
      state.initFromCreation(info);

      // Add an enchantment with 0.5 second duration
      state.enchantments.apply({
        spellId: 1,
        spellName: 'Test Buff',
        category: 1, // AttributeBuff
        buffAttribute: 1,
        magnitude: 10,
        duration: 0.5,
        remaining: 0.5,
        casterId: 0,
        spellLevel: 1,
      });
      expect(state.enchantments.count).toBe(1);

      loop.setPlayerState(state);
      loop.start();

      // Run for 1 second — enchantment should expire
      for (let i = 0; i < 60; i++) {
        loop.update(1 / 60);
      }

      expect(state.enchantments.count).toBe(0);
    });

    it('should not tick when player is dead', () => {
      const loop = new GameLoop(10);
      const state = new PlayerState();
      const info = makeCharacterInfo();
      state.initFromCreation(info);

      // Kill the player
      state.vitals.takeDamage(1000);
      expect(state.isDead).toBe(true);

      // Add enchantment — should NOT be ticked since player is dead
      state.enchantments.apply({
        spellId: 2,
        spellName: 'Death Buff',
        category: 1,
        buffAttribute: 1,
        magnitude: 5,
        duration: 0.1,
        remaining: 0.1,
        casterId: 0,
        spellLevel: 1,
      });

      loop.setPlayerState(state);
      loop.start();

      for (let i = 0; i < 60; i++) {
        loop.update(1 / 60);
      }

      // Enchantment should still be there (not ticked because dead)
      expect(state.enchantments.count).toBe(1);
    });

    it('should support registering and removing callbacks', () => {
      const loop = new GameLoop(10);
      loop.start();
      let count = 0;
      const cb = () => count++;
      loop.onTick(cb);
      loop.update(0.2); // ~2 ticks
      const countBefore = count;
      expect(countBefore).toBeGreaterThan(0);

      loop.offTick(cb);
      loop.update(0.2);
      expect(count).toBe(countBefore); // no more ticks
    });

    it('should stop ticking when stopped', () => {
      const loop = new GameLoop(10);
      loop.start();
      let count = 0;
      loop.onTick(() => count++);
      loop.update(0.2);
      const countBefore = count;
      expect(countBefore).toBeGreaterThan(0);

      loop.stop();
      expect(loop.isRunning).toBe(false);
      loop.update(0.2);
      expect(count).toBe(countBefore);
    });
  });
});

// ============================================================
// ACE Movement Formulas (MovementSystem.cs, EncumbranceSystem.cs)
// ============================================================
describe('ACE Movement Formulas', () => {
  // ─── Encumbrance System ────────────────────────────────────

  describe('Encumbrance System', () => {
    it('capacity = 150 * STR with no augs', () => {
      expect(getEncumbranceCapacity(100)).toBe(15000);
      expect(getEncumbranceCapacity(200)).toBe(30000);
      expect(getEncumbranceCapacity(10)).toBe(1500);
    });

    it('capacity includes augmentation bonus (30 per aug, max 150)', () => {
      // 1 aug: 150*100 + 100*30 = 15000+3000 = 18000
      expect(getEncumbranceCapacity(100, 1)).toBe(18000);
      // 5 augs: 150*100 + 100*150 = 15000+15000 = 30000 (capped at 150 bonus)
      expect(getEncumbranceCapacity(100, 5)).toBe(30000);
      // 6 augs: same as 5 (bonus capped at 150)
      expect(getEncumbranceCapacity(100, 6)).toBe(30000);
    });

    it('capacity = 0 for 0 strength', () => {
      expect(getEncumbranceCapacity(0)).toBe(0);
    });

    it('burden ratio = encumbrance / capacity', () => {
      expect(getBurden(15000, 7500)).toBeCloseTo(0.5);
      expect(getBurden(15000, 15000)).toBeCloseTo(1.0);
      expect(getBurden(15000, 30000)).toBeCloseTo(2.0);
    });

    it('burden ratio = 3.0 for 0 capacity', () => {
      expect(getBurden(0, 100)).toBe(3.0);
    });

    it('burden mod = 1.0 when under 100%', () => {
      expect(getBurdenMod(0.0)).toBe(1.0);
      expect(getBurdenMod(0.5)).toBe(1.0);
      expect(getBurdenMod(0.99)).toBe(1.0);
    });

    it('burden mod declines linearly from 100% to 200%', () => {
      expect(getBurdenMod(1.0)).toBeCloseTo(1.0);
      expect(getBurdenMod(1.5)).toBeCloseTo(0.5);
      expect(getBurdenMod(1.9)).toBeCloseTo(0.1);
    });

    it('burden mod = 0.0 at 200%+', () => {
      expect(getBurdenMod(2.0)).toBe(0.0);
      expect(getBurdenMod(3.0)).toBe(0.0);
    });
  });

  // ─── Run Speed ─────────────────────────────────────────────

  describe('Run Speed (getRunRate)', () => {
    it('max run rate at Run skill >= 800', () => {
      // ACE: 18.0 / 4.0 = 4.5 at skill 800+
      expect(getRunRate(0, 800)).toBeCloseTo(4.5);
      expect(getRunRate(0, 1000)).toBeCloseTo(4.5);
    });

    it('run rate scales with Run skill', () => {
      // At skill 0, burden 0: ((1.0 * (0/200 * 11) + 4) / 1.0) / 4.0 = 4/4 = 1.0
      expect(getRunRate(0, 0)).toBeCloseTo(1.0);

      // At skill 100, burden 0: ((1.0 * (100/300 * 11) + 4) / 1.0) / 4.0
      // = ((3.667 + 4) / 1.0) / 4.0 = 7.667 / 4.0 ≈ 1.917
      expect(getRunRate(0, 100)).toBeCloseTo(1.917, 2);

      // At skill 300, burden 0: ((1.0 * (300/500 * 11) + 4) / 1.0) / 4.0
      // = ((6.6 + 4) / 1.0) / 4.0 = 10.6 / 4.0 = 2.65
      expect(getRunRate(0, 300)).toBeCloseTo(2.65, 2);

      // Run rate increases with skill
      expect(getRunRate(0, 200)).toBeGreaterThan(getRunRate(0, 100));
      expect(getRunRate(0, 400)).toBeGreaterThan(getRunRate(0, 200));
    });

    it('burden reduces run rate', () => {
      const noLoadRate = getRunRate(0, 300);
      const halfLoadRate = getRunRate(1.5, 300); // burdenMod = 0.5
      // With burden, the skill contribution is halved
      expect(halfLoadRate).toBeLessThan(noLoadRate);
    });

    it('200% burden = cannot run (only base walk speed)', () => {
      // burdenMod = 0.0, so: ((0.0 * (...) + 4) / 1.0) / 4.0 = 4/4 = 1.0
      expect(getRunRate(2.0, 300)).toBeCloseTo(1.0);
    });
  });

  // ─── Jump Height ───────────────────────────────────────────

  describe('Jump Height (getJumpHeight)', () => {
    it('minimum jump height = 0.35', () => {
      // At 0 skill, 0 power: effectively 0 but clamped to 0.35
      expect(getJumpHeight(0, 0, 0.1)).toBeCloseTo(0.35);
      expect(getJumpHeight(2.0, 100, 0.5)).toBeCloseTo(0.35); // 200% burden = 0
    });

    it('jump height scales with Jump skill', () => {
      const lowSkill = getJumpHeight(0, 100, 1.0);
      const highSkill = getJumpHeight(0, 500, 1.0);
      expect(highSkill).toBeGreaterThan(lowSkill);
    });

    it('at Jump skill 300, full power: height = 300/(300+1300)*22.2+0.05 = 4.21', () => {
      const h = getJumpHeight(0, 300, 1.0);
      // 300/1600 * 22.2 + 0.05 = 0.1875*22.2+0.05 = 4.1625+0.05 = 4.2125
      expect(h).toBeCloseTo(4.2125, 2);
    });

    it('power 0.5 = half the height', () => {
      const full = getJumpHeight(0, 300, 1.0);
      const half = getJumpHeight(0, 300, 0.5);
      expect(half).toBeCloseTo(full * 0.5, 2);
    });

    it('burden reduces jump height', () => {
      const noLoad = getJumpHeight(0, 300, 1.0);
      const loaded = getJumpHeight(1.5, 300, 1.0); // burdenMod = 0.5
      expect(loaded).toBeCloseTo(noLoad * 0.5, 2);
    });
  });

  // ─── Jump Stamina Cost ─────────────────────────────────────

  describe('Jump Stamina Cost', () => {
    it('PvE: ceil((burden + 0.5) * power * 8 + 2)', () => {
      // burden 0, power 1.0: ceil((0+0.5)*1.0*8+2) = ceil(6) = 6
      expect(getJumpStaminaCost(1.0, 0)).toBe(6);
      // burden 0.5, power 1.0: ceil((0.5+0.5)*1.0*8+2) = ceil(10) = 10
      expect(getJumpStaminaCost(1.0, 0.5)).toBe(10);
      // burden 1.0, power 0.5: ceil((1.0+0.5)*0.5*8+2) = ceil(8) = 8
      expect(getJumpStaminaCost(0.5, 1.0)).toBe(8);
    });

    it('minimum cost is 2 (at 0 power)', () => {
      // burden 0, power 0: ceil((0+0.5)*0*8+2) = ceil(2) = 2
      expect(getJumpStaminaCost(0, 0)).toBe(2);
    });

    it('PK cost: floor((power + 1) * 100)', () => {
      expect(getJumpStaminaCost(1.0, 0, true)).toBe(200);
      expect(getJumpStaminaCost(0.5, 0, true)).toBe(150);
    });
  });

  // ─── Direction Modifiers ───────────────────────────────────

  describe('Direction Speed Modifiers', () => {
    it('backward factor = 0.65', () => {
      expect(BACKWARDS_FACTOR).toBeCloseTo(0.65);
    });

    it('sidestep factor = 0.5', () => {
      expect(SIDESTEP_FACTOR).toBeCloseTo(0.5);
    });
  });
});
