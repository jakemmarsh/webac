/**
 * CORE.17.k.b.b.a — a UIElement_Text's drawing style read straight from its
 * (resolved) LayoutDesc element: the font (p26), the colour (p27), the
 * justification pair (p20/p21), the margins (p35–p38) and the outline pair
 * (p33/p34, see TextOutline.ts).
 *
 * Property application order mirrors `UIElement_Text::OnSetAttribute @
 * 0046a640` being called once per property as the element is built from its
 * desc and again for each property of a state it enters (SetMediaState): the
 * element's own properties first, then its default state's, then the
 * requested state's — a later set overrides an earlier one per property id.
 *
 * p26 / p27 are ARRAY properties in the DAT (a font list and a colour table —
 * `UIElement_Text::AppendStringInfoWithFont @ 00469de0` indexes the colour
 * table by text type); a plain text element draws with entry 0.
 *
 * The pre-world screens (char select 0x21000004, the chargen pages
 * 0x21000038 / 0x21000046–0x2100004c) are drawn by GameUI itself, with the
 * layouts only providing chrome, so their labels are described here by a
 * `data-ac-desc` reference ("<layout>:<element>[/<child>…]") that
 * GameUI.replaceACTextElements resolves through LayoutRenderer.
 */
import type { BaseProperty, ElementDesc, LayoutDescData, StateDesc } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { TEXT_OUTLINE_PROPERTY, TEXT_OUTLINE_COLOR_PROPERTY, DEFAULT_TEXT_OUTLINE_ARGB } from './TextOutline.js';

/** p26 (0x1a): the font list — entry 0 is the element's font DID. */
export const TEXT_FONT_PROPERTY = 26;
/** p27 (0x1b): the colour table — entry 0 is the plain-text colour (ARGB). */
export const TEXT_COLOR_PROPERTY = 27;
/** p20 (0x14) / p21 (0x15): SetHorizontalJustification / SetVerticalJustification. */
export const TEXT_HJUSTIFY_PROPERTY = 20;
export const TEXT_VJUSTIFY_PROPERTY = 21;
/** p35–p38: left / right / top / bottom margins (CalcJustification's near-edge offsets). */
export const TEXT_MARGIN_LEFT_PROPERTY = 35;
export const TEXT_MARGIN_RIGHT_PROPERTY = 36;
export const TEXT_MARGIN_TOP_PROPERTY = 37;
export const TEXT_MARGIN_BOTTOM_PROPERTY = 38;

/** The UI font (Font::Get 0x40000000) — what a text element draws with when no p26 reaches it. */
export const DEFAULT_TEXT_FONT_DID = 0x40000000;
/** White — the colour a text element draws with when no p27 reaches it. */
export const DEFAULT_TEXT_COLOR_ARGB = 0xffffffff;
/** CalcJustification @ 00467260: anything but 1 (centre) / 3, 5 (far) is the near edge. */
export const DEFAULT_TEXT_JUSTIFY = 2;

/** UIElement state ids the pre-world carriers switch their colour on. */
export const UI_STATE_NORMAL = 0x1;
export const UI_STATE_HOVER = 0x2;
export const UI_STATE_PRESSED = 0x3;
export const UI_STATE_DISABLED = 0xd;
/**
 * CORE.17.k.b.b.c.c — the state a toggle button (p11) enters while its 0xe
 * "selected" flag is set: `UIElement_Button::SetState @ 00471da0` turns
 * SetState(6) / SetState(1) into the flag, `UpdateState_ @ 00471cf0` then
 * enters state 6 (+1 rollover / +2 pressed) — the chargen progress tabs'
 * open page (gmCharGenMainUI::SetProgressState @ 004e7a10).
 */
export const UI_STATE_SELECTED = 0x6;
/** The chargen radio-row templates (0x2100004c:0x100002db / 0x100002e8): unselected / selected. */
export const CHARGEN_ROW_STATE_UNSELECTED = 0x10000016;
export const CHARGEN_ROW_STATE_SELECTED = 0x10000017;

