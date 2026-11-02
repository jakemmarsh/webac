/**
 * VISUAL.ac1999-spellbar-drag-autoscroll — the spell bar scrolls itself while a spell drag rests
 * near one of its ends. Both clients do it, each its own way (EraClientRules.spellBarDragScroll):
 *
 * End of retail ('layout') — UIElement_ItemList, from the list's own DAT attributes (InitItemList
 * @ 004e4830: 0x10000053 horizontal, 0x10000059 margin width, 0x10000057 jump distance, 0x1000005b
 * delay, 0x1000005d spell scrolling; the ctor @ 004e3aa0 defaults false / 0 / 1 / 1.0 / false). RecvNotice_BeginDrag @ 004e2540 starts tracking for a drag carrying
 * a spell when spell scrolling is on; TrackDragScrolling @ 004e30d0 each frame asks
 * WhatDragScrollRegion @ 004e25f0: with the pointer between the list's top and bottom, up to
 * `margin` px LEFT of its left edge (x < X0, x >= X0 - margin) is region 3, up to `margin` px RIGHT
 * of its right edge is region 4 — outside the list. Entering arms the clock (now + delay); each
 * frame past it re-arms it and ScrollToX(± jump). Leaving disarms. The spell bar's list
 * 0x21000010:0x100000b6 sets horizontal, spell scrolling, margin 32, jump 32 (one cell), delay 0.2.
 *
 * AC1999 ('ac1999') — the spell list (class 0x6049b8) Global_Loop @ 0x00515120, while a spell drag
 * is over it (+0x180, set by DragOverAction @ 0x00514ee0, cleared by StopDraggingOver @ 0x005150c0):
 * with the pointer between the list's top (+0x20) and bottom (+0x28), within 0x1e = 30 px of the
 * left edge (+0x1c) or of the right edge (+0x24) for 0.4 s (Timer_get_cur_time, +0x18c / +0x194),
 * it scrolls one cell (0x005d59c0 with 0x005d5aa0 - 1 / + 1) and starts the clock again. The drag
 * is only "over" while the pointer is on the list, so the band is the list's inner 30 px.
 */

/** How one client's list scrolls under a drag. */
export interface DragScrollRule {
  /** 'outside': the band beyond each edge (end of retail); 'inside': the band inside each edge (1999). */
  zone: 'outside' | 'inside';
  /** The band's width in layout px. */
  margin: number;
  /** Seconds the pointer rests in a band before each step. */
  delaySeconds: number;
  /** One step's scroll, in layout px. */
  stepPx: number;
}

/** EraClientRules.spellBarDragScroll: read the list's DAT attributes, or the 1999 client's constants. */
export type SpellBarDragScrollSource = 'layout' | 'ac1999';

/** The 1999 spell list's constants (0x00515120): 30 px, 0.4 s, one 32 px cell. */
export const AC1999_SPELLBAR_DRAG_SCROLL: DragScrollRule = Object.freeze({ zone: 'inside', margin: 0x1e, delaySeconds: 0.4, stepPx: 32 });

/** The ItemList attribute ids UIElement_ItemList reads for drag scrolling. */
export const ITEMLIST_DRAG_SCROLL_PROPS = Object.freeze({
  horizontal: 0x10000053, marginWidth: 0x10000059, jumpDistance: 0x10000057, delay: 0x1000005b, spellScrolling: 0x1000005d,
});

/** The parts of a DAT property value the attributes use. */
export interface DragScrollPropValue { valueBool?: boolean; valueInt?: number; valueFloat?: number }

/**
 * The end-of-retail rule from the list's attributes, or null when the list doesn't scroll
 * horizontally for a spell drag (horizontal or spell scrolling off).
 */
export function layoutDragScrollRule(props: ReadonlyMap<number, DragScrollPropValue> | undefined): DragScrollRule | null {
  const p = ITEMLIST_DRAG_SCROLL_PROPS;
  if (props?.get(p.horizontal)?.valueBool !== true || props?.get(p.spellScrolling)?.valueBool !== true) return null;
  return {
    zone: 'outside',
    margin: props.get(p.marginWidth)?.valueInt ?? 0,
    delaySeconds: props.get(p.delay)?.valueFloat ?? 1.0,
    stepPx: props.get(p.jumpDistance)?.valueInt ?? 1,
  };
}

/** A list's rect in layout px. */
export interface ListRect { left: number; top: number; right: number; bottom: number }

/** -1 = the left band, 1 = the right band, 0 = neither. */
export type DragScrollRegion = -1 | 0 | 1;

/** Which band the pointer (layout px) is in. */
export function dragScrollRegion(rule: DragScrollRule, rect: ListRect, x: number, y: number): DragScrollRegion {
  if (y < rect.top || y > rect.bottom) return 0;
  const m = rule.margin;
  if (rule.zone === 'outside') {
    // WhatDragScrollRegion @ 004e25f0: x < X0 && x >= X0 - margin; x > X1 && x <= X1 + margin.
    if (x < rect.left && x >= rect.left - m) return -1;
    if (x > rect.right && x <= rect.right + m) return 1;
    return 0;
  }
  // 0x00515120 on a drag over the list: [left, left + 30) and (right - 30, right].
  if (x < rect.left || x > rect.right) return 0;
  if (x < rect.left + m) return -1;
  if (x > rect.right - m) return 1;
  return 0;
}

/** The rest clock: a step is due `delaySeconds` after entering a band, and again each `delaySeconds` after. */
export class DragScrollClock {
  private region: DragScrollRegion = 0;
  private due = 0;

  constructor(private readonly delaySeconds: number) {}

  /** Advance to `nowSeconds` with the pointer in `region`; returns the direction to scroll now, or 0. */
  tick(region: DragScrollRegion, nowSeconds: number): DragScrollRegion {
    if (region === 0) { this.region = 0; return 0; }
    if (region !== this.region) {
      this.region = region;
      this.due = nowSeconds + this.delaySeconds;
      return 0;
    }
    if (nowSeconds < this.due) return 0;
    this.due = nowSeconds + this.delaySeconds;
    return region;
  }

  reset(): void { this.region = 0; }
}
