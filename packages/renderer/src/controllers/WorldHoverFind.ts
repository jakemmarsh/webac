/**
 * SWEEP1006B.player-input.world-hover-find-throttled-10 — the cadence of
 * UIElement_SmartBoxWrapper's mouse-over find (sr_MouseOver).
 *
 * Retail: Global_Loop @ 004e5620 and MouseMove @ 004e56c0 only arm the find
 * at the latest mouse point (FindObject @ 004e5430 → SmartBox::find_object
 * @ 00451c60 sets lookingForObject); the next SmartBox::DrawNoBlit
 * @ 00454c20 resolves it (Render::GetMouseSelectionObjectID →
 * SendNotice_SmartBoxObjectFound), and RecvNotice_SmartBoxObjectFound
 * clears the search reason so the next loop arms it again. So exactly one
 * find per rendered frame, at the newest pointer position; several mouse
 * moves inside a frame just overwrite the pending point. No timer gates it
 * (the only timer in Global_Loop is the 0.2 s SELECTION_FLIP_TIME blink).
 *
 * Ours used to raycast at most 10x/sec. Events now only record the pointer;
 * the render loop asks `frame()` for the one find to run.
 */
export interface HoverFindRequest {
  x: number;
  y: number;
  /** UIElementManager::m_dragElement is set (a native drag over the 3D view). */
  dragging: boolean;
}

export class WorldHoverFind {
  private pointer: { x: number; y: number; viaDragOver: boolean } | null = null;

  /** Canvas mousemove. */
  move(x: number, y: number): void {
    this.pointer = { x, y, viaDragOver: false };
  }

  /** Canvas dragover: the browser fires no mousemove during a native drag. */
  dragOver(x: number, y: number): void {
    this.pointer = { x, y, viaDragOver: true };
  }

  /** The pointer left the 3D view: nothing to find under. */
  leave(): void {
    this.pointer = null;
  }

  get hasPointer(): boolean {
    return this.pointer !== null;
  }

  /**
   * The find to run this frame, or null. While a HUD drag is in flight a
   * point recorded by mousemove is stale (no mousemove fires during it), so
   * only a dragover point is used then.
   */
  frame(hudDragInProgress: boolean): HoverFindRequest | null {
    const p = this.pointer;
    if (!p) return null;
    if (hudDragInProgress && !p.viaDragOver) return null;
    return { x: p.x, y: p.y, dragging: hudDragInProgress && p.viaDragOver };
  }
}