export interface DatTextStyle {
  readonly font: number;
  /** Entry 0 of the p27 colour table — the plain-text colour. */
  readonly colorArgb: number;
  /**
   * CORE.17.k.b.b.c.c — the whole p27 colour table: `UIElement_Text::
   * SetTextWithFont / AppendTextWithFont` take a colour-table index (the
   * stat footer title's value run is entry 1 green while buffed, 2 red
   * while debuffed — gmAttributeUI::DisplaySelectionFooter_Attribute @
   * 0049d280; the house page rows' HousePanelTextColor 0 / 1 / 2).
   */
  readonly colorTable: readonly number[];
  readonly hJustify: number;
  readonly vJustify: number;
  readonly outline: boolean;
  readonly outlineColorArgb: number;
  readonly marginLeft: number;
  readonly marginRight: number;
  readonly marginTop: number;
  readonly marginBottom: number;
}

type PropertySet = ReadonlyMap<number, BaseProperty> | null | undefined;

const firstDataFile = (p: BaseProperty | undefined): number | undefined => {
  if (!p) return undefined;
  if (typeof p.valueDataFile === 'number') return p.valueDataFile;
  const first = p.valueArray?.[0];
  return typeof first?.valueDataFile === 'number' ? first.valueDataFile : undefined;
};
const firstColor = (p: BaseProperty | undefined): number | undefined => {
  if (!p) return undefined;
  if (typeof p.valueColor === 'number') return p.valueColor;
  const first = p.valueArray?.[0];
  return typeof first?.valueColor === 'number' ? first.valueColor : undefined;
};
/** Every entry of a p27 colour table (a scalar colour is a one-entry table). */
const allColors = (p: BaseProperty | undefined): number[] | undefined => {
  if (!p) return undefined;
  if (typeof p.valueColor === 'number') return [p.valueColor];
  const table = (p.valueArray ?? [])
    .map((entry) => entry.valueColor)
    .filter((c): c is number => typeof c === 'number');
  return table.length > 0 ? table : undefined;
};
const intOf = (p: BaseProperty | undefined): number | undefined => {
  if (!p) return undefined;
  const n = p.valueInt ?? p.valueEnum;
  return typeof n === 'number' ? n : undefined;
};

/** The p27 colour (entry 0 of the colour table) a property set carries, if any. */
export function textColorFromProps(props: PropertySet): number | undefined {
  return props ? firstColor(props.get(TEXT_COLOR_PROPERTY)) : undefined;
}

/**
 * The style after applying each property set in order (element desc, then
 * the default state, then any further state entered).
 */
export function textStyleFromProps(...propertySets: PropertySet[]): DatTextStyle {
  let font = DEFAULT_TEXT_FONT_DID;
  let colorArgb = DEFAULT_TEXT_COLOR_ARGB;
  let colorTable: readonly number[] = [DEFAULT_TEXT_COLOR_ARGB];
  let hJustify = DEFAULT_TEXT_JUSTIFY;
  let vJustify = DEFAULT_TEXT_JUSTIFY;
  let outline = false;
  let outlineColorArgb = DEFAULT_TEXT_OUTLINE_ARGB;
  let marginLeft = 0; let marginRight = 0; let marginTop = 0; let marginBottom = 0;
  for (const props of propertySets) {
    if (!props) continue;
    const f = firstDataFile(props.get(TEXT_FONT_PROPERTY)); if (f !== undefined) font = f;
    const table = allColors(props.get(TEXT_COLOR_PROPERTY)); if (table) { colorTable = table; colorArgb = table[0]; }
    const h = intOf(props.get(TEXT_HJUSTIFY_PROPERTY)); if (h !== undefined) hJustify = h;
    const v = intOf(props.get(TEXT_VJUSTIFY_PROPERTY)); if (v !== undefined) vJustify = v;
    const o = props.get(TEXT_OUTLINE_PROPERTY); if (o && typeof o.valueBool === 'boolean') outline = o.valueBool;
    const oc = firstColor(props.get(TEXT_OUTLINE_COLOR_PROPERTY)); if (oc !== undefined) outlineColorArgb = oc;
    const ml = intOf(props.get(TEXT_MARGIN_LEFT_PROPERTY)); if (ml !== undefined) marginLeft = ml;
    const mr = intOf(props.get(TEXT_MARGIN_RIGHT_PROPERTY)); if (mr !== undefined) marginRight = mr;
    const mt = intOf(props.get(TEXT_MARGIN_TOP_PROPERTY)); if (mt !== undefined) marginTop = mt;
    const mb = intOf(props.get(TEXT_MARGIN_BOTTOM_PROPERTY)); if (mb !== undefined) marginBottom = mb;
  }
  return { font, colorArgb, colorTable, hJustify, vJustify, outline, outlineColorArgb, marginLeft, marginRight, marginTop, marginBottom };
}

