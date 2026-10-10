/**
 * SpellComponentList — what gmSpellComponentUI (the spellbook's Components
 * page, layout 0x21000033:0x100002a7, class 0x1000002f) lists, ported from
 * the decompiled client. The view (GameUI.renderComponentsTab) draws it.
 *
 *  - ComponentTracker: an owned object is tracked when its ItemType has
 *    SpellComponents (0x1000); its category is the SpellComponentTable entry
 *    of WCIDtoSCID(wcid) (DetermineComponentCategory @ 00585f50) — an object
 *    with no table entry is not tracked.
 *  - ComponentTracker::AddComponent @ 00586a20: within a category, entries
 *    are in ascending byte-wise (case-sensitive strcmp) order of the weenie
 *    name; an object whose name equals an entry's joins that entry
 *    (ComponentData::AddItem), whatever its WCID.
 *  - ComponentData::AddItem @ 00586610: numItems sums the stacks, a stack
 *    size of 0 counting as 1; an entry at 0 is removed, so no "0" row shows.
 *  - gmSpellComponentUI::UpdateComponents @ 0048a910: categories 0..6 in
 *    order, each non-empty one led by its header row (template 0x10000466).
 *  - Desired level (0x1000046b): to_int32 @ 00489b90 is wcstol(text, 0, 0)
 *    (base auto-detect); 0..5000 commits (Event_SetDesiredComponentLevel +
 *    PlayerModule::SetDesiredCompLevel @ 005d4940), anything else reverts.
 */

export const SPELL_COMPONENTS_ITEM_TYPE = 0x1000;
export const DESIRED_LEVEL_MAX = 5000;

export interface ComponentSource {
  id: number;
  name: string;
  weenieClassId: number;
  itemType?: number;
  stackSize?: number;
}

export interface ComponentEntry {
  name: string;
  /** The WCID of the first object that made the entry (the row's 0x1000004c). */
  wcid: number;
  /** SpellComponentTable id (the icon is that entry's). */
  scid: number;
  numItems: number;
  /** ComponentData::GetFirstObjectID — the owned stack a row click selects. */
  firstObjectId: number;
}

export type ComponentListRow =
  | { kind: 'header'; category: number }
  | { kind: 'component'; category: number; entry: ComponentEntry };

/** strcmp: byte-wise, case-sensitive. */
export function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The rows the page shows. `scidOf` is WCIDtoSCID; `categoryOf` the table
 * entry's category (0..6), undefined when the SCID has no entry.
 */
export function buildComponentRows(
  items: readonly ComponentSource[],
  scidOf: (wcid: number) => number | undefined,
  categoryOf: (scid: number) => number | undefined,
): ComponentListRow[] {
  const byCategory = new Map<number, ComponentEntry[]>();
  for (const item of items) {
    if (((item.itemType ?? 0) & SPELL_COMPONENTS_ITEM_TYPE) === 0) continue;
    const scid = scidOf(item.weenieClassId);
    if (scid === undefined) continue;
    const category = categoryOf(scid);
    if (category === undefined || category < 0 || category > 6) continue;
    const list = byCategory.get(category) ?? [];
    byCategory.set(category, list);
    const count = (item.stackSize ?? 0) === 0 ? 1 : item.stackSize!;
    const same = list.find((e) => e.name === item.name);
    if (same) { same.numItems += count; continue; }
    const entry: ComponentEntry = { name: item.name, wcid: item.weenieClassId, scid, numItems: count, firstObjectId: item.id };
    let at = list.findIndex((e) => byteCompare(item.name, e.name) < 0);
    if (at < 0) at = list.length;
    list.splice(at, 0, entry);
  }
  const rows: ComponentListRow[] = [];
  for (let category = 0; category <= 6; category++) {
    const list = byCategory.get(category);
    if (!list || list.length === 0) continue;
    rows.push({ kind: 'header', category });
    for (const entry of list) rows.push({ kind: 'component', category, entry });
  }
  return rows;
}

/** wcstol(text, 0, 0): optional sign, 0x hex, leading-0 octal, else decimal; stops at the first bad digit. */
export function wcstolBase0(text: string): number {
  const m = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(text);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const body = m[2];
  const v = /^0[xX]/.test(body) ? parseInt(body.slice(2), 16) : body.length > 1 && body[0] === '0' ? parseInt(body, 8) : parseInt(body, 10);
  return sign * v;
}

/** The committed desired level for `text`, or null when it must revert. */
export function desiredLevelFromText(text: string): number | null {
  const v = wcstolBase0(text);
  return v >= 0 && v <= DESIRED_LEVEL_MAX ? v : null;
}

/**
 * ClientMagicSystem::CompositeSpellComponentIcon @ 00567720: the table icon
 * blitted (Blit_Normal), then SurfaceWindow::ReplaceColor @ 00441530 turns
 * every pixel that is exactly opaque white (0xFFFFFFFF) opaque black.
 */
export function compositeSpellComponentIcon(img: { width: number; height: number; data: Uint8Array }): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(img.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255 && data[i + 3] === 255) {
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
    }
  }
  return { width: img.width, height: img.height, data };
}
