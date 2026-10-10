/**
 * CORE.17.k.b.b.c.c.a.a.c.a — the EoL bottom transaction dock.
 *
 * The root HUD 0x21000005 carries the dock in slot 0x100005fd ((0,400)
 * 610x120 of the 800x600 design, edges L3 T2 R3 B1: centred horizontally,
 * riding the bottom edge at native size — 80 px above it), based on
 * 0x2100006d:0x100005fb: a gmFloatyEnvPanelUI (element class 0x1000004e,
 * gmFloatyEnvPanelUI::Register @ 004d4af0) — a 5 px frame round five
 * 600x110 slots stacked at (5,5), each based on one transaction panel:
 *   0x10000062 → 0x21000012:0x100000b7 (gmVendorUI)
 *   0x1000005d → 0x21000008:0x10000063 (gmExternalContainerUI)
 *   0x1000005e → 0x2100000c:0x10000073 (gmSalvageUI)
 *   0x1000005f → 0x2100000d:0x1000007a (gmSecureTradeUI)
 *   0x10000060 → 0x2100000e:0x1000008c (gmSlumlordUI)
 * The 800-wide authoring of each panel reflows into the 600-wide slot by its
 * edge anchors (UIElement::UpdateForParentSizeChange @ 00462640).
 *
 * Sharing the dock — gmEnvPanelUI::RecvNotice_SetPanelVisibility @ 004cc760
 * (inherited by gmFloatyEnvPanelUI; SetupChildren @ 004cca40 registers the
 * five slots, none bShouldBeDefault): the dock shows ONE child at a time
 * (m_currentlyShownPanel). Showing a different child makes it current and,
 * when the previous one is visible, broadcasts
 * CM_UI::SendNotice_SetPanelVisibility(previous panelID, false) — the
 * previous panel is hidden, and its OnVisibilityChanged(false) runs its own
 * close (gmVendorUI @ 004c3820 → ClientUISystem::CloseVendor;
 * gmExternalContainerUI @ 004cbf50 → CloseCurrentContainer (UseObject);
 * gmSalvageUI @ 004cb470 → CloseSalvagePanel; gmSecureTradeUI @ 004ca470 →
 * CloseTradeNegotiations; gmSlumlordUI @ 004c7c70 → unregister its range
 * handlers). Hiding the current child with no default hides the dock.
 *
 * The window — CORE.17.k.b.b.c.c.a.a.c.a.c: gmFloatyEnvPanelUI::PostInit @
 * 004d4b10 reads its WindowID (attribute 0x1000007e — 6, authored on the HUD
 * slot 0x100005fd) and binds two border sets: the interactive one (top /
 * bottom 0x1000066c / 0x10000670 UIElement_Dragbar, the sides and corners
 * 0x1000066b-0x10000672 UIElement_Resizebar) and the locked art
 * 0x10000663-0x1000066a (textures 0x060074bf-c6, FLOATY_LOCKED_BORDER_TEXTURES).
 * UpdateLockedStatus @ 004d48f0 shows exactly one set per PlayerModule::LockUI;
 * MoveTo @ 004d5190 clamps to the screen and ResizeTo @ 004d5030 persist the
 * rect as chat-window options 0x10000086-89 under the WindowID, and
 * UpdateFromPlayerModule @ 004d4e10 restores them. The root's own size props
 * (p63 410 / p61 1000 wide, p62 = p60 = 120 high) make it width-resizable
 * only; the resize bars carry p43 (left) / p44 (right) alone.
 */
import { reflowEdgeAnchoredRect, type EdgeAnchoredRect } from '@ac/dat-parser';

export type TransactionDockPanel = 'vendor' | 'container' | 'salvage' | 'trade' | 'slumlord';

export const TRANSACTION_DOCK = {
  hudLayout: 0x21000005, hudSlot: 0x100005fd,
  dockLayout: 0x2100006d, dock: 0x100005fb,
  /** The dock slot of each panel (the order of 0x100005fb's children). */
  slots: { vendor: 0x10000062, container: 0x1000005d, salvage: 0x1000005e, trade: 0x1000005f, slumlord: 0x10000060 },
  /** The layout + root each slot is based on. */
  bases: {
    vendor: [0x21000012, 0x100000b7], container: [0x21000008, 0x10000063], salvage: [0x2100000c, 0x10000073],
    trade: [0x2100000d, 0x1000007a], slumlord: [0x2100000e, 0x1000008c],
  },
  /** The HUD slot's rect: 610x120, its bottom 600 − (400 + 120) = 80 px above the screen's. */
  width: 610, height: 120, bottom: 80,
  /** Every panel slot's rect inside the dock. */
  slotRect: { x: 5, y: 5, w: 600, h: 110 },
  /** WindowID (attribute 0x1000007e on the HUD slot 0x100005fd). */
  windowId: 6,
  /** The root's p63 / p61 width limits; p62 = p60 = the fixed height. */
  minWidth: 410, maxWidth: 1000,
} as const;

