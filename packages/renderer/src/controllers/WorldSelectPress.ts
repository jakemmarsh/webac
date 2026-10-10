/**
 * The left-button select over the 3D world (DECOMP.empty-click-deselects).
 *
 * UIElement_SmartBoxWrapper::MouseDown @ 004e5700 starts the find on the
 * PRESS of the left button (input 7): unless HandleSelectLeft consumed it
 * (Use Mouse Turning's run) it sets m_SearchReason = sr_Select (or
 * sr_TargetedUse with a target mode armed) and calls FindObject. MouseUp
 * @ 004e5820 does nothing for the left button but clear mouseleft_down, so
 * the selection lands on mouse-down, not on the click (release).
 *
 * UIElement_SmartBoxWrapper::RecvNotice_SmartBoxObjectFound @ 004e5ad0 then
 * calls ACCWeenieObject::SetSelectedObject only for a found id != 0: a press
 * on empty ground restores the lighting of the previously lit object and
 * leaves the selection (and the health meter) alone. Only Escape / the
 * deselect action clears it.
 */

/** The DOM event the select rides on: the press, as MouseDown's button 7. */
export const WORLD_SELECT_EVENT = 'mousedown';

/** MouseDown's button 7 (the left button); other buttons never select. */
export function isWorldSelectPress(e: { button: number }): boolean {
  return e.button === 0;
}

/**
 * FAITHFUL.466 — a press on the 3D world takes keyboard focus back from the
 * chat entry (the canvas is not focusable, so the browser leaves the input
 * focused and WASD would keep typing). Only the chat input is blurred, and
 * only when it has focus. Returns whether it did.
 */
export function releaseChatFocus(doc: Document): boolean {
  const chatInput = doc.getElementById('chat-input') as HTMLInputElement | null;
  if (!chatInput || doc.activeElement !== chatInput) return false;
  chatInput.blur();
  return true;
}

/**
 * The selection after an sr_Select find: the found object, or — found 0,
 * a press on nothing — the selection unchanged.
 */
export function selectionAfterFind(current: number | null, foundId: number): number | null {
  return foundId !== 0 ? foundId : current;
}
