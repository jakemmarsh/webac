/**
 * BUG.vendor-dblclick-buy-dropped — a double-click that survives a redraw
 * between its two clicks.
 *
 * Retail reads a double-click from Windows' own click counter
 * (WM_LBUTTONDBLCLK; CInputManager_WIN32::GetDoubleClickDelay): the second
 * press of a pair is message 10 on whatever UIElement is under the cursor,
 * and retail's elements live for the panel's life. Ours often rebuilds a
 * list on its first click (a vendor's shop list re-renders to move the
 * selection, gmVendorUI::HandleMousePresses @ 004c40d0 → BuySingleItem on
 * message 10), and a browser sends no `dblclick` when the first click's node
 * was replaced: Chrome logs mousedown 1 → click 1 → mousedown 2 → click 2 on
 * the new cell and nothing else, so the purchase never happened.
 *
 * So the pair is recognised from the click's own count (`event.detail`, the
 * OS click count) on the same LOGICAL item, matched by a key the caller
 * gives (an object guid, a slot index), never by node identity:
 *  - an odd click (1, 3, …) on a bound element is a first click: it records
 *    the element's key;
 *  - an even click (2, 4, …) whose key matches the recorded one acts — the
 *    Win32 shape, where the third press of a triple-click is a plain click
 *    and the fourth is the next double-click;
 *  - a native `dblclick` still acts (synthetic events, a browser that sends
 *    one on the replaced node), except right after the even click already
 *    acted for the same key: exactly one action per double-click.
 *  - two slow single clicks (detail 1 each) never act.
 */
export class DoubleClickAcrossRedraw {
  /** The key of the last odd (first-of-a-pair) click on a bound element. */
  private firstKey: string | null = null;
  /** The key an even click acted for, until the next press (its trailing dblclick is the same gesture). */
  private actedKey: string | null = null;

  constructor(target: Pick<Document, 'addEventListener'> | null = typeof document !== 'undefined' ? document : null) {
    if (!target) return;
    // Before any element's own listeners: an odd click anywhere (or a
    // synthetic detail-0 click) starts over; a bound element re-records it.
    target.addEventListener('click', (e) => {
      const d = (e as MouseEvent).detail;
      if (d === 0 || d % 2 === 1) this.firstKey = null;
    }, true);
    target.addEventListener('mousedown', () => { this.actedKey = null; }, true);
  }

  /**
   * Run `act` on a double-click of `el`. `key` names the logical item the
   * element shows (read at click time); `''` means nothing to act on.
   */
  bind(el: HTMLElement, key: () => string, act: () => void): void {
    el.addEventListener('click', (e) => {
      const d = e.detail;
      const k = key();
      if (d >= 1 && d % 2 === 1) { this.firstKey = k; return; }
      if (d < 2 || k === '' || this.firstKey !== k) return;
      this.firstKey = null;
      this.actedKey = k;
      act();
    });
    el.addEventListener('dblclick', () => {
      const k = key();
      if (this.actedKey !== null && this.actedKey === k) { this.actedKey = null; return; }
      act();
    });
  }
}

let shared: DoubleClickAcrossRedraw | null = null;

/** The page's one recogniser (GameUI and the launcher share its click state). */
export function sharedDoubleClick(): DoubleClickAcrossRedraw {
  shared ??= new DoubleClickAcrossRedraw();
  return shared;
}
