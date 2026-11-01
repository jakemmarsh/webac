/**
 * VISUAL.ac1999-hidden-element-gaps — the in-fellowship pane's buttons when
 * the era has no fellowship leadership.
 *
 * End of retail's pane (layout 0x21000030 pane 0x10000275) has six 79x30
 * buttons in two rows: Leader 0x1000027b (18,534), Quit 0x1000027c (108,534),
 * Open 0x1000027d (198,534) over Recruit 0x1000027e (18,567), Dismiss
 * 0x1000027f (108,567), Disband 0x10000280 (198,567). A 1999 world has no
 * leader hand-off, openness or disband (Absent1999 fellowshipLeadership), so
 * hiding those three left three holes in the grid.
 *
 * The 1999 FellowPanel ctor @ 0x00533f90 builds one row of three 0x55-wide
 * buttons at y 299: "Recruit" (x 0xf), "Dismiss" (x 0x69) and "Disband"
 * (x 0xc3), whose press (FellowPanel_ListenToMessage, the +0x3c button) sends
 * CM_Fellowship_Event_Quit: the leave button. So the three left take the
 * bottom row's slots in that order (Recruit, Dismiss, Quit) and the list and
 * its scrollbar grow down over the emptied top row.
 */
import type { CollapseBox } from './CollapseHidden.js';

/** The two rows of end of retail's grid, left to right. */
export const FELLOWSHIP_BUTTONS_TOP = [0x1000027b, 0x1000027c, 0x1000027d] as const;
export const FELLOWSHIP_BUTTONS_BOTTOM = [0x1000027e, 0x1000027f, 0x10000280] as const;
/** The 1999 row's order: Recruit, Dismiss, then the leave button (our Quit). */
export const FELLOWSHIP_ROW_1999 = [0x1000027e, 0x1000027f, 0x1000027c] as const;
/** The roster list 0x10000279 and its scrollbar 0x1000027a, above the buttons. */
export const FELLOWSHIP_LIST_IDS = [0x10000279, 0x1000027a] as const;

/**
 * The 1999 one-row layout from the grid's rects: the FELLOWSHIP_ROW_1999
 * buttons on the bottom row's slots, the list and scrollbar taller by the row
 * step. Returns the rects of the elements that move (undefined when a rect is
 * missing).
 */
export function fellowshipOneRow(rects: ReadonlyMap<number, CollapseBox>): Map<number, CollapseBox> | undefined {
  const slots = FELLOWSHIP_BUTTONS_BOTTOM.map((id) => rects.get(id));
  const top = rects.get(FELLOWSHIP_BUTTONS_TOP[0]);
  if (!top || slots.some((r) => !r)) return undefined;
  const out = new Map<number, CollapseBox>();
  FELLOWSHIP_ROW_1999.forEach((id, i) => {
    const own = rects.get(id);
    const slot = slots[i]!;
    if (own) out.set(id, { x: slot.x, y: slot.y, w: own.w, h: own.h });
  });
  const step = slots[0]!.y - top.y;
  for (const id of FELLOWSHIP_LIST_IDS) {
    const r = rects.get(id);
    if (r) out.set(id, { ...r, h: r.h + step });
  }
  return out;
}
