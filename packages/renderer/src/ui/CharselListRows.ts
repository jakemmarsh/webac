/**
 * VISUAL.charselect-name-row — the character-select list rows as the EoL
 * client builds them (gmCharacterManagementUI::RebuildCharacterList @
 * 004ec3a0).
 *
 * Each row is an item of the listbox 0x21000004:0x1000039d (160x320) made
 * from its template list (p100 → 0x100003a5, base 0x21000042:0x10000488): a
 * 160x16 text element (font 0x40000000, cream 0xfffff2cc, left / top, p35
 * left margin 6) whose three children 0x10000481 / 0x10000482 / 0x10000483
 * are the highlight's top rim (4 px), body (10 px) and bottom rim (4 px).
 * Those carry media only in state 2 / 3 (rollover / pressed, 0x06005eb4-6)
 * and 6 / 7 (selected / selected rollover, 0x06005ea7 / a9 / ab), so an
 * unselected row is the bare name on the backdrop.
 *
 * RebuildCharacterList sizes every row (SetSize(GetWidth(), h)) to
 *   h = max(H / max(numAllowedCharacters, numCharacters), H / 0x14)
 * with H the listbox height and C integer division: the rows split the box
 * between the account's slots (ACE's 11 → 29 px), never thinner than a
 * twentieth of it. The children follow the height through
 * UIElement::UpdateForParentSizeChange @ 00462640 (top rim top-fixed, body
 * stretched, bottom rim pinned to the far edge).
 */
import type { ElementDesc } from '@ac/dat-parser/file-types/LayoutDesc.js';

/** The listbox's row template as GameUI references it (descRef form). */
export const CHARSEL_ROW_TEMPLATE_LAYOUT = 0x21000004;
export const CHARSEL_ROW_TEMPLATE_ELEMENT = 0x100003a5;
/** The 0x14 floor divisor of RebuildCharacterList. */
export const CHARSEL_MIN_ROW_DIVISOR = 0x14;

/** Row states (UIElement state ids the template defines). */
export const CHARSEL_ROW_STATE_NORMAL = 0x1;
export const CHARSEL_ROW_STATE_ROLLOVER = 0x2;
export const CHARSEL_ROW_STATE_SELECTED = 0x6;
export const CHARSEL_ROW_STATE_SELECTED_ROLLOVER = 0x7;

/** RebuildCharacterList's row height for a listbox `listHeight` tall. */
export function charselRowHeight(listHeight: number, slotCount: number | undefined, numCharacters: number): number {
  const floor = Math.trunc(listHeight / CHARSEL_MIN_ROW_DIVISOR);
  const divisor = Math.max(slotCount ?? 0, numCharacters);
  if (divisor <= 0) return floor;
  return Math.max(Math.trunc(listHeight / divisor), floor);
}

/** The state a row draws in (selected wins; rollover adds one). */
export function charselRowState(selected: boolean, rollover: boolean): number {
  if (selected) return rollover ? CHARSEL_ROW_STATE_SELECTED_ROLLOVER : CHARSEL_ROW_STATE_SELECTED;
  return rollover ? CHARSEL_ROW_STATE_ROLLOVER : CHARSEL_ROW_STATE_NORMAL;
}

export interface CharselHighlightSlice {
  readonly elementId: number;
  readonly y: number;
  readonly height: number;
  /** The slice's image in the requested state, 0 when it draws nothing. */
  readonly file: number;
}

/**
 * The template's highlight slices for a row `rowHeight` tall in `state`:
 * each child's vertical span after UpdateForParentSizeChange (topEdge 2 =
 * follows the far edge, 3 = centred; bottomEdge 1 = follows the far edge,
 * 3 = centred; anything else keeps the authored coordinate), and its state
 * media (the child's own media when the state has none).
 */
export function charselHighlightSlices(template: ElementDesc, rowHeight: number, state: number): CharselHighlightSlice[] {
  const dH = rowHeight - template.height;
  const slices: CharselHighlightSlice[] = [];
  for (const [, child] of template.children) {
    const origY1 = child.y + child.height - 1;
    let y0 = child.y;
    let y1 = origY1;
    if (child.topEdge === 2) y0 = child.y + dH;
    else if (child.topEdge === 3) y0 = Math.floor(rowHeight / 2) - Math.floor(child.height / 2);
    if (child.bottomEdge === 1) y1 = origY1 + dH;
    else if (child.bottomEdge === 3) y1 = Math.floor(rowHeight / 2) - 1 + Math.floor(child.height / 2);
    const media = child.states.get(state)?.media ?? child.media;
    const file = media.find((m) => (m.file ?? 0) !== 0)?.file ?? 0;
    slices.push({ elementId: child.elementId, y: y0, height: y1 - y0 + 1, file });
  }
  return slices.sort((a, b) => a.y - b.y);
}