/** A persisted dock rect (chat-window options 0x10000086-89 under WindowID 6). */
export interface TransactionDockGeometry { x?: number; y?: number; w?: number; h?: number }

/**
 * Where the dock opens: the persisted width clamped to the root's p63/p61,
 * the persisted position clamped as MoveTo @ 004d5190 clamps it
 * (x ∈ [0, screenW − w], y ∈ [0, screenH − h]). Without a persisted position `x` / `y` are null: the HUD slot's own L3 / B1 edges
 * (centred, 80 px above the bottom).
 */
export function transactionDockPlacement(geo: TransactionDockGeometry, screenW: number, screenH: number): { x: number | null; y: number | null; w: number; h: number } {
  const D = TRANSACTION_DOCK;
  const h = D.height;
  let w: number = D.width;
  if (typeof geo.w === 'number' && Number.isFinite(geo.w)) w = Math.round(Math.max(D.minWidth, Math.min(D.maxWidth, geo.w)));
  if (typeof geo.x !== 'number' || typeof geo.y !== 'number' || !Number.isFinite(geo.x) || !Number.isFinite(geo.y)) return { x: null, y: null, w, h };
  const x = Math.round(Math.max(0, Math.min(geo.x, screenW - w)));
  const y = Math.round(Math.max(0, Math.min(geo.y, screenH - h)));
  return { x, y, w, h };
}

/** The dock slots a host of `panel` does not instantiate (all but its own; all of them for a hand-built panel). */
export function transactionDockOmittedSlots(panel: TransactionDockPanel | null): number[] {
  return (Object.entries(TRANSACTION_DOCK.slots) as Array<[TransactionDockPanel, number]>)
    .filter(([k]) => k !== panel).map(([, id]) => id);
}

/**
 * m_currentlyShownPanel + RecvNotice_SetPanelVisibility: `show` makes a
 * panel current and hides (closes) the one it displaces; `hide` of the
 * current panel empties the dock. `hide` of a panel that is not current
 * changes nothing (it was already displaced).
 */
export class TransactionDockArbiter {
  private current: { panel: TransactionDockPanel; close: () => void } | null = null;

  get panel(): TransactionDockPanel | null { return this.current?.panel ?? null; }

  show(panel: TransactionDockPanel, close: () => void): void {
    const prev = this.current;
    this.current = { panel, close };
    if (prev && prev.panel !== panel) prev.close();
  }

  hide(panel: TransactionDockPanel): void {
    if (this.current?.panel === panel) this.current = null;
  }
}

/** An authored element of a hand-built dock panel: its DAT id, rect + edges, and children. */
export interface DockGeometryNode extends EdgeAnchoredRect {
  id: number;
  children?: DockGeometryNode[];
}

export interface DockRect { x: number; y: number; w: number; h: number }

/**
 * The authored tree reflowed into the 600x110 slot: every element's rect
 * (parent-relative) keyed by its DAT id. The root takes the slot's size;
 * each child follows UpdateForParentSizeChange against its parent's delta.
 */
export function reflowDockGeometry(root: { id: number; width: number; height: number; children: DockGeometryNode[] }): Map<number, DockRect> {
  const S = TRANSACTION_DOCK.slotRect;
  const out = new Map<number, DockRect>();
  out.set(root.id, { x: 0, y: 0, w: S.w, h: S.h });
  const walk = (children: DockGeometryNode[], dW: number, dH: number, newW: number, newH: number): void => {
    for (const c of children) {
      const r = reflowEdgeAnchoredRect(c, dW, dH, newW, newH);
      out.set(c.id, { x: r.x, y: r.y, w: r.width, h: r.height });
      if (c.children) walk(c.children, r.width - c.width, r.height - c.height, r.width, r.height);
    }
  };
  walk(root.children, S.w - root.width, S.h - root.height, S.w, S.h);
  return out;
}
