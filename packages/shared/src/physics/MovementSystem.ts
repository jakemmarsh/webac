/**
 * MovementSystem — the ACE movement constants and formulas the client's
 * own motion (CameraController, jump, melee approach) runs on: run rate,
 * jump height/stamina, airborne integration, burden.
 *
 * Reference: ACE.Server/Physics/Animation/MovementSystem.cs
 * Reference: ACE.Server/Physics/Common/EncumbranceSystem.cs
 * Reference: ACE.Server/Physics/Animation/MotionInterp.cs
 */

// ── ACE Movement Constants (MotionInterp.cs) ──────────────────────

/** Backward movement = 65% of forward speed */
export const BACKWARDS_FACTOR = 0.65;

/** Sidestep = 50% of forward speed */
export const SIDESTEP_FACTOR = 0.5;

/** Max sidestep animation rate */
export const MAX_SIDESTEP_ANIM_RATE = 3.0;

/** Run animation speed */
export const RUN_ANIM_SPEED = 4.0;

/** Walk animation speed */
export const WALK_ANIM_SPEED = 3.12;

/** Sidestep animation speed */
export const SIDESTEP_ANIM_SPEED = 1.25;

/** Run turn factor */
export const RUN_TURN_FACTOR = 1.5;

// ── ACE Run Speed Formula (MovementSystem.cs lines 20-28) ─────────

/**
 * Calculate run rate from Run skill and burden.
 *
 * ACE formula: ((burdenMod * (runSkill / (runSkill + 200) * 11) + 4) / scaling) / 4.0
 * Max run speed at Run skill >= 800: 18.0 / 4.0 = 4.5
 *
 * Returns a rate multiplier (not m/s directly — applied to animation speed).
 */
export function getRunRate(burden: number, runSkill: number, scaling = 1.0): number {
  const loadMod = getBurdenMod(burden);

  if (runSkill >= 800) {
    return 18.0 / 4.0;
  }

  return ((loadMod * (runSkill / (runSkill + 200) * 11) + 4) / scaling) / 4.0;
}

/**
 * The retail CLIENT's run rate: MovementSystem::GetRunRate @ 006b0950.
 *
 * Same formula as ACE's, except the 18/4 cap applies only when the Run
 * skill is EXACTLY 800 (`fcom 800.0; fnstsw; test ah,0x44; jp` — an
 * equality test), not from 800 up as ACE's `runSkill >= 800`. Above 800 the
 * client keeps the curve: skill 15000 gives (15000/15200 · 11 + 4) / 4 =
 * 3.71, not 4.5. The retail A/B capture of an @god'd mover (Run ≈ 15000)
 * ran 14.8 m/s = 4 · 3.7 (docs/movement-ab.md, cast scenarios).
 */
export function getClientRunRate(burden: number, runSkill: number, scaling = 1.0): number {
  const loadMod = getBurdenMod(burden);
  if (runSkill === 800) return 18.0 / 4.0;
  return ((loadMod * (runSkill / (runSkill + 200) * 11) + 4) / scaling) / 4.0;
}

/**
 * Player run rate with the retail exhaustion clamp.
 *
 * BUG.exhaustion-does-not-slow-movement — the retail client's
 * CACQualities::InqRunRate (acclient @ 00592800) zeroes the effective Run
 * skill when current (enchanted) stamina is 0:
 *   if (local_10 == 0) local_20 = 0;   // stamina == 0 → runSkill = 0
 *   fVar4 = MovementSystem::GetRunRate(load, runSkill, 1.0);   // getClientRunRate
 * which collapses the rate to (loadMod·0 + 4)/4 = 1.0 — walk speed —
 * regardless of burden. (ACE's server approximates the same with
 * burden = 3.0 in Monster_Navigation.cs:358-361, which also yields
 * exactly 1.0 since getBurdenMod(3.0) = 0; the client form is
 * authoritative and is what we mirror.)
 *
 * @param burden - encumbrance / capacity ratio
 * @param runSkill - effective Run skill value
 * @param isExhausted - current stamina == 0 (Creature.cs:25 IsExhausted)
 */
export function getPlayerRunRate(burden: number, runSkill: number, isExhausted: boolean, scaling = 1.0): number {
  return getClientRunRate(burden, isExhausted ? 0 : runSkill, scaling);
}

// ── ACE Jump Height Formula (MovementSystem.cs lines 8-18) ────────

/**
 * Calculate jump height from Jump skill, burden, and jump power.
 *
 * ACE formula: burdenMod * (jumpSkill / (jumpSkill + 1300) * 22.2 + 0.05) * power / scaling
 * Minimum jump height: 0.35
 *
 * @param burden - encumbrance / capacity ratio
 * @param jumpSkill - effective Jump skill value
 * @param power - jump charge power (0.0 to 1.0)
 * @param scaling - animation scaling (default 1.0)
 */
