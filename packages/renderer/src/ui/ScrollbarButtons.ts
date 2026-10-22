/**
 * The two runtime behaviours of a retail UIElement_Scrollbar's arrow buttons
 * that a static LayoutRenderer pass does not give (BUG.ac1999-spellbar-arrows,
 * webac#6): where the buttons sit, and the press-and-hold repeat.
 *
 * Placement — UIElement_Scrollbar::Global_Loop @ 00470ca0: a scrollbar whose
 * button ids (p119 increment / p120 decrement, OnSetAttribute @ 004714d0 →
 * UpdateButtonID_ @ 00470680) were set before its children existed resolves
 * them on the next frame and moves the increment button to (0, 0) and the
 * decrement button to (width − w, height − h). The arrow-pair template
 * 0x21000008:0x10000070 authors both arrows right-anchored (0x10000072
 * leftEdge 2, 0x10000071 leftEdge 2), so the static reflow of a wider
 * scroller lands the LEFT arrow beside the right one (the spell bar's at 399
 * of 485, the container strip's at 640 of 726).
 *
 * Hot-click — UIElement_Button::MouseDown @ 00471ff0: a button with p15 set
 * sends its message on the PRESS, then ListenToGlobalMessage @ 00471c60
 * repeats it every p17 seconds after a first wait of p16 while the pointer
 * stays on the button (bit 1; off it the next repeat waits), until MouseUp
 * @ 004720e0, which sends no further click. The arrow template sets p15
 * true, p16 0.5, p17 0.1.
 */

/** Put the increment button at the scroller's top-left and the decrement button at its bottom-right corner. */
export function placeScrollbarButtons(scroller: HTMLElement, increment: HTMLElement | null, decrement: HTMLElement | null): void {
  const w = parseInt(scroller.style.width, 10);
  const h = parseInt(scroller.style.height, 10);
  if (increment) {
    increment.style.left = '0px';
    increment.style.top = '0px';
  }
  if (decrement && Number.isFinite(w) && Number.isFinite(h)) {
    const bw = parseInt(decrement.style.width, 10) || 0;
    const bh = parseInt(decrement.style.height, 10) || 0;
    decrement.style.left = `${Math.max(0, w - bw)}px`;
    decrement.style.top = `${Math.max(0, h - bh)}px`;
  }
}

/**
 * UIElement_Button::UpdateState_ @ 00471cf0 (not toggled, not ghosted): 1 at
 * rest; 2 while held with the pointer off it, or hovered when the button
 * has p19 (rollover); 3 while held with the pointer on it. The arrow
 * template's art: 1 and 3 the plain arrow, 2 the lit one.
 */
export function buttonVisualState(held: boolean, over: boolean, rollover: boolean): number {
  if (held && over) return 3;
  if (held || (rollover && over)) return 2;
  return 1;
}

/** A button's hot-click timing in seconds (p16 first wait, p17 repeat), with the arrow template's values as defaults. */
export interface HotClickTiming { delayS: number; rateS: number }
export const ARROW_HOT_CLICK: HotClickTiming = Object.freeze({ delayS: 0.5, rateS: 0.1 });

/** Read p15 / p16 / p17 off a resolved ElementDesc's properties; null when the button does not hot-click. */
export function hotClickTiming(props: ReadonlyMap<number, { valueBool?: boolean; valueFloat?: number }> | undefined): HotClickTiming | null {
  if (!props) return { ...ARROW_HOT_CLICK };
  if (props.get(15)?.valueBool === false) return null;
  const delayS = props.get(16)?.valueFloat;
  const rateS = props.get(17)?.valueFloat;
  return {
    delayS: typeof delayS === 'number' && delayS > 0 ? delayS : ARROW_HOT_CLICK.delayS,
    rateS: typeof rateS === 'number' && rateS > 0 ? rateS : ARROW_HOT_CLICK.rateS,
  };
}

/**
 * Bind a hot-click button: `step` runs on the left-button press and then
 * repeats while it is held over the button; the release anywhere stops it.
 * `pressed` (optional) shows the button's pressed art for the hold. A
 * `timing` of null steps once per press.
 */
export function bindHotClick(button: HTMLElement, step: () => void, timing: HotClickTiming | null, pressed?: (down: boolean) => void): void {
  button.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const doc = button.ownerDocument;
    const win = doc.defaultView;
    let over = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onEnter = () => { over = true; };
    const onLeave = () => { over = false; };
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      button.removeEventListener('mouseenter', onEnter);
      button.removeEventListener('mouseleave', onLeave);
      doc.removeEventListener('mouseup', stop, true);
      win?.removeEventListener('blur', stop);
      pressed?.(false);
    };
    const tick = () => {
      if (over) step();
      timer = setTimeout(tick, timing!.rateS * 1000);
    };
    button.addEventListener('mouseenter', onEnter);
    button.addEventListener('mouseleave', onLeave);
    doc.addEventListener('mouseup', stop, true);
    win?.addEventListener('blur', stop);
    pressed?.(true);
    step();
    if (timing) timer = setTimeout(tick, timing.delayS * 1000);
  });
}
