/**
 * The keys a browser scrolls the page (or the last-clicked scroll container)
 * with. Retail panels never take keyboard focus: every key goes to the game's
 * action map, so outside a text field these keys must never scroll a panel
 * (the inventory list scrolled while the arrows walked the character).
 */
const BROWSER_SCROLL_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End', 'Space',
]);

/** A field that keeps its own keyboard behaviour (caret keys, option stepping). */
export function isKeyboardField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable === true;
}

/** True when this key press would scroll something and belongs to the game instead. */
export function suppressesBrowserScroll(code: string, active: Element | null): boolean {
  return BROWSER_SCROLL_KEYS.has(code) && !isKeyboardField(active);
}

/**
 * Retail had no right-click menu: suppress the browser's on every screen
 * (launcher, character select and creation as well as the world, where
 * CameraController.bind already did). A text field keeps it, for paste.
 */
export function suppressPageContextMenu(target: Pick<Document, 'addEventListener'>): void {
  target.addEventListener('contextmenu', (e) => {
    if (!isKeyboardField(e.target as Element | null)) e.preventDefault();
  });
}
