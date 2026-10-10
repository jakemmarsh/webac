/**
 * FloatyWindowModel — CORE.5.b.c: the non-chat floaty HUD windows' identity
 * + persisted-geometry model (vitals clusters, indicator strip, radar).
 *
 * Ground truth (decompiled EoL client + client_local_English.dat):
 *
 * Every floaty window's identity is DAT attribute 0x1000007e (WindowID) on
 * the authoring element in the gameplay HUD layout 0x21000005
 * (gmFloatyPanelUI::PostInit @ 004d1a30 / gmFloatyVitalsUI::PostInit @
 * 004cedb0 / gmFloatySideVitalsUI::PostInit @ 004d04b0 / gmRadarUI::PostInit
 * @ 004d9d30 all read it via UIElement::GetAttribute_Enum). Values dumped
 * from the DAT:
 *   0x100005fa stacked vitals cluster  → 11
 *   0x10000611 indicator strip         → 12
 *   0x100006d2 radar                   → 14
 *   0x100006d5 side-by-side vitals     → 17
 *   (0x10000505 floaty chat 1 → 2 … matches FloatyChatModel; 0x100005ff
 *   panels window → 9 and 0x10000603 toolbar → 10 are separate tasks.)
 *
 * Position/size persist through the SAME PlayerModule chat-window options
 * as the floaty chat windows (the name is historical — every floaty window
 * uses them): MoveTo writes options 0x10000086/87, ResizeTo writes
 * 0x10000088/89 via PlayerModule::SetChatWindowOption under the window's
 * WindowID (gmRadarUI::MoveTo @ 004d81a0, gmFloatySideVitalsUI::ResizeTo @
 * 004d0a50, gmFloatyPanelUI::MoveTo @ 004d20b0); UpdateFromPlayerModule
 * reads them back on login (gmFloatyVitalsUI::UpdateFromPlayerModule @
 * 004cf140 → MoveTo(x,y) + ResizeTo(w,h) when both members of a pair are
 * present). MoveTo clamps to the screen region: x ∈ [0, screenW - w],
 * y ∈ [0, screenH - h].
 *
 * Resize limits are the window roots' OWN DAT props (UIElement::
 * MouseResizeElement @ 00461130 clamps against attributes 0x3f/0x3e/0x3d/
 * 0x3c = p63 minW / p62 minH / p61 maxW / p60 maxH):
 *   stacked root 0x100005f9      minW 160, maxW 610,  fixed height 58
 *   side-by-side root 0x100006d4 minW 360, maxW 3000, fixed height 26
 *   indicators root 0x10000610   min = max = 150x30 (movable only)
 *
 * Like FloatyChatModel, localStorage is the stand-in for characters with no
 * server-persisted PlayerModule blob yet (and for solo mode); the server
 * blob (PlayerDescription GameplayOptions) is authoritative when present.
 */

// ─── WindowIDs (DAT attribute 0x1000007e on layout 0x21000005) ──────────

export const VITALS_STACKED_WINDOW_ID = 11;
export const INDICATORS_WINDOW_ID = 12;
export const RADAR_WINDOW_ID = 14;
/**
 * CORE.5.b.d — the EoL bottom-right toolbar window (root HUD child
 * 0x10000603, base layout 0x21000070 root 0x10000602 = gmFloatyToolbarUI
 * class 0x10000051). Fixed width 310 (p63=p61=310); height resizable
 * 100..132 (p62=100, p60=132) — the 132 max reveals the second shortcut
 * row of the inherited classic content (0x21000016:0x10000191, 300x122).
 */
export const TOOLBAR_WINDOW_ID = 10;
export const VITALS_SIDE_BY_SIDE_WINDOW_ID = 17;
/**
 * CORE.16 — the shared jump/melee/missile power bar (root HUD child
 * 0x10000613 at (95,400) 610x25, edges L1/T1/R1/B2; base layout 0x21000072
 * root 0x10000612 = gmFloatyPowerBarUI class 0x10000053). Width resizable
 * 50..810 (p63/p61) at fixed height 25 (p62=p60).
 */
export const POWERBAR_WINDOW_ID = 13;

/** gmPowerbarUI's PowerBarMode → the widget state it selects. */
export type PowerBarMode = 'jump' | 'melee' | 'missile' | 'ddd';

/**
 * gmPowerbarUI::RecvNotice_BeginPowerbar @ 004da730: PBM_JUMP → state
 * 0x10000042, melee (PBM_ADVANCED_COMBAT in MELEE_COMBAT_MODE) → 0x10000043,
 * missile → 0x10000044, PBM_DDD → 0x10000045. Layout 0x21000072 keys both the
 * fill texture (element 0x2) and the caption (element 0x10000035, p23) on
 * that state; the caption StringTable ids resolve to "Height" / "Power" /
 * "Accuracy" (the DDD state carries no caption).
 */
export const POWER_BAR_STATES: Record<PowerBarMode, { state: number; captionStringId: number | null; captionFallback: string }> = {
  jump: { state: 0x10000042, captionStringId: 86621556, captionFallback: 'Height' },
  melee: { state: 0x10000043, captionStringId: 261968564, captionFallback: 'Power' },
  missile: { state: 0x10000044, captionStringId: 175542084, captionFallback: 'Accuracy' },
  ddd: { state: 0x10000045, captionStringId: null, captionFallback: '' },
};

