/**
 * VirindiTank's mana donors (docs/vtank-parity-gaps.md §3.5): with a mana
 * stone named on the Consumables tab, looting keeps up to ManaStoneLootCount
 * of those stones, and while you carry an empty one it also takes a magic
 * item holding at least ManaTankMinimumMana, then empties that item into the
 * stone (an empty stone used on an item drains it and destroys the item: ACE
 * ManaStone.HandleActionUseOnTarget; the AC1999 server's CManaStoneWeenie the
 * same). Facts from MOSS (openac-mosstank Looting.ManaDonors /
 * ManaStoneTransferPlanner, read for facts only; no code copied):
 *
 * - a donor is unworn, holds mana (ItemCurMana 107 at least the minimum), has
 *   a workmanship (105) and was never tinkered (171): a tinkered item is
 *   someone's work. In hand it must also carry no inscription (string 7) or
 *   scribe (8). Retained items are left alone (the client refuses an empty
 *   stone on one, ItemHolder::TargetAcquired, and ACE cancels it);
 * - each donor taken holds one empty stone back, so no more donors are taken
 *   than there are spare empty stones;
 * - the fullest donor goes first, into the lowest-id empty stone.
 *
 * The retail client asks "Are you sure you want to attempt to destroy your
 * <item> and drain its mana into this stone?" when you target an item with an
 * empty stone (ClientUISystem::TargetedUsageConfirmation_ManaStone @ 00566140);
 * the drain answers it Yes.
 */
import { RETAINED_FLAG } from './salvagePlan.ts';

/** ITEM_TYPE ManaStone (ACE ItemType). */
export const ITEM_TYPE_MANA_STONE = 0x00080000;
/** UiEffects Magical: a charged stone glows (ACE ManaStone.SetUiEffect). */
const UI_MAGICAL = 0x1;

export interface DonorProps { int?: Record<number, number>; string?: Record<number, string>; bool?: Record<number, boolean> }

export interface StoneItem { guid: number; name: string; itemType?: number; uiEffects?: number; equipped?: boolean }

/** A mana stone the Consumables tab names (ITEM_TYPE ManaStone, by name). */
export function isProfiledStone(item: StoneItem, consumables: readonly string[]): boolean {
  if (item.itemType !== undefined && item.itemType !== 0 && !(item.itemType & ITEM_TYPE_MANA_STONE)) return false;
  const n = item.name.toLowerCase();
  return consumables.some((c) => c.toLowerCase() === n) && (item.itemType ? true : /mana stone/i.test(item.name));
}

/** The Consumables tab names a mana stone (else no stones or donors are looted). */
export function profileNamesStone(consumables: readonly string[]): boolean {
  return consumables.some((c) => /mana stone/i.test(c));
}

/** An empty stone: not charged (no Magical glow), not worn. */
export function isEmptyStone(item: StoneItem): boolean { return !item.equipped && !((item.uiEffects ?? 0) & UI_MAGICAL); }

/** Worth draining: holds at least `minimum` mana, has a workmanship, never tinkered, not retained, nobody wrote on it. */
export function isDonor(props: DonorProps | null | undefined, minimum: number, descFlags = 0): boolean {
  if (!props) return false;
  const cur = props.int?.[107];
  if (cur === undefined || cur < minimum) return false;
  if (!((props.int?.[105] ?? 0) > 0)) return false;
  if ((props.int?.[171] ?? 0) > 0) return false;
  if (props.bool?.[91] || (descFlags & RETAINED_FLAG)) return false;
  return !props.string?.[7] && !props.string?.[8];
}

/** Empty profiled stones you carry not already held back for a donor waiting to be drained. */
export function spareStones(carried: readonly StoneItem[], consumables: readonly string[], donorsWaiting: number): number {
  const empty = carried.filter((i) => isProfiledStone(i, consumables) && isEmptyStone(i)).length;
  return Math.max(0, empty - donorsWaiting);
}

/**
 * What looting does with an item no rule took, for mana: 'stone' (a profiled stone while you carry fewer than
 * ManaStoneLootCount), 'donor' (a magic item worth draining while a spare empty stone waits), or null.
 * `takenStones` / `takenDonors`: what this corpse pass already took.
 */
export function manaLootAction(
  item: StoneItem & { descFlags?: number },
  props: DonorProps | null | undefined,
  ctx: { carried: readonly StoneItem[]; consumables: readonly string[]; stoneCount: number; minimum: number; donorsWaiting: number; takenStones?: number },
): 'stone' | 'donor' | null {
  if (!profileNamesStone(ctx.consumables)) return null;
  const want = Math.min(100, Math.max(0, ctx.stoneCount));
  const stones = ctx.carried.filter((i) => isProfiledStone(i, ctx.consumables)).length + (ctx.takenStones ?? 0);
  if (isProfiledStone(item, ctx.consumables)) return stones < want ? 'stone' : null;
  if (spareStones(ctx.carried, ctx.consumables, ctx.donorsWaiting) > 0 && isDonor(props, ctx.minimum, item.descFlags)) return 'donor';
  return null;
}

/** Whether an item from a corpse needs examining for the mana check: it glows magical and a spare stone waits. */
export function donorNeedsLook(item: { uiEffects?: number }, ctx: { carried: readonly StoneItem[]; consumables: readonly string[]; donorsWaiting: number }): boolean {
  return profileNamesStone(ctx.consumables) && !!((item.uiEffects ?? 0) & UI_MAGICAL) && spareStones(ctx.carried, ctx.consumables, ctx.donorsWaiting) > 0;
}

/** The next drain: the fullest donor into the lowest-id empty stone; null when there is none to do. */
export function planDrain(
  carried: ReadonlyArray<StoneItem & { descFlags?: number }>,
  donors: ReadonlySet<number>,
  consumables: readonly string[],
  minimum: number,
  props: (guid: number) => DonorProps | null | undefined,
): { stone: StoneItem; donor: StoneItem } | null {
  const stone = carried.filter((i) => isProfiledStone(i, consumables) && isEmptyStone(i)).sort((a, b) => a.guid - b.guid)[0];
  if (!stone) return null;
  const donor = carried
    .filter((i) => donors.has(i.guid) && !i.equipped && isDonor(props(i.guid), minimum, i.descFlags))
    .sort((a, b) => (props(b.guid)?.int?.[107] ?? 0) - (props(a.guid)?.int?.[107] ?? 0) || a.guid - b.guid)[0];
  return donor ? { stone, donor } : null;
}

/** The client's confirmation for an empty stone on an item (TargetedUsageConfirmation_ManaStone). */
export const DRAIN_CONFIRM = /attempt to destroy your .* and drain its mana into this stone\?/i;
