import { CombatMode } from '@ac/shared';

/**
 * The EoL combat window (gmFloatyCombatUI) that hosts the spell bar and the
 * melee combat bar (BUG.spellbar-classic-clip):
 *  - the root HUD 0x21000005 authors it as slot 0x100006b5: (0,400) 610x90,
 *    edges L3 T2 R3 B1 (horizontally centred, 800 − 610 = 190 px split
 *    evenly; the bottom gap 600 − 490 = 110 px kept), WindowID 15, base
 *    element 0x100006a4 of layout 0x21000073;
 *  - 0x100006a4: resize limits p63 410 / p62 70 / p61 3000 / p60 90, a
 *    5 px frame (locked art 0x060074bf-c6, Dragbar/Resizebar set) round the
 *    body at (5,5) 600x80, which holds the two page slots 0x10000061 →
 *    0x21000010:0x1000009f (gmSpellcastingUI's classic 800x80 subtree,
 *    reflowed by its DAT edges) and 0x1000005c → 0x21000007:0x1000004b (the
 *    classic combat bar).
 */
export const COMBAT_WINDOW = {
  hudSlot: 0x100006b5, layout: 0x21000073, root: 0x100006a4,
  pageSlots: [0x10000061, 0x1000005c] as const,
  spellPage: { layout: 0x21000010, root: 0x1000009f },
  combatPage: { layout: 0x21000007, root: 0x1000004b },
  windowId: 15,
  width: 610, height: 90,
  /** Bottom gap of the authored slot (600 − (400 + 90)). */
  bottom: 110,
  body: { x: 5, y: 5, w: 600, h: 80 },
} as const;

/** Resize limits of the window root 0x100006a4 (p63 / p62 min, p61 / p60 max). */
export const COMBAT_WINDOW_LIMITS = { minW: 410, minH: 70, maxW: 3000, maxH: 90 } as const;

/** The frame round the body: 5 px on every side (body (5,5) in a 610x90 window). */
const COMBAT_WINDOW_FRAME = COMBAT_WINDOW.width - COMBAT_WINDOW.body.w;

export interface CombatWindowGeometry { x?: number; y?: number; w?: number; h?: number }

export interface CombatWindowPlacement {
  /** Null when nothing is persisted: the authored centred-above-the-bottom slot stands. */
  x: number | null;
  y: number | null;
  w: number;
  h: number;
  body: { w: number; h: number };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * gmFloatyCombatPanelUI::UpdateFromPlayerModule @ 004d4e10: with options
 * 0x10000086/87 persisted under WindowID 15 it calls MoveTo(x, y), with
 * 0x10000088/89 ResizeTo(w, h). MoveTo @ 004d5190 clamps x into
 * [0, parentW − w] and y into [0, parentH − h] (the low bound wins), so a
 * position saved on a bigger screen (a retail 1920x1200 layout, a larger
 * browser window) lands on this one; ResizeTo is held to the root's
 * min/max size. Without the clamp a long-played character's combat and
 * spell bars sat below the bottom of the screen (webac#2).
 */
export function combatWindowPlacement(geo: CombatWindowGeometry, screenW: number, screenH: number): CombatWindowPlacement {
  const L = COMBAT_WINDOW_LIMITS;
  const w = finite(geo.w) ? Math.round(Math.max(L.minW, Math.min(L.maxW, geo.w))) : COMBAT_WINDOW.width;
  const h = finite(geo.h) ? Math.round(Math.max(L.minH, Math.min(L.maxH, geo.h))) : COMBAT_WINDOW.height;
  const body = { w: w - COMBAT_WINDOW_FRAME, h: h - COMBAT_WINDOW_FRAME };
  if (!finite(geo.x) || !finite(geo.y)) return { x: null, y: null, w, h, body };
  return {
    x: Math.round(Math.max(0, Math.min(geo.x, screenW - w))),
    y: Math.round(Math.max(0, Math.min(geo.y, screenH - h))),
    w, h, body,
  };
}

/**
 * gmCombatUI::RecvNotice_SetCombatMode @ 004cc620: the melee/missile combat
 * bar page shows only in melee (state 0x10000003) or missile (0x10000004)
 * mode AND with the Advanced Combat Interface option OFF; with it on the
 * page hides (SetVisible(0)) and attacks charge on the floaty power bar
 * instead (PBM_ADVANCED_COMBAT, gmPowerbarUI::RecvNotice_BeginPowerbar
 * @ 004da730).
 */
export function combatBarPageVisible(combatMode: CombatMode, advancedCombatUI: boolean): boolean {
  return !advancedCombatUI && (combatMode === CombatMode.Melee || combatMode === CombatMode.Missile);
}
