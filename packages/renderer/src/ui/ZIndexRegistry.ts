/**
 * ZLayer — centralized z-index tier registry for ACJS UI.
 *
 * All z-index values in the renderer MUST come from this registry.
 * This prevents panel overlap bugs caused by scattered hardcoded values.
 *
 * Tier design:
 * - Game canvas is at z:0
 * - HUD elements (vitals, radar, chat) are at fixed low tiers
 * - Floating panels (inventory, character, spellbook) get dynamic z from LayoutRenderer.panelZCounter
 * - Overlays (loading, death, tooltips, context menus) are at high tiers
 * - Modals (confirmation dialogs) are highest
 */

export const ZLayer = {
  /** Three.js canvas */
  GAME_CANVAS: 0,

  /**
   * CORE.17.k.c.a.a.a — the spew strip (gmSpewBoxUI, layout 0x21000011) is
   * a child of the 3D-view region (0x2100000f pane 0x10000046), and in the
   * gameplay screen 0x21000005 that region (0x1000049a, base 0x10000037)
   * INHERITS zLevel 9999 — the highest of all the root's children. Retail
   * UIRegion::AddChild @ 006a0760 keeps children sorted descending by
   * m_zlevel (comparator = vtable slot +0x38 = UIRegion::CompareZLevel
   * @ 0069f000) and UIRegion::DrawChildren @ 0069fca0 paints head → tail,
   * so the 3D view and everything inside it — the spew rows included —
   * paints FIRST, under every floaty window; UIRegion::BringToFront
   * @ 006a07f0 refuses to move a child past a lower-z sibling, so a click on
   * the 3D view never lifts it. The strip is therefore the back-most HUD
   * tier: the vitals plate (z 0) draws over the rows it overlaps.
   */
  HUD_SMARTBOX_STRIP: 1,

  /**
   * CORE.17.o.c — the external-container strip (gmExternalContainerUI,
   * layout 0x21000008 root 0x10000063: 800x110 at (0,400), DAT zLevel 1000).
   * By the same descending-zLevel paint order it draws AFTER the 3D view
   * (9999) but BEFORE the chat band (900), the toolbar (901) and every
   * z-0 floaty window — so an open pack window covers the strip, and where
   * the strip's y 400..510 meets the chat band's top edge (y 500 at the
   * 600-tall minimum) the chat art is on top. Between the 3D-view strip
   * (1) and the chat band (8).
   */
  HUD_CONTAINER_STRIP: 5,

  /**
   * The floaty vitals windows (0x2100006c stacked / 0x21000075 side-by-side,
   * zLevel 0 in the DAT → drawn after the 3D view). Same value the other
   * hand-placed HUD windows use; above the 3D-view strip, below the panels.
   */
  HUD_FLOATY_VITALS: 10,

  /**
   * CORE.11.a — the classic_chat bottom band (#hud-chat). The container
   * carries an explicit z-index so it forms its own CSS stacking context.
   * (It first existed to scope the DAT zLevel=900 of the band root,
   * 0x21000006 el 0x1000000e, which LayoutRenderer used to apply verbatim
   * as a CSS z-index; since BUG.layout-zlevel-semantics-inverted no DAT
   * zLevel becomes a z-index — LayoutRenderer carries the retail order as
   * DOM order — and this tier alone places the band.) Retail zLevel semantics are the
   * INVERSE of CSS z-index: UIRegion::AddChild keeps children sorted
   * descending by m_zlevel, UIRegion::DrawChildren paints head→tail, and
   * UIRegion::BringToFront moves a window tail-ward — so a HIGHER zLevel
   * draws EARLIER, i.e. sits further BACK. The chat band's 900 makes it the
   * furthest-back bottom surface; before this tier existed, the leaked 900
   * beat the combat bar's z and its opaque band art cut off the bottom half
   * of the "Repeat Attacks" checkbox row (combat bar y=493-507 vs chat band
   * top edge at y=500).
   */
  HUD_CHAT_BAND: 8,

  /**
   * CORE.11.a — melee/missile combat bar band (classic_combat 0x21000007
   * root 0x1000004b, zLevel 0 in the DAT). Retail draws it over the chat
   * band (zLevel 900 = further back, see HUD_CHAT_BAND); rawg_02 shows the
   * checkbox row fully legible with the chat log art behind/below it.
   */
  HUD_COMBAT_BAR: 9,

  /** HUD frame backgrounds */
  HUD_BACKGROUND: 400,

  /**
   * BUG.portal-tunnel-hides-hud — the portal-space tunnel. Retail draws it in
   * the portal-space viewport 0x10000436, a child of the 3D-view layout
   * 0x2100000f, whose region inherits zLevel 9999 in the gameplay screen
   * 0x21000005: the back-most child, painted first (see HUD_SMARTBOX_STRIP).
   * So the tunnel replaces only the WORLD. It covers the world canvas and
   * the world-projected overlays (floating text, name labels), and every
   * HUD window (vitals, radar, chat, toolbar, the spew strip) paints over it
   * (real EoR exe under Wine: verification/bug-spew-under-vitals/retail-portal-*.png).
   * Sits just below HUD_CONTENT, the #game-hud stacking context.
   */
  PORTAL_TUNNEL: 450,

  /** HUD content (vitals, radar, chat) */
  HUD_CONTENT: 500,

  /**
   * Bottom-right toolbar (combat mode + panel toggles + shortcut slots).
   * Must exceed 900: the chat layout's root element (0x21000006 el
   * 0x1000000e, the full-width bottom bar) carries zLevel=900 in the DAT,
   * which LayoutRenderer applied verbatim as a CSS z-index until
   * BUG.layout-zlevel-semantics-inverted (it no longer leaks; the tier
   * value is kept so the HUD tiers' relative order is unchanged). Retail draws the
   * toolbar ON TOP of that bar (layout compose order); with the toolbar at
   * z-auto the opaque chat bar swallowed the shortcut rows (VISUAL.4).
   */
  HUD_TOOLBAR: 901,

  /**
   * Bottom-band bars (vendor/salvage — classic_vendor 0x21000012 authors
   * the 800x110 vendor bar AT y=500, i.e. ON the chat band): retail
   * composes these UIs after the HUD, drawing them over the chat bar
   * (zLevel 900) and toolbar (901). Floating panels still stack above.
   */
  HUD_BOTTOM_BAR: 950,

  /** Starting z for floating panels (LayoutRenderer.panelZCounter) */
  PANEL_BASE: 1000,

  /** Cap for panel z-ordering */
  PANEL_MAX: 1999,

  /** Tooltips and examine popups */
  TOOLTIP: 2000,

  /** Right-click context menus (above tooltips) */
  CONTEXT_MENU: 2500,

  /** Loading screen overlay */
  LOADING_SCREEN: 5000,

  /** Death/vitae screen */
  DEATH_SCREEN: 5000,

  /** Modal dialog backdrop */
  MODAL_BACKDROP: 8000,

  /** Modal dialog content */
  MODAL_CONTENT: 8500,

  /** Debug/dev overlays */
  DEBUG_OVERLAY: 9999,

  /** Dragged item ghost */
  DRAG_GHOST: 100000,
} as const;

/** Get a z-index string for CSS usage. */
export function zLayer(tier: number): string {
  return tier.toString();
}
