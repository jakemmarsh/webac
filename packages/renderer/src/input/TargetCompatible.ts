/**
 * INV-8 (every era) — ItemHolder::TargetCompatibleWithObject, the client-side gate a
 * use-with-target (a kit, a key, a lockpick, a mana stone, a healing kit) passes before
 * CM_Inventory::Event_UseWithTargetEvent goes out, and the line it prints when it does.
 *
 * End of retail @ 00587520 (target, source, quiet, announce), as ItemHolder::TargetAcquired
 * @ 00588ef0 calls it (…, 0, 1; the disassembly pushes four arguments: [esp+0xb8] gates the
 * refusals, [esp+0xbc] the "Using" line):
 *  1. the source is not the player's: its least-limited source use CONTAINED (8) → "You must own
 *     the %s to use it"; WIELDED (4) → "You must wield the %s to use it";
 *  2. the target is on the trade window → "You can't use the %s on an item you are trading";
 *  3. the target is not the player's: its least-limited TARGET use CONTAINED → "You can't use the
 *     %s on what you don't own"; WIELDED → "You can't use the %s on what you aren't wielding";
 *  4. the target is the player and the target uses lack Self (2) → "Cannot use the %s on yourself";
 *  5. the source's _targetType misses the target's ITEM_TYPE → "Cannot use the %s with the %s";
 *  6. else "Using the %s" + (" on " for a player target, else " with the ") + the target's name.
 * The 1999 ItemHolder_TargetCompatibleWithObject @ 0x004e6630 is the same without step 2, with a
 * period on the four ownership lines (EraClientRules.useWithTargetText).
 *
 * Pre-fix ours tested only step 5, so it sent requests neither client sent and never printed the
 * "Using …" line. A _targetType of 0 (ACE sends none for a null property) still passes step 5 to
 * the server, as before (isUseTargetCompatible).
 */
import { isUseTargetCompatible } from '@ac/shared';
import { USEABLE_CONTAINED, USEABLE_WIELDED, leastLimitedSourceUse } from './UseObject.js';
import type { UseWithTargetText } from '../era/EraFeatures.js';

const USEABLE_SELF = 0x2;

export interface TargetCompatSource {
  name: string;
  /** _useability (ItemUseable): source uses low, target uses high 16 bits. */
  useability: number;
  /** _targetType (ITEM_TYPE mask; 0 = none sent). */
  targetType: number;
  ownedByPlayer: boolean;
}

export interface TargetCompatTarget {
  guid: number;
  name: string;
  itemType: number;
  /** IsOwnedByPlayer (the player itself counts: IsOwnedByObject @ 0058ceb0 compares the id). */
  ownedByPlayer: boolean;
  isPlayer: boolean;
  /** tradeState == 1. */
  beingTraded?: boolean;
}

/** ItemUses::GetLeastLimitedTargetUse @ 004fcd50: the source ranking over the high 16 bits. */
export function leastLimitedTargetUse(useability: number): number {
  return leastLimitedSourceUse((useability >>> 16) & 0xffff);
}

const fmt = (t: string, ...args: string[]): string => {
  let i = 0;
  return t.replace(/%s/g, () => args[i++] ?? '');
};

/** The verdict and its line: a refusal (`ok` false) or the "Using …" announcement. */
export function targetCompatibleWithObject(
  src: TargetCompatSource, tgt: TargetCompatTarget, playerGuid: number, text: UseWithTargetText,
): { ok: boolean; line: string } {
  if (!src.ownedByPlayer) {
    const use = leastLimitedSourceUse(src.useability);
    if (use & USEABLE_CONTAINED) return { ok: false, line: fmt(text.mustOwn, src.name) };
    if (use & USEABLE_WIELDED) return { ok: false, line: fmt(text.mustWield, src.name) };
  }
  if (text.targetTrading !== null && tgt.beingTraded) return { ok: false, line: fmt(text.targetTrading, src.name) };
  if (!tgt.ownedByPlayer) {
    const use = leastLimitedTargetUse(src.useability);
    if (use & USEABLE_CONTAINED) return { ok: false, line: fmt(text.targetNotOwned, src.name) };
    if (use & USEABLE_WIELDED) return { ok: false, line: fmt(text.targetNotWielded, src.name) };
  }
  if (tgt.guid === playerGuid && (((src.useability >>> 16) & 0xffff) & USEABLE_SELF) === 0) {
    return { ok: false, line: fmt(text.onYourself, src.name) };
  }
  if (!isUseTargetCompatible(src.targetType, tgt.itemType)) {
    return { ok: false, line: fmt(text.cannotUseWith, src.name, tgt.name) };
  }
  return { ok: true, line: fmt(text.using, src.name) + (tgt.isPlayer ? text.usingOn : text.usingWith) + tgt.name };
}
