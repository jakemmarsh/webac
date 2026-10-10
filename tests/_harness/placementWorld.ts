/**
 * A small in-memory PlacementWorld for the ItemHolderPlacement tests: the
 * player (main pack), side packs and items with explicit containers, plus
 * the toolbar split state.
 */
import type { PlacementObject, PlacementWorld } from '../../packages/renderer/src/inventory/ItemHolderPlacement.js';

export const PLAYER = 0x50000001;

export interface FixtureObject extends Partial<PlacementObject> {
  id: number;
  /** The holder it sits in (0 = the world / not contained). */
  in?: number;
}

export function makeWorld(objects: FixtureObject[], opts: {
  splitSize?: number; maxSplitSize?: number; selectedId?: number; playerItems?: number; playerContainers?: number;
} = {}): PlacementWorld {
  const all = new Map<number, FixtureObject>();
  all.set(PLAYER, {
    id: PLAYER, name: 'Tester', isPlayer: true, holder: true, isContainer: true,
    itemsCapacity: opts.playerItems ?? 102, containersCapacity: opts.playerContainers ?? 7,
  });
  for (const o of objects) all.set(o.id, o);
  const full = (o: FixtureObject): PlacementObject => ({
    name: `obj${o.id.toString(16)}`, weenieClassId: 0, stackSize: 1, maxStackSize: 1,
    itemsCapacity: 0, containersCapacity: 0, isContainer: false, holder: false, inTrade: false, isPlayer: false,
    ...o,
  });
  const inside = (h: number) => [...all.values()].filter((o) => o.in === h && o.id !== h);
  const splitSize = opts.splitSize ?? 1;
  const maxSplitSize = opts.maxSplitSize ?? 1;
  const selected = opts.selectedId ?? 0;
  const objectSplitSize = (id: number): number => {
    const o = all.get(id);
    if (id === selected) return splitSize;
    return Math.max(1, o?.stackSize ?? 1);
  };
  return {
    playerId: PLAYER,
    object: (id) => { const o = all.get(id); return o ? full(o) : undefined; },
    itemsOf: (h) => inside(h).filter((o) => !full(o).isContainer).map((o) => o.id),
    containersOf: (h) => inside(h).filter((o) => full(o).isContainer).map((o) => o.id),
    splitSize, maxSplitSize,
    objectSplitSize,
    dragSplit: (id) => {
      const amount = objectSplitSize(id);
      return { amount, partial: id === selected && splitSize < maxSplitSize };
    },
  };
}

/** A side pack in the player's main pack. */
export function pack(id: number, itemsCapacity: number, name = 'Pack'): FixtureObject {
  return { id, in: PLAYER, name, holder: true, isContainer: true, itemsCapacity };
}

/** `n` plain items filling `holder`. */
export function filler(holder: number, n: number, firstId: number): FixtureObject[] {
  return Array.from({ length: n }, (_, i) => ({ id: firstId + i, in: holder }));
}
