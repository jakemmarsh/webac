/**
 * RECON.transition-stepup-stepdown-port.a.a — the player's physics during
 * portal space, as the retail client runs it.
 *
 * SmartBox::UseTime @ 00455410 runs CPhysics::UseTime only while
 * CellManager::blocking_for_cells is false: while the portal-space gate
 * holds for a destination's cells nothing moves, the player included. Once
 * the arrival position is applied and the cells are resident, physics runs
 * again for the rest of the tunnel (SmartBox::Hide only gates
 * SmartBox::Draw), so a fall or a slide at the destination starts behind
 * the tunnel's TAS_TUNNEL_CONTINUE / FADE_OUT, as it did in retail.
 *
 * The tests drive the shipped smartBoxPhysicsSteps (main.ts feeds the
 * gate's isHolding into it) through the shipped fall integration.
 */
import { describe, it, expect } from 'vitest';
import { smartBoxPhysicsSteps, physicsQuantumSteps, MAX_QUANTUM } from '@ac/shared';
import { advanceAirborne } from '../packages/renderer/src/world/fallPhysics.js';

const G = -9.8;

describe('smartBoxPhysicsSteps — no CPhysics::UseTime while blocking_for_cells', () => {
  it('a held frame integrates nothing', () => {
    expect(smartBoxPhysicsSteps(1 / 60, true)).toEqual([]);
    expect(smartBoxPhysicsSteps(0.7, true)).toEqual([]);
  });

  it('an unheld frame is the ordinary update_object quantum split', () => {
    for (const dt of [1 / 60, 0.15, 0.7, 2.5, 0]) {
      expect(smartBoxPhysicsSteps(dt, false)).toEqual(physicsQuantumSteps(dt));
    }
    expect(smartBoxPhysicsSteps(0.5, false)).toEqual([MAX_QUANTUM, MAX_QUANTUM, 0.5 - 2 * MAX_QUANTUM]);
  });

  it('a body in mid-air stays put through a 3 s hold, then falls once the hold ends', () => {
    // 180 frames at 60 fps held by the gate: no fall at the spot the teleport left.
    let offsetY = 0;
    let vy = 0;
    for (let i = 0; i < 180; i++) {
      const r = advanceAirborne(100, offsetY, vy, smartBoxPhysicsSteps(1 / 60, true), 0, G);
      offsetY = r.offsetY;
      vy = r.velocityY;
    }
    expect(offsetY).toBe(0);
    expect(vy).toBe(0);
    // Released (tunnel continue / fade-out): gravity runs again.
    for (let i = 0; i < 60; i++) {
      const r = advanceAirborne(100, offsetY, vy, smartBoxPhysicsSteps(1 / 60, false), 0, G);
      offsetY = r.offsetY;
      vy = r.velocityY;
    }
    // One second of free fall: 0.5 · 9.8 · 1² = 4.9 m (integrated per frame).
    expect(offsetY).toBeCloseTo(-4.9, 0);
    expect(vy).toBeCloseTo(-9.8, 6);
  });
});
