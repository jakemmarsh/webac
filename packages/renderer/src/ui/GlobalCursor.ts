/**
 * GAP.ui-cursor-global — retail's cursor is one window-wide cursor.
 *
 * `ClientUISystem::UpdateCursorState` @ 00564630 resolves the UICURSOR state
 * (Default / Combat / Spellcast / Wait …) and hands it to
 * `UIElementManager::SetCursor(…, bDefault = true)` @ 0045a800, which makes it
 * the default cursor of the whole UI (Device::SetCursorFromImage = the OS
 * cursor). The client's startup (`gmClientUI` ctor, decomp ~125564) sets the
 * same Default cursor before the first screen, so it covers the pre-world
 * screens too.
 *
 * `UIElementManager::CheckCursor` @ 0045abf0 then shows, for the element
 * under the mouse (or holding capture), that element's own cursor when it
 * has one (`UIElement::SetCursor` @ 0045ff50, set only by a layout's Cursor
 * media through `MediaMachine::Update_Cursor` @ 00465a80), else the default.
 * In the EoL layouts only the window border edges carry Cursor media (the
 * resize arrows 0x06005e66 / 0x06006126 / 0x06006127 / 0x06006128 and
 * 0x06006119, hotspot 16,16). No element swaps to a browser hand on hover.
 *
 * Here: the default cursor is a CSS variable on <html> applied to every
 * element with !important (so stray inline `cursor` styles cannot win), and
 * an element with DAT Cursor media carries `data-ac-cursor` and its own
 * variable, which wins over the default by specificity.
 */

export const GLOBAL_CURSOR_VAR = '--ac-cursor';
export const ELEMENT_CURSOR_VAR = '--ac-el-cursor';
export const ELEMENT_CURSOR_ATTR = 'data-ac-cursor';
const STYLE_ID = 'ac-global-cursor';

const GLOBAL_CURSOR_RULES =
  `html, html * { cursor: var(${GLOBAL_CURSOR_VAR}, auto) !important; }\n`
  + `html [${ELEMENT_CURSOR_ATTR}] { cursor: var(${ELEMENT_CURSOR_VAR}, var(${GLOBAL_CURSOR_VAR}, auto)) !important; }`;

/** The CSS `cursor` value for a DAT cursor image (MD_Data_Cursor: file + hotspot). */
export function cursorCSS(dataUrl: string, hotX: number, hotY: number): string {
  return `url(${dataUrl}) ${hotX | 0} ${hotY | 0}, auto`;
}

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = GLOBAL_CURSOR_RULES;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * UIElementManager::SetCursor(…, true): the window-wide default cursor.
 * `css` null = the browser default (only when the DAT lookup failed).
 */
export function setGlobalCursor(css: string | null, doc: Document = document): void {
  ensureStyle(doc);
  const root = doc.documentElement;
  const value = css ?? 'auto';
  if (root.style.getPropertyValue(GLOBAL_CURSOR_VAR) === value) return;
  root.style.setProperty(GLOBAL_CURSOR_VAR, value);
}

/** The current default cursor value ('' before the first set). */
export function currentGlobalCursor(doc: Document = document): string {
  return doc.documentElement.style.getPropertyValue(GLOBAL_CURSOR_VAR);
}

/**
 * UIElement::SetCursor / UnSetCursor — an element's own cursor from its
 * layout Cursor media (`css` null = UnSetCursor, back to the default).
 */
export function setElementCursor(el: HTMLElement, css: string | null): void {
  ensureStyle(el.ownerDocument);
  if (css) {
    el.setAttribute(ELEMENT_CURSOR_ATTR, '');
    el.style.setProperty(ELEMENT_CURSOR_VAR, css);
  } else {
    el.removeAttribute(ELEMENT_CURSOR_ATTR);
    el.style.removeProperty(ELEMENT_CURSOR_VAR);
  }
}
