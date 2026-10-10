/**
 * BUG.melee-approach-range-hardcoded-ignores-radius — melee range must be
 * gated on ACE's cylinder distance (center-to-center distance minus both
 * entities' collision radii), not a flat center-to-center distance compared
 * against an invented 3.0m constant.
 *
 * BUG.melee-cylinder-distance-ignores-height — that cylinder distance must
 * also be height-aware, matching ACE's real CylinderDistance (NOT the
 * StickyManager-only CylinderDistanceNoZ, which our doc comments previously
 * mis-cited).
 *
 * ACE.Server/WorldObjects/Player_Melee.cs:166-174
 * HandleActionTargetedMeleeAttack_Inner: `dist <= MeleeDistance ||
 * (dist <= StickyDistance && IsMeleeVisible(target))`, where `dist` comes
 * from GetCylinderDistance (WorldObject_Use.cs:57-61) →
 * Physics.Common.Position.CylinderDistance (Position.cs:100-114):
 *
 *   offset = otherPos - pos
 *   reach  = offset.Length() - (radius + otherRadius)
 *   diffZ  = pos.Z <= otherPos.Z
 *              ? otherPos.Z - (pos.Z + height)
 *              : pos.Z - (otherPos.Z + otherHeight)
 *   if diffZ > 0 && reach > 0:  sqrt(diffZ² + reach²)
 *   if diffZ < 0 && reach < 0: -sqrt(diffZ² + reach²)
 *   else:                       reach
 *
 * Player_Melee.cs:166-168 MeleeDistance=0.6f, StickyDistance=4.0f.
 */
import { describe, it, expect } from 'vitest';
import {
  getMeleeCylinderDistance,
  MELEE_DISTANCE,
  MELEE_STICKY_DISTANCE,
} from '../packages/renderer/src/controllers/CombatController.js';

const PLAYER_RADIUS = 0.6788225173950195;
const PLAYER_HEIGHT = 1.8350000381469727;

