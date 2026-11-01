/**
 * The toolbar's panel-tab row (LayoutDesc 0x21000016: 0x10000197 social at
 * x 55, magic 85, character 115, journal 145, map 175, options 204; each
 * 27 px tall, overlapping its neighbour by ~4 px) when an era hides some tabs
 * (era/EraFeatures.ts FEATURE_TOOLBAR_BUTTONS).
 *
 * Retail has no disabled look for these buttons: their only art states are
 * 1 (normal) and 6 (the panel is open), and gmToolbarUI never greys one out.
 * Each tab's art is an opaque tile whose edge columns are the plain bar (the
 * gold top strip over black), so a dropped tab would leave a hole through to
 * the 3D world. Instead the row collapses: every tab after a hidden one moves
 * left by the hidden slot's step (keeping the layout's spacing between the
 * tabs that remain), and the width freed at the row's end is filled with the
 * plain bar, stretched from a tab tile's edge column.
 */

export interface ToolbarTabSlot {
  id: string;
  /** The layout's x for this tab. */
  x: number;
  w: number;
}

export interface CollapsedToolbarRow {
  /** The visible tabs, in layout order, at their (possibly shifted) x. */
  tabs: Array<{ id: string; x: number; w: number }>;
  /** The plain-bar span freed at the row's end, or null when nothing is hidden. */
  filler: { x: number; w: number } | null;
}

/** Lay out the tab row without the `hidden` tabs (layout order and spacing kept, no holes). */
export function collapseToolbarTabs(slots: readonly ToolbarTabSlot[], hidden: ReadonlySet<string>): CollapsedToolbarRow {
  const tabs: CollapsedToolbarRow['tabs'] = [];
  let shift = 0;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (hidden.has(s.id)) {
      // The step from this slot to the next (the last slot: its own width less the usual overlap).
      const next = slots[i + 1];
      shift += next ? next.x - s.x : s.w;
      continue;
    }
    tabs.push({ id: s.id, x: s.x - shift, w: s.w });
  }
  if (shift === 0 || slots.length === 0) return { tabs, filler: null };
  const last = slots[slots.length - 1];
  const rowEnd = last.x + last.w;
  const end = tabs.length ? tabs[tabs.length - 1].x + tabs[tabs.length - 1].w : slots[0].x;
  return { tabs, filler: rowEnd > end ? { x: end, w: rowEnd - end } : null };
}

/**
 * The 1999 client.exe's own tab row (VISUAL.ac1999-hidden-element-gaps). PanelUI's ctor
 * @ 0x004eb120 builds five panel tabs with 0x005cf710(parent, 0, x, y, w, h), the same art
 * as end of retail's (0x0600111f social, 0x06001119 magic, 0x06001122 character, 0x06001116
 * map, 0x0600111c options) and no journal: social x 0x3d w 0x23, magic 0x60 / 0x22,
 * character 0x82 / 0x22, map 0xa4 / 0x22, options 0xc6 / 0x27, all 0x1b tall. They abut (each
 * x is the previous x + w) from the left separator 0x0600112b (blitted at x 0x37) to the
 * right one 0x0600112c (x 0xed), the options tab at its art's full 39 px. End of retail's
 * six (0x21000016) overlap by ~4 px to fit the journal in the same span.
 */
export const AC1999_TOOLBAR_TABS: readonly ToolbarTabSlot[] = [
  { id: 'tb-social', x: 0x3d, w: 0x23 },
  { id: 'tb-magic', x: 0x60, w: 0x22 },
  { id: 'tb-char', x: 0x82, w: 0x22 },
  { id: 'tb-map', x: 0xa4, w: 0x22 },
  { id: 'tb-opt', x: 0xc6, w: 0x27 },
];

/**
 * Lay out the tab row for an era: its client's own row (`eraSlots`, e.g. AC1999_TOOLBAR_TABS)
 * when it has one, with no filler (that row spans the bar between its separators), else the
 * layout's row closed up around the `hidden` tabs (collapseToolbarTabs). A tab neither in
 * `eraSlots` nor visible is not built.
 */
export function eraToolbarRow(
  slots: readonly ToolbarTabSlot[], hidden: ReadonlySet<string>, eraSlots: readonly ToolbarTabSlot[] | null,
): CollapsedToolbarRow {
  if (!eraSlots) return collapseToolbarTabs(slots, hidden);
  const known = new Set(slots.map((s) => s.id));
  return {
    tabs: eraSlots.filter((s) => known.has(s.id) && !hidden.has(s.id)).map((s) => ({ id: s.id, x: s.x, w: s.w })),
    filler: null,
  };
}
