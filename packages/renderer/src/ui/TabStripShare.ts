/**
 * VISUAL.ac1999-hidden-element-gaps — a panel's tab strip when an era hides
 * some of its tabs.
 *
 * End of retail's tab strips are DAT rects (the character panel's three 92 px
 * tabs, the Social panel's four, the World panel's two 138 px ones) ending at
 * the minimize box at x 276. Hiding a tab there (NO-DEAD-ENDS: 1999 has no
 * Titles, Friends, Squelch or House page) left its rect empty: a blank run
 * before the box.
 *
 * The 1999 client.exe, the era that hides them, lays every tab strip out the
 * same way: its tabs share the 0x114 (276) px before the box equally.
 *   - StatsPanel ctor @ 0x00549c90: Attributes and Skills, 0x8a x 0x19 each
 *     (0x00549c00), at x 0 (xor edx,edx @ 0x00549f6f) and 0x8a (@ 0x00549fbf);
 *     the minimize box at 0x114.
 *   - GroupPanel ctor @ 0x005375e0: Allegiance and Fellowship, 0x8a each (0x00533940), at
 *     x 0 and 0x8a.
 *   - MagicPanBase @ 0x0054c500: Spellbook, Components and Create Spell, 0x5c
 *     each (CreateTopTab @ 0x0054cca0), at x 0, 0x5c and 0xb8.
 *   - MapSubPanel ctor @ 0x00507f70: one page, its title art 0x0600127b blitted at (0, 0)
 *     0x114 x 0x1e: the whole strip.
 * So the visible tabs share the strip's span equally, in their order; the
 * height and art (the DAT tab template's 3-slice) are unchanged. An era that
 * hides nothing keeps every DAT rect.
 */

export interface TabSlot { id: number; x: number; w: number }

/**
 * The visible tabs' rects when `hidden` tabs are gone, or null when none is
 * hidden (keep the DAT rects). The strip spans the first tab's x to the last
 * tab's right edge; the visible tabs split it equally (any odd pixel goes to
 * the last), in strip order.
 */
export function shareTabStrip(tabs: readonly TabSlot[], hidden: ReadonlySet<number>): TabSlot[] | null {
  if (!tabs.some((t) => hidden.has(t.id))) return null;
  const ordered = [...tabs].sort((a, b) => a.x - b.x);
  const visible = ordered.filter((t) => !hidden.has(t.id));
  if (visible.length === 0) return [];
  const start = ordered[0].x;
  const end = Math.max(...ordered.map((t) => t.x + t.w));
  const each = Math.floor((end - start) / visible.length);
  return visible.map((t, i) => ({
    id: t.id,
    x: start + i * each,
    w: i === visible.length - 1 ? end - (start + i * each) : each,
  }));
}

/** The pieces of a rendered layout handle the strip needs. */
export interface TabStripHandle {
  elements: Map<number, HTMLElement>;
  descs?: Map<number, { x: number; y: number; width: number; height: number }>;
  resizeElement?(elementId: number, width: number, height: number): void;
}

/**
 * Re-lay a rendered tab strip: each of `ids` (DAT tab elements, their rects
 * from the handle's resolved descs) not in `hidden` takes its shared rect
 * (shareTabStrip), its 3-slice art reflowing through resizeElement. Returns the
 * rects applied, or null when nothing was hidden (or a desc is missing).
 */
export function applySharedTabStrip(handle: TabStripHandle, ids: readonly number[], hidden: ReadonlySet<number>): TabSlot[] | null {
  const slots: TabSlot[] = [];
  for (const id of ids) {
    const d = handle.descs?.get(id);
    if (!d) return null;
    slots.push({ id, x: d.x, w: d.width });
  }
  const shared = shareTabStrip(slots, hidden);
  if (!shared) return null;
  for (const s of shared) {
    const el = handle.elements.get(s.id);
    if (!el) continue;
    el.style.left = `${s.x}px`;
    el.style.width = `${s.w}px`;
    handle.resizeElement?.(s.id, s.w, handle.descs!.get(s.id)!.height);
  }
  return shared;
}
