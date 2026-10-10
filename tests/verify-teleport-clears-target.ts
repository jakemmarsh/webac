/**
 * FAITHFUL.461 — onPlayerTeleport clears the previous target.
 *
 *  Pre-fix any server-driven teleport (lifestone recall, /house, /mansion,
 *  /marketplace, /pkarena, portal traversal, etc.) left the player's
 *  previous target intact — `currentTargetGuid` + `hudState.target` +
 *  `combatController.target` all stayed bound to the
 *  pre-teleport selection, which is now well outside normal engagement
 *  range. Subsequent A=attack / spell-cast attempts routed to a stale
 *  out-of-range GUID until the player manually click-empty cleared.
 *
 *  Sibling of FAITHFUL.459 (respawn) + FAITHFUL.460 (death). Same
 *  canonical clear chain (the overhead name label's step went with
 *  CORE.17.k.b.b.a.g.b — the selection lighting clears on the same paths).
 */
import { describe, it, expect } from 'vitest';
import { clearTargetOnTeleport } from '../packages/renderer/src/player/teleportTargetClear.js';

describe('FAITHFUL.461 — a teleport clears the whole target chain (player/teleportTargetClear.ts, which onPlayerTeleport calls)', () => {
  it('drops the selection, its lighting, the HUD target, the auto-attack chain and the MoveTo', () => {
    const calls: string[] = [];
    const hudState = { target: { id: 0x80001234 } as unknown };
    clearTargetOnTeleport({
      clearCurrentTarget: () => calls.push('target'),
      selectionLighting: { clear: () => calls.push('lighting') },
      hudState,
      clearAutoAttackChain: () => calls.push('autoAttack'),
      cancelMoveTo: () => calls.push('moveTo'),
    });
    expect(calls).toEqual(['target', 'lighting', 'autoAttack', 'moveTo']);
    expect(hudState.target).toBeNull();
  });

  it('works without a MoveTo controller (no player yet)', () => {
    const hudState = { target: 1 as unknown };
    expect(() => clearTargetOnTeleport({
      clearCurrentTarget: () => {}, selectionLighting: { clear: () => {} }, hudState, clearAutoAttackChain: () => {},
    })).not.toThrow();
    expect(hudState.target).toBeNull();
  });
});