describe('getMeleeCylinderDistance (BUG.melee-approach-range-hardcoded-ignores-radius, BUG.melee-cylinder-distance-ignores-height)', () => {
  it('same-height entities (dy=0) reduce to the flat reach term: offset.Length() - (attackerRadius + targetRadius)', () => {
    // dy=0 means diffZ = 0 - attackerHeight < 0 (below the true target-top
    // comparison in most cases), reach term dominates via the "else" branch
    // whenever diffZ/reach signs don't both agree — verified directly below
    // against a hand-computed diffZ for these exact inputs.
    const dist = getMeleeCylinderDistance(10, 0, 0, PLAYER_RADIUS, PLAYER_HEIGHT, 0.3, 1.0);
    // diffZ = 0 - PLAYER_HEIGHT = -1.835 (attacker <= target since dy>=0 branch),
    // reach = 10 - (0.6788225173950195 + 0.3) = 9.021177482604980; opposite
    // signs (diffZ<0, reach>0) -> falls to the "else" branch, returns reach.
    const reach = 10 - (PLAYER_RADIUS + 0.3);
    expect(dist).toBeCloseTo(reach, 10);
  });

  it('a large target (big collision radius) is in melee range at a much greater center distance than a small one', () => {
    const smallTargetRadius = 0.3;
    const largeTargetRadius = 3.0; // e.g. an olthoi or other big creature
    // Center distance (horizontal, dy=0) at which a small-radius target's
    // cylinder distance exactly reaches the sticky threshold:
    const centerDistSmall = MELEE_STICKY_DISTANCE + PLAYER_RADIUS + smallTargetRadius;
    // The same center distance against a large-radius target is already
    // well inside sticky range — flat center-distance gating would instead
    // report it as still too far away.
    const cylDistAtSameCenterDist = getMeleeCylinderDistance(centerDistSmall, 0, 0, PLAYER_RADIUS, PLAYER_HEIGHT, largeTargetRadius, 3.0);
    expect(cylDistAtSameCenterDist).toBeLessThan(
      getMeleeCylinderDistance(centerDistSmall, 0, 0, PLAYER_RADIUS, PLAYER_HEIGHT, smallTargetRadius, 1.0),
    );
    expect(cylDistAtSameCenterDist).toBeLessThan(MELEE_STICKY_DISTANCE);
  });

  it('MELEE_STICKY_DISTANCE matches ACE StickyDistance (4.0) and MELEE_DISTANCE matches MeleeDistance (0.6)', () => {
    expect(MELEE_STICKY_DISTANCE).toBe(4.0);
    expect(MELEE_DISTANCE).toBe(0.6);
  });

  it('MeleeDistance range is a subset of StickyDistance range (collapsing the OR to a single sticky check is valid)', () => {
    expect(MELEE_DISTANCE).toBeLessThan(MELEE_STICKY_DISTANCE);
  });

  it('two large creatures standing apart at a distance greater than their combined radii sum to a positive cylinder distance', () => {
    expect(getMeleeCylinderDistance(20, 0, 0, 1, 1.8, 1, 1.8)).toBeCloseTo(18, 10);
  });

  it('overlapping cylinders (radii sum exceeds center distance) produce a negative cylinder distance, still <= StickyDistance', () => {
    const dist = getMeleeCylinderDistance(1, 0, 0, 1, 1.8, 1, 1.8);
    expect(dist).toBeLessThan(0);
    expect(dist).toBeLessThanOrEqual(MELEE_STICKY_DISTANCE);
  });

  // ── BUG.melee-cylinder-distance-ignores-height ──────────────────────

  it('a target directly overhead, within the attacker’s own collision height, has mismatched diffZ/reach signs and falls to the plain reach branch', () => {
    // Horizontally coincident (dx=dz=0), 1.0m above: offset.Length() (ACE's
    // real full-3D `reach` term, not a horizontal-only approximation) picks
    // up the full 1.0m -> reach = 1.0 - radiiSum (barely positive), while
    // diffZ = dy - attackerHeight is negative (1.0m is still under the
    // attacker's own 1.835m collision cylinder) -> signs disagree, so
    // neither combining branch applies and the plain `reach` is returned.
    const dy = 1.0;
    const dist = getMeleeCylinderDistance(0, dy, 0, PLAYER_RADIUS, PLAYER_HEIGHT, 0.3, 1.0);
    const offsetLength = dy;
    const reach = offsetLength - (PLAYER_RADIUS + 0.3);
    const diffZ = dy - PLAYER_HEIGHT;
    expect(diffZ).toBeLessThan(0);
    expect(reach).toBeGreaterThan(0);
    expect(dist).toBeCloseTo(reach, 10);
  });

  it('a target just above melee reach in both horizontal and vertical directions combines via Pythagorean sqrt(diffZ²+reach²), exceeding either term alone', () => {
    // Horizontal center distance already at the sticky edge, PLUS enough
    // extra height that both diffZ and reach end up positive -> ACE combines
    // them via sqrt rather than just using the (smaller) horizontal reach.
    const dx = MELEE_STICKY_DISTANCE + PLAYER_RADIUS + 0.3 + 0.5; // reach ~= 0.5 horizontally-ish once combined with dy below
    const dy = PLAYER_HEIGHT + 2.0; // well above the attacker's own collision height
    const dist = getMeleeCylinderDistance(dx, dy, 0, PLAYER_RADIUS, PLAYER_HEIGHT, 0.3, 1.0);
    const offsetLength = Math.sqrt(dx * dx + dy * dy);
    const reach = offsetLength - (PLAYER_RADIUS + 0.3);
    const diffZ = dy - PLAYER_HEIGHT; // dy>=0 branch: attacker <= target
    expect(reach).toBeGreaterThan(0);
    expect(diffZ).toBeGreaterThan(0);
    expect(dist).toBeCloseTo(Math.sqrt(diffZ * diffZ + reach * reach), 10);
    // The combined distance must exceed the flat horizontal-only distance a
    // pre-fix (height-ignoring) implementation would have reported.
    expect(dist).toBeGreaterThan(dx - (PLAYER_RADIUS + 0.3));
  });

  it('when the attacker is ABOVE the target, diffZ uses the target’s own height (not the attacker’s) per ACE’s else-branch', () => {
    // dy<0 -> attacker above target: diffZ = pos.Z - (otherPos.Z + otherHeight)
    // = -dy - targetHeight (with dy = target - attacker).
    const dy = -5;
    const targetHeight = 1.0;
    const dist = getMeleeCylinderDistance(0, dy, 0, PLAYER_RADIUS, PLAYER_HEIGHT, 0.3, targetHeight);
    const offsetLength = 5;
    const reach = offsetLength - (PLAYER_RADIUS + 0.3);
    const diffZ = -dy - targetHeight; // 5 - 1.0 = 4.0
    expect(diffZ).toBeCloseTo(4.0, 10);
    // reach = 5 - 0.9788... = 4.0212 (>0), diffZ = 4.0 (>0) -> sqrt branch
    expect(dist).toBeCloseTo(Math.sqrt(diffZ * diffZ + reach * reach), 10);
  });

  it('both diffZ and reach negative (overlapping cylinders, close in height) returns the NEGATIVE sqrt branch', () => {
    // Small horizontal distance that overlaps radii (reach<0) and a small
    // enough height gap that diffZ also lands negative.
    const dx = 0.5; // < radii sum (0.9788) -> reach<0
    const dy = 0.2; // well within attackerHeight -> diffZ<0
    const dist = getMeleeCylinderDistance(dx, dy, 0, PLAYER_RADIUS, PLAYER_HEIGHT, 0.3, 1.0);
    const offsetLength = Math.sqrt(dx * dx + dy * dy);
    const reach = offsetLength - (PLAYER_RADIUS + 0.3);
    const diffZ = dy - PLAYER_HEIGHT;
    expect(reach).toBeLessThan(0);
    expect(diffZ).toBeLessThan(0);
    expect(dist).toBeCloseTo(-Math.sqrt(diffZ * diffZ + reach * reach), 10);
    expect(dist).toBeLessThan(0);
  });
});
