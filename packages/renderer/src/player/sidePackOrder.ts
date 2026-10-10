/**
 * BUG.side-pack-order-follows-arrival — the side-pack column's order. ACE
 * ships the player's directly contained objects as an ordered placement list
 * in PlayerDescription (GameEventPlayerDescription.cs:401-416, the
 * containers flagged by ContainerType), and retail's inventory UI lists the
 * packs in that order (the player's CObjectInventory::_containersList). Ours
 * appended packs in ObjectCreate arrival order, so the backpack and a sack
 * could swap places between two logins.
 *
 * `guids[0]` is the main pack (the player) and stays first; side packs in
 * `placement` follow in its order; packs it doesn't list (picked up after
 * login) keep their arrival order at the end.
 */
export function orderSidePacks(guids: readonly number[], placement: readonly number[]): number[] {
  if (guids.length <= 2 || placement.length === 0) return [...guids];
  const rank = new Map<number, number>();
  placement.forEach((g, i) => { if (!rank.has(g >>> 0)) rank.set(g >>> 0, i); });
  const [main, ...packs] = guids;
  const known = packs.filter((g) => rank.has(g >>> 0)).sort((a, b) => rank.get(a >>> 0)! - rank.get(b >>> 0)!);
  const unknown = packs.filter((g) => !rank.has(g >>> 0));
  return [main, ...known, ...unknown];
}
