/**
 * The name + icon an examine (IdentifyObject response) panel is headed with.
 * Retail's gmExaminationUI takes them from the object's own weenie —
 * wherever the client holds it: a world object, an item in our packs, or
 * one we wear. Only world objects live in the ServerObjectManager, so an
 * examined pack item came up titled "Object 0x800009e4" with no icon. The
 * identify response's own PropertyString.Name (1) is the last resort before
 * the hex id. Our own character isn't in the ServerObjectManager either (the
 * player is built from its own CreateObject), and ACE's appraisal omits
 * PropertyString.Name, so examining yourself came up "Object 0x5000005c":
 * `selfName` is the player's name when the examined guid is ours. An item
 * inside an open corpse or chest is held by the container view, so callers
 * pass it as `held` too (it came up "Object 0x8000b13c" when appraised
 * before looting).
 */
export interface ExamineSource {
  name?: string;
  iconId?: number;
  itemType?: number;
  uiEffects?: number;
  iconOverlayId?: number;
  iconUnderlayId?: number;
}

export interface HeldItemSource {
  name: string;
  iconDid?: number;
  itemType?: number;
  uiEffects?: number;
  iconOverlayDid?: number;
  iconUnderlayDid?: number;
}

export interface ExamineHeader {
  name: string;
  iconId: number;
  itemType?: number;
  effects?: number;
  overlayDid?: number;
  underlayDid?: number;
}

/**
 * What else holds the examined item when it is not a world object: our packs
 * or gear (`held`), else the open container's view of it (a corpse or chest
 * item, appraised before looting), unless that view has no name yet ('???',
 * its create not arrived).
 */
export function examineHeldItem<T extends HeldItemSource>(
  guid: number, held: T | null | undefined, containerItems: Array<HeldItemSource & { guid: number }>,
): T | HeldItemSource | null {
  if (held) return held;
  return containerItems.find((i) => i.guid === guid && i.name !== '???') ?? null;
}

/** PropertyString.Name. */
const NAME_PROPERTY = 1;

export function resolveExamineHeader(
  guid: number,
  worldObj: ExamineSource | null | undefined,
  held: HeldItemSource | null | undefined,
  propertiesString: Map<number, string> | undefined,
  selfName?: string,
): ExamineHeader {
  if (worldObj?.name) {
    return {
      name: worldObj.name, iconId: worldObj.iconId ?? 0, itemType: worldObj.itemType, effects: worldObj.uiEffects,
      overlayDid: worldObj.iconOverlayId || undefined, underlayDid: worldObj.iconUnderlayId || undefined,
    };
  }
  if (held?.name) {
    return {
      name: held.name, iconId: held.iconDid ?? 0, itemType: held.itemType, effects: held.uiEffects,
      overlayDid: held.iconOverlayDid || undefined, underlayDid: held.iconUnderlayDid || undefined,
    };
  }
  const wireName = propertiesString?.get(NAME_PROPERTY);
  return { name: selfName || wireName || `Object 0x${(guid >>> 0).toString(16)}`, iconId: worldObj?.iconId ?? 0 };
}
