/**
 * CORE.18.e — the EoL right-side panels window (gmFloatyPanelUI).
 *
 * The root HUD 0x21000005 carries the panels window in slot 0x100005ff:
 * (490,128) 310x372 of the 800x600 design, edges L2 T2 R1 B1 — right- and
 * bottom-flush at native size, its bottom 600 − (128 + 372) = 100 px above
 * the screen's (= riding the top of the 310x100 toolbar window 0x10000603 at
 * (490,500), same edges). WindowID (attribute 0x1000007e on the slot) = 9.
 * The slot is based on 0x2100006e:0x100005fe (element class 0x1000004f,
 * gmFloatyPanelUI): a 5 px frame (locked art 0x10000653-0x1000065a, textures
 * 0x060074bf-c6; interactive Dragbar/Resizebar set 0x1000065b-0x10000662)
 * round the body 0x10000180 at (5,5) 300x362, which stacks every panel
 * (inventory 0x1000018b → 0x21000023:0x100001cc, spellbook, character, …)
 * at 300x362 L1T1R1B1 — gmPanelUI::RecvNotice_SetPanelVisibility @ 004bc6f0
 * shows one at a time and never resizes the window. The root's size props
 * fix the width (p63 = p61 = 310) and let the height run 372..1000
 * (p62 / p60).
 *
 * Where the window opens — gmFloatyPanelUI::UpdateFromPlayerModule @
 * 004d1d20: unless the UI layout came from a file, a persisted position
 * (chat-window options 0x10000086/87 under WindowID 9) goes through MoveTo
 * @ 004d20b0 (clamped x ∈ [0, screenW − w], y ∈ [0, screenH − h]) and a
 * persisted size (0x10000088/89) through ResizeTo @ 004d1f40 →
 * gmPanelUI::ResizeTo @ 004bc6e0 (clamped to the p60..p63 limits). With
 * nothing persisted the slot's own edges place it: a fresh profile at
 * 1600x900 gets the window at (1290,428) and the inventory body at
 * (1295,433) 300x362 — three pack rows under a scrollbar, exactly the
 * retail capture (verification/retail-client/ab/retail-inventory-vendor.png:
 * y 432–795).
 */

export const PANELS_WINDOW = {
  hudLayout: 0x21000005, hudSlot: 0x100005ff,
  windowLayout: 0x2100006e, window: 0x100005fe,
  /** The body every panel is stacked in, at (5,5). */
  body: 0x10000180,
  /**
   * The window root 0x100005fe's own media (type 5, drawMode 1): the
   * uniform-black alpha-175 tile 0x06004cc2, the scrim every stacked panel
   * draws over. Retail composites it over the live 3D world. The EoL Wine
   * frame retail-options-gameplay.png measures the options body at 24/22/9
   * beside 74/69/29 grass: 0.31 of the world = (255 - 175) / 255.
   */
  fill: 0x06004cc2,
  /** The inventory's slot in the body (0x21000023:0x100001cc). */
  inventorySlot: 0x1000018b,
  /** The HUD slot's authored size; its right edge is flush, its bottom 100 px up. */
  width: 310, height: 372, right: 0, bottom: 100,
  /** The body's rect inside the window (the 5 px frame round it). */
  bodyRect: { x: 5, y: 5, w: 300, h: 362 },
  /** WindowID (attribute 0x1000007e on the HUD slot 0x100005ff). */
  windowId: 9,
  /** The root's p62 / p60 height limits (the width is fixed: p63 = p61 = 310). */
  minHeight: 372, maxHeight: 1000,
} as const;

/** A persisted panels-window rect (chat-window options 0x10000086-89 under WindowID 9). */
export interface PanelsWindowGeometry { x?: number; y?: number; w?: number; h?: number }

