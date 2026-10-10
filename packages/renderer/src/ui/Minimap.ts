/**
 * Minimap -- minimap state management.
 *
 * Pure logic layer: no DOM manipulation. Tracks player position,
 * heading, zoom level, and entity dot positions for the minimap display.
 * Provides coordinate conversion from world space to minimap space.
 */

export interface MinimapDot {
  x: number;
  y: number;
  color: string;
  type: string;
}

/** Minimum allowed zoom level. */
const MIN_ZOOM = 0.5;
/** Maximum allowed zoom level. */
const MAX_ZOOM = 4.0;
/** Zoom increment per step. */
const ZOOM_STEP = 0.25;

export class Minimap {
  private _visible = true;
  private _zoom = 1.0;
  private _playerX = 0;
  private _playerY = 0;
  private _playerHeading = 0;
  private _dots: MinimapDot[] = [];
  private _size = 200;

  get visible(): boolean {
    return this._visible;
  }

  set visible(v: boolean) {
    this._visible = v;
  }

  toggle(): void {
    this._visible = !this._visible;
  }

  get zoom(): number {
    return this._zoom;
  }

  get playerPosition(): { x: number; y: number } {
    return { x: this._playerX, y: this._playerY };
  }

  get playerHeading(): number {
    return this._playerHeading;
  }

  get dots(): ReadonlyArray<MinimapDot> {
    return this._dots;
  }

  get size(): number {
    return this._size;
  }

  // ── Updates ──────────────────────────────────────────────────

  /**
   * Update the player's world position and heading.
   * @param x - world X coordinate
   * @param y - world Y coordinate
   * @param heading - heading in radians
   */
  updatePlayerPosition(x: number, y: number, heading: number): void {
    this._playerX = x;
    this._playerY = y;
    this._playerHeading = heading;
  }

  /**
   * Set the zoom level, clamped between MIN_ZOOM and MAX_ZOOM.
   */
  setZoom(zoom: number): void {
    this._zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  }

  /**
   * Zoom in by one step.
   */
  zoomIn(): void {
    this.setZoom(this._zoom + ZOOM_STEP);
  }

  /**
   * Zoom out by one step.
   */
  zoomOut(): void {
    this.setZoom(this._zoom - ZOOM_STEP);
  }

  // ── Entity dots ──────────────────────────────────────────────

  /**
   * Clear all entity dots from the minimap.
   */
  clearDots(): void {
    this._dots = [];
  }

  /**
   * Add an entity dot at a world position.
   * @param x - world X coordinate
   * @param y - world Y coordinate
   * @param color - dot color (e.g. 'green', 'red', 'blue', 'white', 'yellow')
   * @param type - entity type label
   */
  addDot(x: number, y: number, color: string, type: string): void {
    this._dots.push({ x, y, color, type });
  }

  // ── Coordinate conversion ────────────────────────────────────

  /**
   * Convert a world position to a minimap-relative pixel position.
   * The player is always at the center of the minimap.
   * @returns minimap pixel coordinates, or null if the position is outside the minimap bounds
   */
  worldToMinimap(
    worldX: number,
    worldY: number,
  ): { x: number; y: number } | null {
    const halfSize = this._size / 2;

    // Offset from player position, scaled by zoom
    // Higher zoom = more zoomed in = smaller world area visible
    const scale = this._zoom * 2; // pixels per world unit (tunable)
    const dx = (worldX - this._playerX) * scale;
    const dy = (worldY - this._playerY) * scale;

    // Rotate by player heading so the minimap is oriented with the player
    const cos = Math.cos(-this._playerHeading);
    const sin = Math.sin(-this._playerHeading);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;

    // Translate to minimap center
    const mx = halfSize + rx;
    const my = halfSize - ry; // Y is flipped (screen Y goes down)

    // Check bounds
    if (mx < 0 || mx > this._size || my < 0 || my > this._size) {
      return null;
    }

    return { x: mx, y: my };
  }
}