/** The desc shape needed here: an ElementDesc, or anything carrying properties + states. */
export interface TextStyleDescLike {
  properties: ReadonlyMap<number, BaseProperty>;
  states?: ReadonlyMap<number, { properties: ReadonlyMap<number, BaseProperty> }>;
  defaultState?: number;
}

/**
 * The style of a (resolved) element in a given state: the element's own
 * properties, then its default state's, then `stateId`'s when one is given
 * (an unknown state id contributes nothing, like SetMediaState on a state
 * the desc does not define).
 */
export function textStyleFromDesc(desc: TextStyleDescLike, stateId?: number): DatTextStyle {
  const sets: PropertySet[] = [desc.properties];
  if (desc.defaultState && desc.states) sets.push(desc.states.get(desc.defaultState)?.properties);
  if (stateId !== undefined && stateId !== desc.defaultState && desc.states) sets.push(desc.states.get(stateId)?.properties);
  return textStyleFromProps(...sets);
}

/** A DAT ARGB colour → CSS hex (`#rrggbb`; every colour these carriers use is opaque). */
export function cssFromArgb(argb: number): string {
  return '#' + ((argb >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}

/**
 * Locate an element in a layout by id path: the first element (depth-first,
 * document order) whose id is `path[0]`, then each further id as a direct
 * child of the previous one. Shared child ids (the 0x100002ed attribute
 * label appears once per attribute row) are disambiguated by leading with
 * the row's id.
 */
export function findElementByPath(layout: LayoutDescData | null | undefined, path: readonly number[]): ElementDesc | null {
  if (!layout || path.length === 0) return null;
  const findAnywhere = (el: ElementDesc, id: number): ElementDesc | null => {
    if (el.elementId === id) return el;
    for (const [, child] of el.children) {
      const hit = findAnywhere(child, id);
      if (hit) return hit;
    }
    return null;
  };
  let node: ElementDesc | null = null;
  for (const [, el] of layout.elements) {
    node = findAnywhere(el, path[0]);
    if (node) break;
  }
  for (let i = 1; node && i < path.length; i++) node = node.children.get(path[i]) ?? null;
  return node;
}

/** A `data-ac-desc` reference: "<layoutHex>:<elementHex>[/<childHex>…]" (with or without 0x). */
export interface DescRef { layoutId: number; path: number[] }

export function descRef(layoutId: number, ...path: number[]): string {
  return `${layoutId.toString(16)}:${path.map((id) => id.toString(16)).join('/')}`;
}

export function parseDescRef(ref: string | undefined | null): DescRef | null {
  if (!ref) return null;
  const m = /^(?:0x)?([0-9a-f]+):((?:0x)?[0-9a-f]+(?:\/(?:0x)?[0-9a-f]+)*)$/i.exec(ref.trim());
  if (!m) return null;
  const layoutId = parseInt(m[1], 16);
  const path = m[2].split('/').map((s) => parseInt(s, 16));
  if (!Number.isFinite(layoutId) || path.some((n) => !Number.isFinite(n))) return null;
  return { layoutId, path };
}

/** A `data-ac-state` value: a hex state id (with or without 0x). */
export function parseStateRef(ref: string | undefined | null): number | undefined {
  if (!ref) return undefined;
  const n = parseInt(ref.trim(), 16);
  return Number.isFinite(n) ? n : undefined;
}
