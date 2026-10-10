/**
 * GAP.7 — client-side falling decisions (world/fallPhysics.ts).
 *
 * ACE computes falling damage server-side (Player_Move.cs:247
 * HandleFallingDamage) from its own physics, which only integrates a fall
 * while the client reports NOT-in-contact. These tests cover the two
 * client decisions that make honest reporting possible:
 *   - losesContact: walking onto ground more than StepDownHeight below the
 *     feet transitions to falling instead of snapping down (ACE
 *     Transition.cs:462 StepDown probe depth).
 *   - hasLanded: an airborne player lands when the ABSOLUTE feet height
 *     reaches the ground under the current position — a jump off a cliff
 *     keeps falling to the lower terrain.
 * Plus a DAT-anchored pin: PLAYER_STEP_DOWN_HEIGHT must equal the human
 * player SetupModel (0x02000001) StepDownHeight from portal.dat, not an
 * invented threshold.
 *
 * BUG.fall-detection-step-down-height-hardcoded-human — resolvePlayerStepDownHeight
 * computes the real per-character threshold (Setup.StepDownHeight * Scale.Z,
 * ACE PartArray.cs:240) instead of always using the human-only constant, so
 * non-Human heritages (Olthoi/OlthoiAcid, etc.) lose ground contact at their
 * own real step-down depth, not the Human's.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  losesContact,
  hasLanded,
  advanceAirborne,
  PLAYER_STEP_DOWN_HEIGHT,
  resolvePlayerStepDownHeight,
} from '../packages/renderer/src/world/fallPhysics.js';
import { physicsQuantumSteps } from '../packages/shared/src/physics/PhysicsQuantum.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');

describe('GAP.7 — losesContact (walk-off detection)', () => {
  it('falls when the ground drops more than StepDownHeight in one step', () => {
    expect(losesContact(44, 16)).toBe(true);                              // 28m cliff
    expect(losesContact(10, 10 - PLAYER_STEP_DOWN_HEIGHT - 0.01)).toBe(true);
  });

  it('keeps contact within the StepDownHeight probe (stairs, slopes)', () => {
    expect(losesContact(10, 10)).toBe(false);            // flat
    expect(losesContact(10, 9.5)).toBe(false);           // half-meter step down
    expect(losesContact(10, 10 - PLAYER_STEP_DOWN_HEIGHT)).toBe(false); // exactly at probe depth
    expect(losesContact(10, 12)).toBe(false);            // ascending never falls
  });

  it('never falls without a basis: null prev feet (post-teleport) or unloaded ground', () => {
    expect(losesContact(null, 0)).toBe(false);
    expect(losesContact(44, null)).toBe(false);
    expect(losesContact(null, null)).toBe(false);
  });

  it('honors a custom step-down height (scaled setups)', () => {
    expect(losesContact(10, 8, 3.0)).toBe(false);
    expect(losesContact(10, 6.9, 3.0)).toBe(true);
  });
});

describe('GAP.7 — hasLanded (absolute-height landing)', () => {
  it('flat ground reduces to the classic offset <= 0', () => {
    expect(hasLanded(44, 0.5, 44)).toBe(false);  // still 0.5m up
    expect(hasLanded(44, 0, 44)).toBe(true);     // back at launch height
    expect(hasLanded(44, -0.01, 44)).toBe(true);
  });

  it('a jump off a cliff does NOT land at relative-zero — falls to the lower terrain', () => {
    // Launched at 44, terrain under the arc is now 16 (28m cliff):
    expect(hasLanded(44, 0, 16)).toBe(false);    // relative-zero mid-air — the old bug landed here
    expect(hasLanded(44, -27.9, 16)).toBe(false);
    expect(hasLanded(44, -28, 16)).toBe(true);   // feet reached the lower ground
  });

  it('rising terrain under the arc lands early (jump into a slope)', () => {
    expect(hasLanded(44, 1.5, 46)).toBe(true);   // 45.5 <= 46 — hit the slope on the way up
  });
});

describe('BUG.flow-movement-outdoor-jump-height — advanceAirborne steps per physics chunk', () => {
  // A 0.35 m jump (GetJumpHeight's floor): v0 = sqrt(0.35 * 19.6), apex at v0/9.8 s.
  const v0 = Math.sqrt(0.35 * 19.6);
  const G = -9.8;

  it('a long frame (0.79 s, chunked like update_object) still reaches the apex before landing', () => {
    const steps = physicsQuantumSteps(0.79);
    expect(steps.length).toBe(4);
    const r = advanceAirborne(94, 0, v0, steps, 94, G);
    expect(r.landed).toBe(true);
    // Retail MAX_QUANTUM 0.2 s: chunk boundaries at 0.2 / 0.4 s straddle the 0.267 s apex (0.328 m).
    expect(r.peakY).toBeGreaterThan(0.32);
    expect(r.peakY).toBeLessThanOrEqual(0.35 + 1e-9);
    // Landing stops the clock at the chunk the feet reach the ground (flight time 2·v0/g ≈ 0.53 s).
    expect(r.airtime).toBeCloseTo(0.6, 9);
    expect(r.offsetY).toBe(0);
    expect(r.velocityY).toBe(0);
  });

  it('the pre-fix single whole-frame step would have skipped the arc (regression shape)', () => {
    const r = advanceAirborne(94, 0, v0, [0.79], 94, G);
    expect(r.landed).toBe(true);
    expect(r.peakY).toBe(0);
  });

  it('short frames keep flying and carry offset + velocity to the next frame', () => {
    const r = advanceAirborne(94, 0, v0, [1 / 60], 94, G);
    expect(r.landed).toBe(false);
    expect(r.offsetY).toBeCloseTo(v0 / 60 + G * 0.5 / 3600, 12);
    expect(r.velocityY).toBeCloseTo(v0 + G / 60, 12);
    expect(r.peakY).toBe(r.offsetY);
  });

  it('a 60 fps arc peaks at the launch height and lands after 2·v0/g', () => {
    let y = 0; let vy = v0; let peak = 0; let t = 0; let landed = false;
    for (let i = 0; i < 200 && !landed; i++) {
      const r = advanceAirborne(10, y, vy, [1 / 60], 10, G);
      y = r.offsetY; vy = r.velocityY; peak = Math.max(peak, r.peakY); t += r.airtime; landed = r.landed;
    }
    expect(landed).toBe(true);
    expect(peak).toBeCloseTo(0.35, 3);
    expect(t).toBeGreaterThanOrEqual(2 * v0 / 9.8 - 1e-9);
    expect(t).toBeLessThan(2 * v0 / 9.8 + 1 / 60);
  });

  it('off a ledge the fall continues past the launch base down to the lower ground', () => {
    const r = advanceAirborne(20, 0, 0, physicsQuantumSteps(0.5), 18, G);
    expect(r.landed).toBe(false);
    expect(r.offsetY).toBeCloseTo(-1.225, 9);
    const r2 = advanceAirborne(20, r.offsetY, r.velocityY, physicsQuantumSteps(0.5), 18, G);
    expect(r2.landed).toBe(true);
  });
});

describe('BUG.fall-detection-step-down-height-hardcoded-human — resolvePlayerStepDownHeight', () => {
  it('scales the real per-setup StepDownHeight by Scale.Z', () => {
    expect(resolvePlayerStepDownHeight({ stepDownHeight: 0.942 }, 1)).toBeCloseTo(0.942, 6);
    expect(resolvePlayerStepDownHeight({ stepDownHeight: 2.0 }, 1)).toBeCloseTo(2.0, 6);
    expect(resolvePlayerStepDownHeight({ stepDownHeight: 1.5 }, 2)).toBeCloseTo(3.0, 6);
  });

  it('falls back to the human default when no setup has resolved yet', () => {
    expect(resolvePlayerStepDownHeight(null, 1)).toBe(PLAYER_STEP_DOWN_HEIGHT);
    expect(resolvePlayerStepDownHeight(undefined, 1)).toBe(PLAYER_STEP_DOWN_HEIGHT);
  });

  it('an Olthoi threshold (smaller than human) makes losesContact trigger on a drop the human threshold would forgive', () => {
    const olthoiStepDown = resolvePlayerStepDownHeight({ stepDownHeight: 0.942 }, 1);
    const drop = 1.2; // between Olthoi's real 0.942 and the human 1.5 default
    expect(losesContact(10, 10 - drop, olthoiStepDown)).toBe(true);
    expect(losesContact(10, 10 - drop, PLAYER_STEP_DOWN_HEIGHT)).toBe(false);
  });

  it('an OlthoiAcid threshold (larger than human) keeps contact on a drop the human threshold would fall on', () => {
    const olthoiAcidStepDown = resolvePlayerStepDownHeight({ stepDownHeight: 2.0 }, 1);
    const drop = 1.6; // between the human 1.5 default and OlthoiAcid's real 2.0
    expect(losesContact(10, 10 - drop, olthoiAcidStepDown)).toBe(false);
    expect(losesContact(10, 10 - drop, PLAYER_STEP_DOWN_HEIGHT)).toBe(true);
  });
});

describe.skipIf(!existsSync(PORTAL))('GAP.7 — StepDownHeight is DAT ground truth', () => {
  it('PLAYER_STEP_DOWN_HEIGHT equals human player Setup 0x02000001 StepDownHeight', async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase');
    const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel');
    const db = openDat(PORTAL);
    const reader = db.getReader(0x02000001);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setup: any = new (SetupModel as any)(reader);
    expect(setup.stepDownHeight).toBeCloseTo(PLAYER_STEP_DOWN_HEIGHT, 6);
    // Discriminating check — the sibling field must NOT match, proving we
    // read the right offset (stepUp is 0.6, not 1.5).
    expect(setup.stepUpHeight).not.toBeCloseTo(PLAYER_STEP_DOWN_HEIGHT, 2);
  });

  it('Olthoi (0x02001a21) and OlthoiAcid (0x02001a20) StepDownHeight genuinely differ from the human default', async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase');
    const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel');
    const db = openDat(PORTAL);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const olthoi: any = new (SetupModel as any)(db.getReader(0x02001a21));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const olthoiAcid: any = new (SetupModel as any)(db.getReader(0x02001a20));
    expect(olthoi.stepDownHeight).toBeCloseTo(0.942, 3);
    expect(olthoiAcid.stepDownHeight).toBeCloseTo(2.0, 3);
    expect(olthoi.stepDownHeight).not.toBeCloseTo(PLAYER_STEP_DOWN_HEIGHT, 2);
    expect(olthoiAcid.stepDownHeight).not.toBeCloseTo(PLAYER_STEP_DOWN_HEIGHT, 2);
  });
});
