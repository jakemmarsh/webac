/**
 * Drive an Options-panel UIOption_Menu the way a player does: a click on the
 * field opens the popup list (GameUI.openOptionsMenu), a click on a row picks
 * it (UIOption_Menu::ListenToElementMessage @ 00483da0, message 7).
 */

/** Open the menu on `field` and pick the row after the current value (wrapping). */
export function pickNextMenuValue(doc: Document, field: HTMLElement): void {
  field.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('click', { bubbles: true }));
  const rows = Array.from(doc.querySelectorAll<HTMLElement>('[data-options-menu-row]'));
  if (rows.length === 0) throw new Error('options menu did not open');
  const i = rows.findIndex((r) => r.dataset.current === '1');
  rows[(i + 1) % rows.length].click();
}

/** Open the menu on `field` and pick the row showing `value`. */
export function pickMenuValue(doc: Document, field: HTMLElement, value: string): void {
  field.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('click', { bubbles: true }));
  const row = doc.querySelector<HTMLElement>(`[data-options-menu-row="${value}"]`);
  if (!row) throw new Error(`options menu has no row "${value}"`);
  row.click();
}
