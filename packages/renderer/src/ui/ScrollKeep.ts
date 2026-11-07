/**
 * Keep a panel's scroll positions across a rebuild of its DOM.
 *
 * Retail updates a list in place: the list box owns its scroll offset and a
 * re-list of the same container leaves it where it was, clamped to the new
 * content.
 *  - End of retail: UIElement_ItemList::ServerSaysMoveItem @ 004e5000 re-lists
 *    the shown container through ItemList_SetParentContainer @ 004e49d0
 *    (ItemList_Flush, then ItemList_AddItem per object). Neither touches the
 *    list box's m_iScrollableY. UIElement_Scrollable::SetScrollableXY
 *    @ 004740c0 clamps the offset to [0, content - view]. Only a click that
 *    opens a different container scrolls the child list home
 *    (UIElement_ItemList::ListenToElementMessage @ 004e4d50, openItemID
 *    changed → UIElement_ListBox::ScrollToHome @ 0048b120).
 *  - 1999: ItemList_SetParentContainer @ 0x0053b330 saves the offset
 *    (+0x138 / +0x130) when the container is the one already shown, re-adds
 *    the items, then puts it back through 0x005d4460, which clamps it
 *    (0x005d4860). A different container starts at 0, 0.
 *
 * Ours tears most panels down and renders them again, so every viewport
 * starts at the top unless its offset is carried over. Mark a rebuilt
 * scroll viewport with `data-scroll-key` (or rely on its `data-element-id`);
 * the key path of keyed ancestors names it, so a key that carries its
 * context (the shown pack, the tab) starts a new context at the top, as
 * retail's ScrollToHome does.
 */

export interface ScrollOffset { top: number; left: number }
export type ScrollSnapshot = Map<string, ScrollOffset>;

const KEYED = '[data-scroll-key], [data-element-id]';

function keyOf(el: HTMLElement): string {
  return el.dataset.scrollKey !== undefined ? `k:${el.dataset.scrollKey}` : `e:${el.dataset.elementId ?? ''}`;
}

/** The key path from `el` up to (not including) `root`. */
export function scrollKeyPath(el: HTMLElement, root: HTMLElement): string {
  const parts: string[] = [];
  for (let e: HTMLElement | null = el; e && e !== root; e = e.parentElement) {
    if (e.dataset.scrollKey !== undefined || e.dataset.elementId !== undefined) parts.push(keyOf(e));
  }
  return parts.join('<');
}

/** Every keyed viewport under `root` that is scrolled away from its origin. */
export function captureScroll(root: HTMLElement | null | undefined): ScrollSnapshot {
  const out: ScrollSnapshot = new Map();
  if (!root) return out;
  for (const el of root.querySelectorAll<HTMLElement>(KEYED)) {
    const top = el.scrollTop || 0;
    const left = el.scrollLeft || 0;
    if (top > 0 || left > 0) out.set(scrollKeyPath(el, root), { top, left });
  }
  return out;
}

/**
 * The offset clamped to what `el` can scroll now (SetScrollableXY's clamp).
 * An element with no laid-out size yet keeps the offset as given; the
 * browser clamps a scrollTop it cannot reach on its own.
 */
export function clampScroll(el: HTMLElement, top: number, left: number): ScrollOffset {
  const maxTop = el.scrollHeight > 0 ? Math.max(0, el.scrollHeight - el.clientHeight) : top;
  const maxLeft = el.scrollWidth > 0 ? Math.max(0, el.scrollWidth - el.clientWidth) : left;
  return { top: Math.max(0, Math.min(top, maxTop)), left: Math.max(0, Math.min(left, maxLeft)) };
}

/** Put a viewport at an offset (clamped) and let its DAT scrollbar thumb follow. */
export function applyScroll(el: HTMLElement, top: number, left = 0): void {
  const c = clampScroll(el, top, left);
  if (el.scrollTop === c.top && el.scrollLeft === c.left) return;
  el.scrollTop = c.top;
  el.scrollLeft = c.left;
  el.dispatchEvent(new Event('scroll'));
}

/** Restore a snapshot onto the rebuilt `root`; returns how many viewports matched. */
export function restoreScroll(root: HTMLElement | null | undefined, snap: ScrollSnapshot): number {
  if (!root || snap.size === 0) return 0;
  let n = 0;
  for (const el of root.querySelectorAll<HTMLElement>(KEYED)) {
    const s = snap.get(scrollKeyPath(el, root));
    if (!s) continue;
    applyScroll(el, s.top, s.left);
    n++;
  }
  return n;
}
