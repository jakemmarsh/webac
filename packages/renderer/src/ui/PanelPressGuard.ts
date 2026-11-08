/**
 * Holds a panel rebuild while a mouse button is down inside that panel.
 *
 * Several panels redraw by tearing their DOM down and rendering it again
 * (the character panel on every vital tick, inventory on every loot, the
 * examine window on its 0.75 s re-appraisal). A DOM `click` needs the press
 * and the release on the same element, so a rebuild landing between the two
 * swapped the button under the cursor for a new one and the click never
 * fired: the close X took several tries. Retail's UI updated its elements in
 * place, so a press always reached its button.
 *
 * A held rebuild runs once, after the release's click has been dispatched,
 * and only if the panel it would replace is still on the page (a click that
 * closed it, or a rebuild nobody held, makes it moot).
 *
 * BUG.spell-drag-source-torn-out — a press that turns into a native drag
 * (a spellbook row, a pack cell) is held until the DRAG ends, not until the
 * pointercancel the browser fires as the drag starts (Chrome, Edge). Released
 * there, the queued rebuild ran mid-drag and replaced the drag's source
 * element, so its dragend never reached the document and every listener that
 * ends a drag on dragend (the spell bar's drop mode, the drag scroll, the
 * tooltip hold) stayed on. A drag ends on drop / dragend, or — when the
 * source was torn out anyway — on the next pointer or mouse event, since a
 * native drag sends none while it runs.
 */
export class PanelPressGuard {
  private pressed: Node | null = null;
  /** The press became a native drag: pointercancel no longer ends it. */
  private dragging = false;
  private readonly pending = new Map<Element, () => void>();

  constructor(private readonly target: Pick<Document, 'addEventListener'> | null = typeof document !== 'undefined' ? document : null) {
    if (!target) return;
    target.addEventListener('pointerdown', (e) => { this.dragging = false; this.pressed = (e.target as Node | null) ?? null; }, true);
    const release = (): void => this.release();
    target.addEventListener('pointerup', release, true);
    target.addEventListener('pointercancel', () => { if (!this.dragging) this.release(); }, true);
    target.addEventListener('dragstart', (e) => {
      if (e.defaultPrevented || !this.pressed) return;
      this.dragging = true;
    });
    const dragOver = (): void => { if (this.dragging) this.release(); };
    target.addEventListener('dragend', dragOver, true);
    target.addEventListener('drop', dragOver, true);
    // No mouse event arrives during a native drag: one arriving means it is over.
    target.addEventListener('mousemove', dragOver, true);
    if (typeof window !== 'undefined') window.addEventListener('blur', () => { if (!this.dragging) this.release(); });
  }

  /**
   * True when a press began inside `panel`: `rebuild` is queued for the
   * release (the latest one per panel) and the caller skips its rebuild now.
   */
  defer(panel: Element | null | undefined, rebuild: () => void): boolean {
    if (!panel || !this.pressed || !panel.isConnected || !panel.contains(this.pressed)) return false;
    this.pending.set(panel, () => { if (panel.isConnected) rebuild(); });
    return true;
  }

  /** The press (or the drag it became) ended: queued rebuilds run after this event's click / drop. */
  release(): void {
    this.pressed = null;
    this.dragging = false;
    if (!this.pending.size) return;
    const queued = [...this.pending.values()];
    this.pending.clear();
    setTimeout(() => { for (const run of queued) run(); }, 0);
  }
}
