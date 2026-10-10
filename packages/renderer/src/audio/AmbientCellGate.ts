/**
 * SOUND.ambient-seen-outside — when the ambient neighbourhood is re-gathered,
 * and whether the gather adds the landscape.
 *
 * Retail CellManager::ChangePosition @ 004559b0 runs on every change of the
 * player's cell: Ambient::InitSounds @ 005515d0 (zero every count), then
 * LScape::add_ambient_sounds only when the new cell is outdoor
 * (`(objcell_id & 0xffff) < 0x100`) or an env cell with `seen_outside`, then
 * Ambient::UpdatePlayQueue. A sealed cell therefore gets a gather with no
 * vertices: every sound fails CanHear at its next queue time and drops off,
 * while a one-shot already sounding plays out (nothing stops it).
 *
 * The gate keys on the cell, not on how the player arrived: a surface
 * building entered at login or by teleport hears the landscape like one
 * walked into, and the first frame in a sealed cell zeroes what the last
 * place left queued.
 */

export interface AmbientCellState {
  /** The player's env cell id, or 0 when standing in an outdoor cell. */
  envCellId: number;
  /** The env cell's `seen_outside` flag (ignored outdoors). */
  seenOutside: boolean;
  /** The player's 24 m outdoor-grid cell (world metres / 24, floored). */
  gridX: number;
  gridY: number;
  /** The full-detail landscape blocks loaded around the player. */
  loadedBlocks: number;
  /** Whether the player's own landblock is loaded (a gather needs it). */
  ownBlockLoaded: boolean;
}

export type AmbientGatherAction = 'none' | 'landscape' | 'sealed';

export class AmbientCellGate {
  private lastKey: string | null = null;

  /**
   * What this frame owes the ambient manager. 'landscape' → gather the
   * landscape vertices; 'sealed' → apply an empty gather; 'none' → nothing
   * changed (or the landscape around a hearing cell has not streamed in yet,
   * which retail has loaded before the position change).
   */
  step(s: AmbientCellState): AmbientGatherAction {
    const hearsLandscape = s.envCellId === 0 || s.seenOutside;
    if (!hearsLandscape) {
      const key = `sealed:${s.envCellId >>> 0}`;
      if (key === this.lastKey) return 'none';
      this.lastKey = key;
      return 'sealed';
    }
    if (!s.ownBlockLoaded) return 'none';
    // Also re-gather when another full-detail block streams in.
    const key = `${s.envCellId >>> 0}:${s.gridX},${s.gridY}:${s.loadedBlocks}`;
    if (key === this.lastKey) return 'none';
    this.lastKey = key;
    return 'landscape';
  }

  /** Forget the last cell (a region reload or logout): the next step gathers. */
  reset(): void {
    this.lastKey = null;
  }
}
