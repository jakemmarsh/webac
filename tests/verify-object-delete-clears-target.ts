/**
 * FAITHFUL.462 — onObjectDelete clears the current target when the
 *  deleted object IS the current selection.
 *
 *  Pre-fix when a creature died (or NPC despawned, or item picked up
 *  by another player), the server sent ObjectDelete and our handler
 *  freed the serverObject, but if the
 *  deleted object was `currentTargetGuid` — the entire selection
 *  state stayed bound to the now-dead-and-deleted GUID. Subsequent
 *  A=attack / spell-cast attempts routed nowhere; the HUD target
 *  panel kept showing the stale name + 0% HP bar.
 *
 *  A partial fix existed for the in-combat auto-chain path via
 *  `meleeApproachTarget`. This generalizes to all cases (out of
 *  combat, examining a passing merchant who despawns, watching a
 *  creature corpse rot, etc.) and works alongside the existing
 *  AutoTarget re-selection: if AutoTarget picks a new nearest
 *  hostile, selectTarget re-binds currentTargetGuid so the
 *  trailing equality check is false and we don't double-clear.
 *
 *  Sibling of FAITHFUL.459 (respawn) + FAITHFUL.460 (death) +
 *  FAITHFUL.461 (teleport). Same canonical clear chain (the overhead name
 *  label's step went with CORE.17.k.b.b.a.g.b).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.462 — onObjectDelete clears current target', () => {
  const fn = MAIN.match(/onObjectDelete: \(data\) => \{[\s\S]+?\n      \},/)?.[0] ?? '';

  it('extracted', () => {
    expect(fn).not.toBe('');
  });

  it('compares currentTargetGuid === data.guid', () => {
    expect(fn).toMatch(/currentTargetGuid === data\.guid/);
  });

  it('clears currentTargetGuid in the conditional block', () => {
    expect(fn).toMatch(/currentTargetGuid === data\.guid[\s\S]+?currentTargetGuid = null/);
  });

  it('clears HUD target panel in the conditional block', () => {
    expect(fn).toMatch(/currentTargetGuid === data\.guid[\s\S]+?gameUI\.hudState\.target = null/);
  });

  it('cites FAITHFUL.462', () => {
    expect(MAIN).toMatch(/FAITHFUL\.462/);
  });
});
