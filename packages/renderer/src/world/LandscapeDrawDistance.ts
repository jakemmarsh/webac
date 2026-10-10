/**
 * CORE.17.h.g.a — Render.LandscapeDrawDistance is the landscape grid radius.
 *
 * Retail (reference/client-eol/decomp/acclient-decompiled.c):
 *  - `SmartBox::set_mid_radius(long)` @ 00453180 (:86231-86245) resets the
 *    CellManager, hands the value to `LScape::SetMidRadius` and, when the
 *    player already stands somewhere, `CellManager::ChangePosition`s around
 *    them so the new grid fills immediately. It is fed
 *    `Render::m_RenderPrefs.LandscapeDrawDistance` from `SmartBox::SetRegion`
 *    (:86262) and again whenever the render prefs change (:325087).
 *  - `LScape::SetMidRadius` @ 00504c00 (:251549-251558): only a POSITIVE
 *    radius is accepted; `mid_radius = R`, `mid_width = 2R + 1`.
 *  - `LScape::update_block` @ 005063a0 (:252788-) fills the `mid_width²`
 *    `CLandBlock` grid centred on the viewer's block; every `CLandBlock`
 *    loads its own LBI as a sub-datum (`CLandBlock::GetSubDataIDs` @
 *    0052fc60 / `InitLoad` @ 0052fca0 → `0xXXYYFFFE`) — but the LBI's
 *    CONTENT is only instantiated on full-detail blocks (PERF.5, below):
 *    buildings, statics, scenery and the building-visible interior cells
 *    exist for the 3×3 blocks around the viewer, not the whole grid.
 *  - The menu registers the values [3, 5, 8, 11, 15, 25] (acclient.exe .data
 *    0x3ca988, docs/retail-client-symbols.md "CORE.17.h.g") with
 *    `SetDefaultValue(8)` → "Medium"; `LScape::LScape` @ 00505370 seeds 5
 *    before the pref is applied.
 *
 * Ours: the value feeds `TerrainManager.setLoadRadius` (terrain). The
 * landblock-object window is the retail full-detail ring inside it
 * (`objectRingRadius`); objects are retired with a two-block hysteresis
 * past that ring (the pre-existing LOD_UNLOAD_RADIUS 5 vs LOD_LOAD_RADIUS 3
 * pair), which retail has no equivalent of — `notify_change_size` releases
 * a block's objects the moment it leaves the ring. Blocks in the hysteresis
 * band stay built but HIDDEN (LandblockObjectStreamer), so nothing beyond
 * the ring is drawn.
 */

/** Render_LandscapeDrawDistance_Values — landblocks, Very Low … Extreme. */
export const LANDSCAPE_DRAW_DISTANCE_VALUES: readonly number[] = [3, 5, 8, 11, 15, 25];

/** `SetDefaultValue(8)` → the "Medium" entry (what the Defaults button restores). */
export const RETAIL_DEFAULT_LANDSCAPE_DRAW_DISTANCE = 8;

/**
 * The radius a FRESH profile (no persisted Landscape Draw Distance) starts
 * at: retail's own default, 8 ("Medium"). From CORE.17.h.g.a (2026-09-10)
 * until 2026-09-26 it was an interim 3 ("Very Low"), because the SwiftShader
 * measurement then put 8 over every budget (1,913 draw calls, 7.3 M
 * triangles). After the later instancing/LOD work, a real-GPU run
 * (measure-perf --gpu, Apple M3 Max, Holtburg) holds 67-77 fps at 8 with
 * 806 draw calls and 106 k triangles (verification/perf/
 * perf-2026-09-26T18-07-38-485Z.json), so Jake set it to retail's value
 * (CORE.17.h.g.a.a). A player who picks a value in the menu is honoured in full.
 */
export const SHIPPED_DEFAULT_LANDSCAPE_DRAW_DISTANCE = RETAIL_DEFAULT_LANDSCAPE_DRAW_DISTANCE;

/** Blocks beyond the load radius an object block may sit before it is retired. */
export const OBJECT_UNLOAD_HYSTERESIS = 2;

/**
 * Coerce a persisted / menu value to the radius retail would accept: a
 * positive integer (`LScape::SetMidRadius` refuses `<= 0`). Anything else —
 * a non-number, NaN, zero, a negative — falls back to the retail default.
 */
export function normalizeLandscapeDrawDistance(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return RETAIL_DEFAULT_LANDSCAPE_DRAW_DISTANCE;
  const r = Math.floor(value);
  return r > 0 ? r : RETAIL_DEFAULT_LANDSCAPE_DRAW_DISTANCE;
}

/** `LScape::mid_width` for a radius: the grid is `(2R + 1)²` landblocks. */
export function landscapeGridWidth(radius: number): number {
  return radius * 2 + 1;
}

/** Object blocks farther than this (Chebyshev, in blocks) from the player are unloaded. */
export function objectUnloadRadius(loadRadius: number): number {
  return loadRadius + OBJECT_UNLOAD_HYSTERESIS;
}

/**
 * PERF.5 — retail per-ring landblock content: `LScape::get_block_orient` @
 * 00504f90 (decomp :251768-251830). For the block at grid offset (dx, dy)
 * from the viewer's block, d = max(|dx|, |dy|) (Chebyshev) picks the
 * landscape reduction: d < 2 → 1, d < 3 → 2, d ≤ 4 → 4, else 8.
 * `LScape::update_block`'s tail (:253054-253079) regenerates every block at
 * side_cell_count = 8 / reduction (`CLandBlockStruct::generate` @ 00532bb0)
 * and, when a block drops below 8, `CLandBlock::notify_change_size` @
 * 005302c0 destroys its static objects, buildings and visible cells. The
 * content builders all gate on side_cell_count == 8: `init_buildings` @
 * 0052fd80, `init_static_objs` @ 00530a40 (which also runs
 * `get_land_scenes`, the scenery), `init_dyn_objs` @ 0052f3b0, and
 * `LScape::get_landblock` @ 00505e40 returns null for any other block. So
 * the landscape draws out to the Landscape Draw Distance, but buildings,
 * statics, scenery and building interiors exist only on reduction-1 blocks.
 */
export function landblockDetailReduction(dx: number, dy: number): 1 | 2 | 4 | 8 {
  const d = Math.max(Math.abs(dx), Math.abs(dy));
  if (d < 2) return 1;
  if (d < 3) return 2;
  if (d <= 4) return 4;
  return 8;
}

/** Largest Chebyshev distance whose block is full detail (reduction 1): the 3×3 around the viewer. */
export const RETAIL_FULL_DETAIL_RADIUS = 1;

/** The landblock-object ring for a landscape radius — never wider than the grid itself. */
export function objectRingRadius(landscapeRadius: number): number {
  return Math.min(landscapeRadius, RETAIL_FULL_DETAIL_RADIUS);
}

/**
 * Ours (PERF.5): object blocks one ring beyond the full-detail ring are built
 * ahead of the player by the budgeted loader but kept HIDDEN, so the frame
 * that crosses a block edge only toggles their visibility instead of
 * building three to five blocks synchronously. Nothing in this band draws.
 */
export const OBJECT_PREFETCH_RINGS = 1;
