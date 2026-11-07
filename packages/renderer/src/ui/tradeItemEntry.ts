/**
 * The trade-window row main.ts builds for a GameEventAddToTrade (ACE
 * Player_Trade.cs:161-172): the object's display data looked up in the
 * player's inventory (TradeSide.Self) or the ServerObject mirror (partner).
 *
 * FAITHFUL.542 — the icon comes from InventoryItem.iconDid or
 * ServerObject.iconId (same value, named differently); 0 when unknown.
 * CORE.18.c.a — the cell is a UIItem, so it also carries what
 * IconData::RenderIcons @ 0058d180 reads: ITEM_TYPE, UiEffects and the
 * custom overlay / underlay (InventoryItem *Did / ServerObject *Id).
 */
export interface TradeItemSource {
  name?: string;
  value?: number;
  burden?: number;
  iconDid?: number;
  iconId?: number;
  itemType?: number;
  uiEffects?: number;
  iconOverlayDid?: number;
  iconUnderlayDid?: number;
  iconOverlayId?: number;
  iconUnderlayId?: number;
  /** webac#25 — the cell's UIItem StructureBar inputs (same name on InventoryItem and ServerObject). */
  structure?: number;
  maxStructure?: number;
}

export interface TradeItemRow {
  name: string;
  value: number;
  guid: number;
  burden: number;
  iconDid: number;
  itemType?: number;
  uiEffects?: number;
  iconOverlayDid?: number;
  iconUnderlayDid?: number;
  structure?: number;
  maxStructure?: number;
}

export function tradeItemEntryFor(guid: number, obj: TradeItemSource | undefined, isSelf: boolean): TradeItemRow {
  return {
    name: obj?.name ?? `Item 0x${guid.toString(16)}`,
    value: obj?.value ?? 0,
    guid,
    // FAITHFUL.541 — burden flows through both code paths.
    burden: obj?.burden ?? 0,
    iconDid: (isSelf ? obj?.iconDid : obj?.iconId) ?? 0,
    itemType: obj?.itemType,
    uiEffects: obj?.uiEffects,
    iconOverlayDid: (obj?.iconOverlayDid ?? obj?.iconOverlayId) || undefined,
    iconUnderlayDid: (obj?.iconUnderlayDid ?? obj?.iconUnderlayId) || undefined,
    // webac#25 — a partly used kit keeps its uses-remaining bar in the trade list.
    ...(obj?.maxStructure ? { structure: obj.structure ?? 0, maxStructure: obj.maxStructure } : {}),
  };
}