export function getJumpHeight(burden: number, jumpSkill: number, power: number, scaling = 1.0): number {
  power = Math.max(0, Math.min(1, power));

  let result = getBurdenMod(burden) *
    (jumpSkill / (jumpSkill + 1300) * 22.2 + 0.05) *
    power / scaling;

  if (result < 0.35) result = 0.35;
  return result;
}

/**
 * Initial vertical launch velocity for a jump, in m/s.
 *
 * ACE WeenieObject.cs:95 — `velocity_z = sqrt(height * 19.6)`, where
 * `height = GetJumpHeight(burden, jumpSkill, extent, 1.0)` and 19.6 = 2·g
 * (g = 9.8). i.e. the standard v0 = sqrt(2·g·h) launch for a target apex
 * height. This is the authoritative, Jump-skill-derived velocity main.ts's jump
 * launch uses.
 *
 * @param burden   - current encumbrance
 * @param jumpSkill - effective Jump skill (0 if out of stamina)
 * @param power    - jump charge extent (0.0 to 1.0)
 * @param scaling  - animation scaling (default 1.0)
 */
export function getJumpVelocity(burden: number, jumpSkill: number, power: number, scaling = 1.0): number {
  return Math.sqrt(getJumpHeight(burden, jumpSkill, power, scaling) * 19.6);
}

/**
 * The Jump skill a launch uses: the skill, or 0 with no stamina left.
 * CACQualities::InqJumpVelocity @ 00592980 reads the current Stamina
 * (InqAttribute2nd 4) and, when it is 0, jumps with skill 0 (`if (local_1c
 * == 0) local_20 = 0`), so the jump is getJumpHeight's 0.35 m floor; the
 * AC1999 server's own InqJumpVelocity does the same (Qualities.cpp,
 * `if (!stamina) jumpskill = 0`). Retail never refuses the jump.
 */
export function jumpSkillWithStamina(jumpSkill: number, staminaCurrent: number): number {
  return staminaCurrent > 0 ? jumpSkill : 0;
}

/**
 * Advance one airborne integration step.
 *
 * ACE PhysicsObj.cs:1854-1858 (UpdatePositionInternal):
 *   position += Velocity * quantum + Acceleration * 0.5 * quantum²
 *   Velocity += Acceleration * quantum
 *
 * Exact for constant gravity at any step size, unlike semi-implicit Euler
 * (v += g·dt first, then y += v·dt), which undershoots the peak by ~v0·dt/2 —
 * a 33% height loss at 12fps (FAITHFUL.596). `gravity` is ACE
 * PhysicsGlobals.Gravity = -9.8 (the launch formula's 19.6 is 2g, not g).
 *
 * @returns the stepped height and vertical velocity
 */
export function integrateAirborneStep(
  y: number,
  velocityY: number,
  dt: number,
  gravity = -9.8,
): { y: number; velocityY: number } {
  return {
    y: y + velocityY * dt + gravity * 0.5 * dt * dt,
    velocityY: velocityY + gravity * dt,
  };
}

/**
 * Calculate stamina cost for jumping (PvE).
 *
 * ACE formula: ceil((burden + 0.5) * power * 8.0 + 2.0)
 */
export function getJumpStaminaCost(power: number, burden: number, isPK = false): number {
  if (isPK) {
    return Math.floor((power + 1.0) * 100.0);
  }
  return Math.ceil((burden + 0.5) * power * 8.0 + 2.0);
}

// ── ACE Encumbrance System (EncumbranceSystem.cs) ─────────────────

/**
 * Calculate carrying capacity from Strength and pack augmentations.
 *
 * ACE formula: 150 * strength + strength * min(bonusBurden, 150)
 * where bonusBurden = 30 * numAugs
 */
export function getEncumbranceCapacity(strength: number, numAugs = 0): number {
  if (strength <= 0) return 0;
  let bonusBurden = 30 * numAugs;
  if (bonusBurden < 0) bonusBurden = 0;
  if (bonusBurden > 150) bonusBurden = 150;
  return 150 * strength + strength * bonusBurden;
}

/**
 * Calculate burden ratio (encumbrance / capacity).
 *
 * Returns 0.0 (empty) to 3.0+ (heavily over-encumbered).
 */
export function getBurden(capacity: number, encumbrance: number): number {
  if (capacity <= 0) return 3.0;
  if (encumbrance < 0) return 0.0;
  return encumbrance / capacity;
}

/**
 * Calculate burden modifier for speed.
 *
 * ACE formula:
 *   burden < 1.0: 1.0 (no penalty)
 *   burden 1.0-2.0: 2.0 - burden (linear decline)
 *   burden >= 2.0: 0.0 (cannot move)
 */
export function getBurdenMod(burden: number): number {
  if (burden < 1.0) return 1.0;
  if (burden < 2.0) return 2.0 - burden;
  return 0.0;
}
