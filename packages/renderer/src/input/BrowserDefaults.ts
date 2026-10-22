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
 * COMPAT.firefox-quick-find — a plain printable key outside a text field
 * belongs to the game too. Firefox opens its Quick Find bar on ' and /
 * (and, with "Search for text when you start typing" on, on ANY printable
 * key: accessibility.typeaheadfind), taking focus, so the movement keys
 * that followed went into the find bar and their keyups never reached the
 * game. Retail binds ' and / (Select Closest Monster / Player), but an
 * unbound or inactive key fell through to the browser. Ctrl / Cmd chords
 * (browser shortcuts) and the non-printing keys (F5, Tab, Escape) keep
 * their defaults. https://support.mozilla.org/kb/search-contents-current-page-text-or-links
 */
export function suppressesBrowserKeyDefault(
  e: { code: string; key?: string; ctrlKey?: boolean; metaKey?: boolean },
  active: Element | null,
): boolean {
  if (suppressesBrowserScroll(e.code, active)) return true;
  if (isKeyboardField(active) || e.ctrlKey || e.metaKey) return false;
  // A printable key's `key` is the one character it types ("Dead" / "F5" / "Tab" are names).
  return typeof e.key === 'string' && [...e.key].length === 1;
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
