/**
 * AGENT.vtank-window — VirindiTank's Enable Autostack and Enable Autocram
 * (docs/vtank-macro-behavior.md §1): the next pack tidy-up, one at a time.
 *
 * - Autostack: partial stacks of one kind (the same weenie class) merge, the
 *   smaller onto the larger, so one partial stack is left (VTank stacks
 *   toward one item; which pack it ends in is INF).
 * - Autocram: items in the main pack move to a side pack with room. Packs
 *   and foci-like containers stay; what you wear or wield isn't in a pack.
 */

export interface InvItem { guid: number; name: string; packSlot: number; stack: number; maxStack: number; wcid: number; isPack: boolean; equipped: boolean }
export interface InvPack { slot: number; guid: number; capacity: number; count: number }
export type InvAction = { kind: 'merge'; from: number; onto: number; why: string } | { kind: 'move'; guid: number; packSlot: number; why: string };

export function planInventory(input: { items: InvItem[]; packs: InvPack[]; autostack: boolean; autocram: boolean }): InvAction | null {
  const loose = input.items.filter((i) => !i.equipped && !i.isPack);
  if (input.autostack) {
    const groups = new Map<number, InvItem[]>();
    for (const i of loose) {
      if (i.maxStack <= 1 || i.stack >= i.maxStack || !i.wcid) continue;
      const g = groups.get(i.wcid) ?? [];
      g.push(i);
      groups.set(i.wcid, g);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => b.stack - a.stack || a.guid - b.guid);
      const onto = g[0];
      const from = g[g.length - 1];
      return { kind: 'merge', from: from.guid, onto: onto.guid, why: `stack ${from.name} (${from.stack}) onto ${onto.stack}` };
    }
  }
  if (input.autocram) {
    const side = input.packs.filter((p) => p.slot > 0 && p.count < p.capacity).sort((a, b) => a.slot - b.slot)[0];
    const item = loose.find((i) => i.packSlot === 0);
    if (side && item) return { kind: 'move', guid: item.guid, packSlot: side.slot, why: `cram ${item.name} into side pack ${side.slot}` };
  }
  return null;
}
