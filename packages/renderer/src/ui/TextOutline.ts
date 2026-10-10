/**
 * CORE.17.k.b.b — UIElement_Text's outline pair as LayoutDesc properties.
 *
 * `UIElement_Text::OnSetAttribute @ 0046a640`: case 0x21 (p33) →
 * `SetOutline @ 00466630` (`m_bitField |= 0x10`); case 0x22 (p34) →
 * `m_curOutlineColor = RGBAColor::GetColor32(...)`, seeded from
 * `RGBAColor_Black`, so a p33 without a p34 outlines in black.
 * `UIElement_Button::OnSetAttribute @ 00471f40` chains to
 * `UIElement_Text::OnSetAttribute` before its own switch, so button labels
 * honour the pair too. A state's properties are applied through the same
 * OnSetAttribute when the element enters that state (SetMediaState), so a
 * state-level p33 (e.g. the spew item template 0x21000011:0x1000004a, state
 * 0x10000002) outlines the element while it is in that state.
 *
 * `UIElement_Text::DrawSelf @ 00467aa0` then runs two passes for an outlined
 * element: pass 0 blits each glyph's halo from the font's BACKGROUND sheet
 * tinted with the outline colour (`SurfaceWindow::DrawCharacter` mode
 * 0x7000), or the glyph at the eight ±1px neighbours when the font has no
 * background surface (mode 0x9000); pass 1 is the glyph itself. See
 * docs/retail-client-symbols.md (CORE.17.k.b.a / CORE.17.k.b.b).
 */
import type { BaseProperty } from '@ac/dat-parser/file-types/LayoutDesc.js';

/** p33 (0x21): outline on/off → UIElement_Text::SetOutline. */
export const TEXT_OUTLINE_PROPERTY = 33;
/** p34 (0x22): outline colour (ARGB) → UIElement_Text::m_curOutlineColor. */
export const TEXT_OUTLINE_COLOR_PROPERTY = 34;
/** RGBAColor_Black — the seed of m_curOutlineColor. */
export const DEFAULT_TEXT_OUTLINE_ARGB = 0xff000000;

/** A DAT ARGB colour property → CSS hex (the alpha of every p34 in the DAT is 0xff). */
export function outlineCssFromArgb(argb: number): string {
  return '#' + ((argb >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}

type PropertySet = ReadonlyMap<number, BaseProperty> | null | undefined;

/**
 * The outline colour a text element draws with, from its property sets in
 * application order (element desc first, then the state it is in — a later
 * set overrides an earlier one per property id, the way SetAttribute
 * replaces a property). `undefined` when the element is not outlined.
 */
export function outlineColorFromProps(...propertySets: PropertySet[]): string | undefined {
  let outline: boolean | undefined;
  let colorArgb: number | undefined;
  for (const props of propertySets) {
    if (!props) continue;
    const p33 = props.get(TEXT_OUTLINE_PROPERTY);
    if (p33 && typeof p33.valueBool === 'boolean') outline = p33.valueBool;
    const p34 = props.get(TEXT_OUTLINE_COLOR_PROPERTY);
    if (p34 && typeof p34.valueColor === 'number') colorArgb = p34.valueColor;
  }
  if (!outline) return undefined;
  return outlineCssFromArgb(colorArgb ?? DEFAULT_TEXT_OUTLINE_ARGB);
}

/** The shape LayoutRenderer hands around: an ElementDesc (states + defaultState) or a bare StateDesc. */
export interface OutlineDescLike {
  properties: ReadonlyMap<number, BaseProperty>;
  states?: ReadonlyMap<number, { properties: ReadonlyMap<number, BaseProperty> }>;
  defaultState?: number;
}

/**
 * The outline colour for a (resolved) element desc in its default state:
 * the element's own properties, then the default state's.
 */
export function outlineColorForDesc(desc: OutlineDescLike | null | undefined): string | undefined {
  if (!desc) return undefined;
  const state = desc.defaultState && desc.states ? desc.states.get(desc.defaultState) : undefined;
  return outlineColorFromProps(desc.properties, state?.properties);
}