/** The window's rect and the body's (where the current panel draws), in HUD design px. */
export interface PanelsWindowPlacement {
  x: number; y: number; w: number; h: number;
  body: { x: number; y: number; w: number; h: number };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Where the panels window opens on a `screenW` x `screenH` HUD: the persisted
 * height clamped to p62..p60, the persisted position clamped as MoveTo
 * clamps it; without a persisted position the slot's L2/T2 edges pin it
 * right-flush and 100 px above the bottom.
 */
export function panelsWindowPlacement(geo: PanelsWindowGeometry, screenW: number, screenH: number): PanelsWindowPlacement {
  const P = PANELS_WINDOW;
  const w: number = P.width;
  let h: number = P.height;
  if (finite(geo.h)) h = Math.round(Math.max(P.minHeight, Math.min(P.maxHeight, geo.h)));
  let x = screenW - P.right - w;
  let y = screenH - P.bottom - h;
  if (finite(geo.x) && finite(geo.y)) {
    x = geo.x;
    y = geo.y;
  }
  x = Math.round(Math.max(0, Math.min(x, screenW - w)));
  y = Math.round(Math.max(0, Math.min(y, screenH - h)));
  const B = P.bodyRect;
  return { x, y, w, h, body: { x: x + B.x, y: y + B.y, w: B.w, h: h - (P.height - B.h) } };
}

/**
 * A panel stacked in the panels-window body. `returnsToPrevious` is the
 * panel element's attribute 0x10000049: when it displaces a panel that
 * lacks the flag, that panel shows again once it hides.
 */
export interface PanelsWindowPanel { readonly returnsToPrevious: boolean }

/** The body's one visible panel, and the one to restore when it hides. */
export interface PanelsWindowSlotState<T extends PanelsWindowPanel> {
  current: T | null;
  returnTo: T | null;
}

/**
 * gmPanelUI::RecvNotice_SetPanelVisibility @ 004bc6f0: showing a panel
 * hides the current one (CM_UI::SendNotice_SetPanelVisibility(id, false)),
 * remembering it only when the newcomer carries 0x10000049 and it does not;
 * hiding the current panel shows the remembered one. Hiding a panel that is
 * not current changes nothing. The window never resizes.
 */
export function setPanelsWindowPanelVisibility<T extends PanelsWindowPanel>(
  state: PanelsWindowSlotState<T>, panel: T, show: boolean,
): PanelsWindowSlotState<T> {
  if (show) {
    if (state.current === panel) return state;
    let returnTo: T | null = null;
    if (state.current) {
      returnTo = panel.returnsToPrevious && !state.current.returnsToPrevious ? state.current : null;
    } else {
      returnTo = state.returnTo;
    }
    return { current: panel, returnTo };
  }
  if (state.current !== panel) return state;
  if (state.returnTo) return { current: state.returnTo, returnTo: null };
  return { current: null, returnTo: null };
}

/** A panels-window panel we drive: our key, its body slot, and its 0x10000049. */
export interface PanelsWindowSlotPanel extends PanelsWindowPanel { readonly key: string; readonly slot: number }

/** 0x2100006e:0x1000018b, based on 0x21000023:0x100001cc (no 0x10000049). */
export const INVENTORY_PANEL: PanelsWindowSlotPanel = { key: 'inventory', slot: 0x1000018b, returnsToPrevious: false };
/** 0x2100006e:0x1000018e, based on 0x2100002e:0x10000227 (no 0x10000049). */
export const CHARACTER_PANEL: PanelsWindowSlotPanel = { key: 'character', slot: 0x1000018e, returnsToPrevious: false };
/** 0x2100006e:0x10000183, based on 0x2100001a:0x1000011b (0x10000049 = true). */
export const CHARACTER_INFO_PANEL: PanelsWindowSlotPanel = { key: 'charInfo', slot: 0x10000183, returnsToPrevious: true };
/** 0x2100006e:0x1000018d, based on 0x2100002b:0x10000208 (no 0x10000049). */
export const OPTIONS_PANEL: PanelsWindowSlotPanel = { key: 'options', slot: 0x1000018d, returnsToPrevious: false };
/** 0x2100006e:0x1000018c, based on 0x21000027:0x100001f2 (the World panel; no 0x10000049). */
export const WORLD_PANEL: PanelsWindowSlotPanel = { key: 'map', slot: 0x1000018c, returnsToPrevious: false };
/** 0x2100006e:0x1000018f, based on 0x21000031:0x1000028b (the Social panel; no 0x10000049). */
export const SOCIAL_PANEL: PanelsWindowSlotPanel = { key: 'social', slot: 0x1000018f, returnsToPrevious: false };
/** 0x2100006e:0x10000190, based on 0x21000034:0x100002a8 (the Spellbook; no 0x10000049). */
export const SPELLBOOK_PANEL: PanelsWindowSlotPanel = { key: 'magic', slot: 0x10000190, returnsToPrevious: false };
/** 0x2100006e:0x10000559, based on 0x21000063:0x1000055f (Contracts / Journal; no 0x10000049). */
export const CONTRACTS_PANEL: PanelsWindowSlotPanel = { key: 'contracts', slot: 0x10000559, returnsToPrevious: false };
/** 0x2100006e:0x1000018a, based on 0x21000020:0x100001c1 (gmVitaeUI; 0x10000049 = true). */
export const VITAE_PANEL: PanelsWindowSlotPanel = { key: 'vitae', slot: 0x1000018a, returnsToPrevious: true };
/** 0x2100006e:0x10000187, based on 0x2100001d:0x10000167 (gmLinkStatusUI; 0x10000049 = true). */
export const LINK_STATUS_PANEL: PanelsWindowSlotPanel = { key: 'linkStatus', slot: 0x10000187, returnsToPrevious: true };
/** 0x2100006e:0x10000182, based on 0x21000019:0x1000010d (gmBookUI; 0x10000049 = true). */
export const BOOK_PANEL: PanelsWindowSlotPanel = { key: 'book', slot: 0x10000182, returnsToPrevious: true };
/**
 * AGENT.automation-panel — the Automation panel (non-retail: ui/automation/
 * AutomationPanel.ts). 0x2100006e has no slot for it, so its key is its own
 * (0x7A000001 is outside every DAT id range); it takes the body like the
 * Vitae panel's shell it borrows, without 0x10000049.
 */
export const AUTOMATION_PANEL: PanelsWindowSlotPanel = { key: 'automation', slot: 0x7a000001, returnsToPrevious: false };
/** 0x2100006e:0x10000188, based on 0x2100001e:0x1000016a (gmMiniGameUI; 0x10000049 = true). */
export const MINI_GAME_PANEL: PanelsWindowSlotPanel = { key: 'miniGame', slot: 0x10000188, returnsToPrevious: true };
