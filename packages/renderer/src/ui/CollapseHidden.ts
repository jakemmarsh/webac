/**
 * BUG.era-hidden-row-gaps — closing up after a control an era hides.
 *
 * DAT layouts place every element at an absolute rect, so hiding one (an era
 * without the feature: NO-DEAD-ENDS) leaves its rect empty: a row-sized hole in
 * a checkbox list, an icon-sized one in a strip. Retail has no such hole (its
 * 1999 panels were laid out without the control), so the siblings past the
 * hidden element move back by its size along the list's axis, and a sibling
 * that spans it (a strip's top / bottom edge) shrinks by it when asked. An
 * era that hides nothing gets every rect back unchanged.
 */

export interface CollapseBox { x: number; y: number; w: number; h: number }

export interface CollapseResult<K> {
  /** Every box's rect after the collapse (hidden ones unchanged). */
  boxes: Map<K, CollapseBox>;
  /** The total size freed along the axis (the container may shrink by it). */
  freed: number;
}

/**
 * Close up the hidden boxes along `axis`: a sibling wholly past a hidden box
 * (its start at or after the hidden box's end) moves back by the hidden box's
 * size; with `shrinkSpanning`, a sibling wholly containing it along the axis
 * shrinks by that size. All arithmetic runs on the original rects, so a second
 * call with the same input gives the same answer.
 */
export function collapseHiddenBoxes<K>(
  boxes: ReadonlyMap<K, CollapseBox>,
  hidden: ReadonlySet<K>,
  axis: 'x' | 'y',
  opts: { shrinkSpanning?: boolean } = {},
): CollapseResult<K> {
  const start = (b: CollapseBox): number => (axis === 'x' ? b.x : b.y);
  const size = (b: CollapseBox): number => (axis === 'x' ? b.w : b.h);
  const gone = [...boxes].filter(([k]) => hidden.has(k)).map(([, b]) => b);
  const out = new Map<K, CollapseBox>();
  for (const [k, b] of boxes) {
    if (hidden.has(k)) { out.set(k, { ...b }); continue; }
    let shift = 0; let shrink = 0;
    for (const h of gone) {
      if (start(b) >= start(h) + size(h)) shift += size(h);
      else if (opts.shrinkSpanning && start(b) <= start(h) && start(b) + size(b) >= start(h) + size(h)) shrink += size(h);
    }
    out.set(k, axis === 'x'
      ? { x: b.x - shift, y: b.y, w: b.w - shrink, h: b.h }
      : { x: b.x, y: b.y - shift, w: b.w, h: b.h - shrink });
  }
  return { boxes: out, freed: gone.reduce((n, b) => n + size(b), 0) };
}

/**
 * The DOM side: the absolutely placed children `els` (the DAT elements of one
 * parent) take their collapsed rects. Each element's authored rect is read
 * from its style once and kept (data-ac-dat-rect), so re-rendering the same
 * tree, or an era that hides nothing, lands every element back on its DAT rect.
 */
export function collapseHiddenElements(
  els: ReadonlyMap<number, HTMLElement>,
  hidden: ReadonlySet<number>,
  axis: 'x' | 'y',
  opts: { shrinkSpanning?: boolean } = {},
): number {
  const rects = new Map<number, CollapseBox>();
  for (const [id, el] of els) rects.set(id, datRect(el));
  const { boxes, freed } = collapseHiddenBoxes(rects, hidden, axis, opts);
  for (const [id, el] of els) placeRect(el, boxes.get(id)!);
  return freed;
}

/**
 * An absolutely placed element's authored (DAT) rect: read from its style the
 * first time and kept (data-ac-dat-rect), so later moves never compound.
 */
export function datRect(el: HTMLElement): CollapseBox {
  let saved = el.dataset.acDatRect;
  if (!saved) {
    saved = [el.style.left, el.style.top, el.style.width, el.style.height].map((v) => `${parseFloat(v) || 0}`).join(',');
    el.dataset.acDatRect = saved;
  }
  const [x, y, w, h] = saved.split(',').map(Number);
  return { x, y, w, h };
}

/**
 * Put `el` at `after`, its authored rect kept by datRect. Only a moved value
 * is written, or one restoring a value an earlier move changed.
 */
export function placeRect(el: HTMLElement, after: CollapseBox): void {
  const before = datRect(el);
  const put = (prop: 'left' | 'top' | 'width' | 'height', v: number, orig: number): void => {
    const cur = el.style[prop];
    if (v !== orig || (cur !== '' && parseFloat(cur) !== v)) el.style[prop] = `${v}px`;
  };
  put('left', after.x, before.x);
  put('top', after.y, before.y);
  put('width', after.w, before.w);
  put('height', after.h, before.h);
}
