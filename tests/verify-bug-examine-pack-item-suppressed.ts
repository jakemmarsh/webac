/**
 * BUG.examine-pack-item-suppressed — examining a pack or worn item (the
 * toolbar magnifier, E, a right-click) never reached the server: the
 * client's stale-target gate only knew 3D objects. It now resolves the way
 * ACE's FindObject does — self, packs, worn items, the open container,
 * the landblock (Player_Use.cs:210; Player.cs:265 IdentifyObject searches
 * Everywhere).
 */
import { describe, it, expect } from 'vitest';
import { targetResolves, canUseTarget, type TargetLocations } from '@ac/shared';

const where = (sets: Partial<Record<keyof TargetLocations, number[]>>): TargetLocations => ({
  inPack: (g) => (sets.inPack ?? []).includes(g),
  worn: (g) => (sets.worn ?? []).includes(g),
  inOpenContainer: (g) => (sets.inOpenContainer ?? []).includes(g),
  inWorld: (g) => (sets.inWorld ?? []).includes(g),
});

describe('targetResolves', () => {
  it('a pack item, a worn item and an open-container item resolve (they are not 3D objects)', () => {
    const w = where({ inPack: [0x800009e4], worn: [0x80000f4f], inOpenContainer: [0x80000500] });
    for (const g of [0x800009e4, 0x80000f4f, 0x80000500]) expect(canUseTarget(targetResolves(g, 0x50000003, w))).toBe(true);
  });
  it('ourselves and world objects resolve; a vanished guid does not', () => {
    const w = where({ inWorld: [0x80000100] });
    expect(targetResolves(0x50000003, 0x50000003, w)).toBe(true);
    expect(targetResolves(0x80000100, 0x50000003, w)).toBe(true);
    expect(targetResolves(0x80000999, 0x50000003, w)).toBe(false);
    expect(targetResolves(0x50000003, null, w)).toBe(false);
  });
});
