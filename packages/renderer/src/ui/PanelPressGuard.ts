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
 */
export class PanelPressGuard {
  private pressed: Node | null = null;
  private readonly pending = new Map<Element, () => void>();

  constructor(private readonly target: Pick<Document, 'addEventListener'> | null = typeof document !== 'undefined' ? document : null) {
    if (!target) return;
    target.addEventListener('pointerdown', (e) => { this.pressed = (e.target as Node | null) ?? null; }, true);
    const release = (): void => this.release();
    target.addEventListener('pointerup', release, true);
    target.addEventListener('pointercancel', release, true);
    if (typeof window !== 'undefined') window.addEventListener('blur', release);
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

  /** The press ended: queued rebuilds run after this event's click. */
  release(): void {
    this.pressed = null;
    if (!this.pending.size) return;
    const queued = [...this.pending.values()];
    this.pending.clear();
    setTimeout(() => { for (const run of queued) run(); }, 0);
  }
}
