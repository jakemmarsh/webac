/**
 * Mag-Tools' Tools → Inventory (docs/plugin-specs/magtools.md §2.5, §7.1), rebuilt clean-room: the regex
 * search over each item's item-info string (§8), and Clipboard Worn Equipment / Clipboard Inventory Info.
 *
 * Browser adaptation: the async Clipboard API wants a recent user gesture, and the copy waits for
 * appraisals first, so the write can be refused; then the text is handed over as a download instead.
 */
import { mtLine } from './format.js';
import { MtObjectClass } from './itemInfo.js';

/** The search box's initial text (cleared on click). */
export const MT_INVENTORY_SEARCH_HINT = 'regex search string';
/** The list's columns: icon 16, name 304, id (hidden). */
export const MT_INVENTORY_LIST_COLUMNS = [16, 304] as const;

export const MT_COPY_START = 'Copying all inventory item info to clipboard...';
export const MT_COPY_DONE = 'All inventory item info has been copied to the clipboard.';

/** An inventory item for the search list. */
export interface MtInventoryToolItem {
  id: number;
  name: string;
  icon?: number;
  /** Its §8 item-info string (mtItemInfo), as far as its appraisal allows. */
  info: string;
}

/** Every item whose info string matches the text as a case-insensitive regex (an invalid pattern matches nothing). */
export function mtInventorySearch<T extends MtInventoryToolItem>(items: readonly T[], pattern: string): T[] {
  if (pattern === '' || pattern === MT_INVENTORY_SEARCH_HINT) return [];
  let re: RegExp;
  try { re = new RegExp(pattern, 'i'); } catch { return []; }
  return items.filter((i) => re.test(i.info));
}

/** An item for the clipboard export. */
export interface MtInventoryExportItem {
  id: number;
  objectClass: number;
  /** Its item-info string (read after the appraisals land). */
  info: string;
  appraised: boolean;
  /** Wielded by me (CurrentWieldedLocation > 0). */
  equipped: boolean;
  /** CurrentWieldedLocation (10): the equipped items' sort key. */
  wieldedLocation?: number;
  /** 0 for the main pack, else the side pack's place in the main pack (1 = the first). */
  pack: number;
  /** Its slot in its pack. */
  slot: number;
  /** A side pack or a foci (sorted after the main pack's loose items). */
  container?: boolean;
}

/** The classes the copy appraises first (armor, clothing, melee and missile weapons, casters, jewelry). */
export function mtCopyNeedsAppraisal(i: MtInventoryExportItem): boolean {
  const c = i.objectClass;
  return !i.appraised && (c === MtObjectClass.Armor || c === MtObjectClass.Clothing || c === MtObjectClass.MeleeWeapon
    || c === MtObjectClass.MissileWeapon || c === MtObjectClass.WandStaffOrb || c === MtObjectClass.Jewelry);
}

/**
 * The export order: the main pack first (equipped items by slot mask, then loose items by slot, then
 * packs and foci), then the side packs in order, each by slot.
 */
export function mtInventoryExportOrder<T extends MtInventoryExportItem>(items: readonly T[]): T[] {
  const rank = (i: T) => (i.equipped ? 0 : i.pack !== 0 ? 3 : i.container ? 2 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b)
    || (a.equipped && b.equipped ? (a.wieldedLocation ?? 0) - (b.wieldedLocation ?? 0) : 0)
    || a.pack - b.pack || a.slot - b.slot);
}

/** The text copied: one item-info line per item ("worn" = equipped by me; "inventory" = the rest). */
export function mtInventoryExportText(items: readonly MtInventoryExportItem[], which: 'worn' | 'inventory'): string {
  return mtInventoryExportOrder(items.filter((i) => i.equipped === (which === 'worn'))).map((i) => i.info).join('\r\n');
}

/** What the copy needs from the game. */
export interface MtInventoryCopyHost {
  items(): MtInventoryExportItem[];
  /** Ask for these appraisals and resolve once they have arrived (or given up). */
  appraise(ids: number[]): Promise<void>;
  /** Write the clipboard; rejects when the browser refuses. */
  writeClipboard(text: string): Promise<void>;
  /** A Mag-Tools chat line (already prefixed). */
  print(line: string): void;
  /** The fallback when the clipboard refuses: hand the text over as a file. */
  download?(name: string, text: string): void;
}

/** Clipboard Worn Equipment / Clipboard Inventory Info, start to finish. */
export async function mtCopyInventoryInfo(which: 'worn' | 'inventory', host: MtInventoryCopyHost): Promise<void> {
  host.print(mtLine(MT_COPY_START));
  const pick = (all: MtInventoryExportItem[]) => all.filter((i) => i.equipped === (which === 'worn'));
  const need = pick(host.items()).filter(mtCopyNeedsAppraisal).map((i) => i.id);
  if (need.length) await host.appraise(need);
  const text = mtInventoryExportText(host.items(), which);
  try {
    await host.writeClipboard(text);
    host.print(mtLine(MT_COPY_DONE));
  } catch {
    if (host.download) host.download(which === 'worn' ? 'WornEquipment.txt' : 'InventoryInfo.txt', text);
  }
}
