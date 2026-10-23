/**
 * CORE.17.k.b.b.a.g.a — the 3D view's hover tooltip.
 *
 * UIElement_SmartBoxWrapper::MouseMove @ 004e56c0 → FindObject (sr_MouseOver)
 * → SmartBox::set_found_object → RecvNotice_SmartBoxObjectFound @ 004e5ad0:
 * when the object under the mouse CHANGES, with an object there and
 * PlayerModule::ShowTooltips on, the wrapper element (0x2100000f:0x10000037,
 * root 0x10000395 in p71) gets SetTooltip(GetObjectName(NAME_APPROPRIATE)) +
 * the SetTooltipOn bit — so the name shows at the mouse after the usual
 * m_tooltipDelay through UIElementManager's machine (immediately, through
 * ResetTooltip + StartTooltipAtMouse(0), only while a drag is in progress);
 * nothing under the mouse, or the option off → the bit cleared + ClearTooltip.
 * Retail draws NO overhead label for the hovered object: the tooltip IS the
 * "3D tooltip" the Show 3D Tooltips option (ACE CharacterOptions1.ShowTooltips)
 * names.
 */
export function worldHoverTooltipText(hit: { name?: string } | null | undefined, showTooltips: boolean, hint: string | null = null): string | null {
  if (!hit || !showTooltips) return null;
  const name = hit.name ?? '';
  if (name === '') return null;
  // 1999 (PW-10): the help bar's second line, the double-click hint (HudTooltips.worldHoverHint1999).
  return hint ? `${name}\n${hint}` : name;
}
