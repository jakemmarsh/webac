/**
 * CORE.17.s.a — the chat log's row geometry, the way the retail
 * UIElement_Text lays its glyph list out (decompiled EoL client,
 * docs/retail-client-symbols.md CORE.17.s.a):
 *
 * - Row pitch: `Glyph::SetFont @ 004749a0` gives every glyph
 *   `m_height = Font::maxCharHeight`; `GlyphList::Recalculate @ 00473800`
 *   closes each GlyphLine with `m_nLineHeight` = the tallest glyph on it, and
 *   `UIElement_Text::DrawSelf @ 00467aa0` advances y by exactly that
 *   (`local_c0 += m_nLineHeight`). No leading, no per-message gap: the
 *   default chat font 0x40000000 (Palatino_Linotype_16) packs 16 px rows.
 * - Message separation: `ChatInterface::RecvNotice_DisplayFinalStringInfo
 *   @ 004f4640` appends ONE "\n" glyph before every message after the
 *   first, and `ClientSystem::AddTextToScroll @ 00563c50` runs
 *   `PStringBase::trim(text, true, true, "\n")` on the message first, so
 *   ACE's trailing "\n" (WorldManager.cs:267) never becomes an empty row.
 * - Margins: `UIElement_Text::OnSetAttribute @ 0046a640` cases 0x23/0x24/
 *   0x25/0x26 → m_margL / m_margR / m_margU / m_margD (p35..p38). The chat
 *   log text desc 0x2100006f:0x10000011 carries p35 = p36 = 2 and no p37/p38.
 * - Scroll step: `UIElement_Text::InqScrollDelta @ 004689b0` steps the
 *   current line's `GlyphList::GetGlyphLineHeight` (capped at the element
 *   height) — one row of the current chat font.
 */
import type { LayoutDescData } from '@ac/dat-parser/file-types/LayoutDesc.js';

/** The main / floaty chat log's text desc (UIElement_Text). */
export const CHAT_LOG_TEXT_ELEMENT_ID = 0x10000011;

/** Font 0x40000000 (Chat_PalatinoLinotype_Small) maxCharHeight — the row pitch when no chat font is loaded. */
export const RETAIL_DEFAULT_CHAT_ROW_PX = 16;

/** The chat log desc's p35..p38 when the layout cannot be read (0x2100006f:0x10000011). */
export const RETAIL_CHAT_LOG_MARGINS: ChatLogMargins = { left: 2, right: 2, top: 0, bottom: 0 };

/** UIElement_Text p35 / p36 / p37 / p38 property numbers → OnSetAttribute cases 0x23..0x26. */
export const TEXT_MARGIN_PROPERTIES = { left: 35, right: 36, top: 37, bottom: 38 } as const;

export interface ChatLogMargins { left: number; right: number; top: number; bottom: number }

interface ElementLike {
  properties?: Map<number, { valueInt?: number }>;
  children?: Map<number, ElementLike>;
}

interface LayoutLike {
  elements: Map<number, ElementLike>;
}

/** Depth-first search of a LayoutDesc's element tree (elements hold only the roots; descendants sit in `children`). */
export function findLayoutElement(layout: LayoutLike | LayoutDescData | null | undefined, elementId: number): ElementLike | null {
  const roots = (layout as LayoutLike | null | undefined)?.elements;
  if (!roots) return null;
  const stack: ElementLike[] = [];
  const direct = roots.get(elementId);
  if (direct) return direct;
  for (const el of roots.values()) stack.push(el);
  while (stack.length) {
    const el = stack.pop()!;
    const kids = el.children;
    if (!kids) continue;
    const hit = kids.get(elementId);
    if (hit) return hit;
    for (const k of kids.values()) stack.push(k);
  }
  return null;
}

/**
 * The text desc's margins (m_margL/R/U/D) read from its p35..p38; a missing
 * property is 0 like the UIElement_Text ctor's defaults. Without a layout
 * (no DAT, a stubbed renderer) the retail chat desc's own values are used.
 */
export function chatLogMarginsFromLayout(
  layout: LayoutLike | LayoutDescData | null | undefined,
  elementId: number = CHAT_LOG_TEXT_ELEMENT_ID,
): ChatLogMargins {
  const el = findLayoutElement(layout, elementId);
  if (!el) return { ...RETAIL_CHAT_LOG_MARGINS };
  const props = el.properties;
  const read = (p: number): number => {
    const v = props?.get(p)?.valueInt;
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0;
  };
  return {
    left: read(TEXT_MARGIN_PROPERTIES.left),
    right: read(TEXT_MARGIN_PROPERTIES.right),
    top: read(TEXT_MARGIN_PROPERTIES.top),
    bottom: read(TEXT_MARGIN_PROPERTIES.bottom),
  };
}

/** CSS `padding` shorthand for the log viewport (top right bottom left). */
export function chatLogPaddingCss(m: ChatLogMargins): string {
  return `${m.top}px ${m.right}px ${m.bottom}px ${m.left}px`;
}

/**
 * ClientSystem::AddTextToScroll's `trim(text, true, true, "\n")`: only
 * newline characters come off the ends; interior "\n" (and "\n\n" blank
 * rows) stay, and so does every other leading/trailing character.
 */
export function trimChatMessageNewlines(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === 0x0a) start++;
  while (end > start && text.charCodeAt(end - 1) === 0x0a) end--;
  return text.slice(start, end);
}

/** One row of the current chat font — InqScrollDelta's GetGlyphLineHeight. */
export function chatLogScrollStep(renderer: { lineHeight: number } | null | undefined): number {
  const h = renderer?.lineHeight;
  return typeof h === 'number' && h > 0 ? h : RETAIL_DEFAULT_CHAT_ROW_PX;
}