/** Layout 0x21000072 element ids the power-bar window drives at runtime. */
export const POWERBAR_ELEMENTS = {
  root: 0x10000612,
  meter: 0x10000034,
  caption: 0x10000035,
  fill: 0x2,
  /** m_RecklessnessField (gmPowerbarUI::PostInit @ 004da4e0): melee-only. */
  recklessness: 0x100005ee,
} as const;

/**
 * The plain "locked" border art textures shared by all three floaty
 * windows' type-3 border elements (top/left/bottom/right + 4 corners).
 * gmFloatyPanelUI::UpdateLockedStatus @ 004d0280 (and the per-class
 * equivalents gmFloatyIndicatorsUI::UpdateLockedStatus @ 004d2ff0 /
 * gmFloatyVitalsUI via the shared border members) shows these while LockUI
 * is ON and the interactive drag/resize borders while it is OFF.
 */
export const FLOATY_LOCKED_BORDER_TEXTURES: ReadonlySet<number> = new Set([
  0x060074bf, // top
  0x060074c0, // left
  0x060074c1, // bottom
  0x060074c2, // right
  0x060074c3, // top-left corner
  0x060074c4, // top-right corner
  0x060074c5, // bottom-left corner
  0x060074c6, // bottom-right corner
]);

// ─── Persisted geometry (localStorage stand-in) ─────────────────────────

/** One floaty window's persisted geometry (options 0x10000086-89). */
export interface FloatyWindowState {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

const STORAGE_KEY_BASE = 'ac_floaty_windows_v1';

export function floatyWindowStorageKey(scope: string): string {
  return scope ? `${STORAGE_KEY_BASE}:${scope}` : STORAGE_KEY_BASE;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function loadFloatyWindowStates(
  storage: StorageLike,
  scope: string,
): Record<number, FloatyWindowState> {
  try {
    const raw = storage.getItem(floatyWindowStorageKey(scope));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* disabled / corrupt — fall through to defaults */
  }
  return {};
}

export function saveFloatyWindowState(
  storage: StorageLike,
  scope: string,
  windowId: number,
  state: FloatyWindowState,
): void {
  try {
    const all = loadFloatyWindowStates(storage, scope);
    all[windowId] = state;
    storage.setItem(floatyWindowStorageKey(scope), JSON.stringify(all));
  } catch {
    /* quota / disabled — drop silently */
  }
}

// ─── The live PlayerModule window collection ────────────────────────────
//
// Retail keeps ONE in-memory PlayerModule per character: login fills it from
// PlayerDescription, every MoveTo/ResizeTo/SetVisible writes one window's
// options into it (PlayerModule::SetChatWindowOption @ 005d5570), and
// CM_Character::Event_CharacterOptionsEvent serializes the WHOLE collection.
// So a save after moving one window still carries every other window the
// server had, and a re-read after a move sees the move.

/** One window's chat-window options (the semantic shape @ac/network serializes). */
export interface LiveWindowOptions {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  visible?: boolean;
  filter?: bigint;
  title?: string;
}

/** Window collection shape shared with @ac/network GameplayOptionsData. */
export interface LiveWindowModule {
  chatWindows: Map<number, LiveWindowOptions>;
}

/**
 * PlayerModule::SetChatWindowOption — merge `opts` into `windowId`'s entry
 * of the live module (other options and other windows are kept). A null
 * module (fresh character, nothing stored yet) gets created, since retail's
 * PlayerModule always exists once in world.
 */
export function setLiveWindowOptions<M extends LiveWindowModule>(
  module: M | null,
  windowId: number,
  opts: LiveWindowOptions,
): M | LiveWindowModule {
  const target: LiveWindowModule = module ?? { chatWindows: new Map() };
  const cur = target.chatWindows.get(windowId) ?? {};
  target.chatWindows.set(windowId, { ...cur, ...opts });
  return target;
}

/**
 * The starting point of a save: a copy of every window the live module
 * carries. The caller overlays what it renders; windows this session never
 * drew or touched (another window id, a panel not yet opened) keep their
 * stored options instead of being dropped from the blob.
 */
export function windowsFromLiveModule(module: LiveWindowModule | null): Map<number, LiveWindowOptions> {
  const out = new Map<number, LiveWindowOptions>();
  if (!module) return out;
  for (const [id, opts] of module.chatWindows) out.set(id, { ...opts });
  return out;
}

/**
 * UIElement::MouseMoveElement @ 0045fe30 (every Dragbar drag) and the
 * floaty windows' MoveTo: x ∈ [0, screenW − w], y ∈ [0, screenH − h]
 * (the low clamp wins when the window is larger than the screen). Also how
 * a restored position lands on a smaller browser window (our HUD resizes
 * with the window — the browser-UX exception), so a window saved at the
 * right edge of a wide screen is still reachable on a narrow one.
 */
export function clampWindowPosition(
  x: number, y: number, w: number, h: number, screenW: number, screenH: number,
): { x: number; y: number } {
  return {
    x: Math.round(Math.max(0, Math.min(x, screenW - w))),
    y: Math.round(Math.max(0, Math.min(y, screenH - h))),
  };
}
