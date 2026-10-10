/**
 * UIManager — manages screen stack and panel toggle system.
 *
 * Pure logic layer: no DOM manipulation. Tracks which screens and panels
 * are active, manages input focus state, and provides an event system
 * for UI state changes.
 */

export type ScreenType = 'loading' | 'character-create' | 'character-select' | 'disconnected' | 'game';
export type PanelType = 'inventory' | 'spellbook' | 'map' | 'character' | 'settings' | 'chat';

export class UIManager {
  private screenStack: ScreenType[] = [];
  private openPanels: Set<PanelType> = new Set();
  private _inputFocused = false;
  private listeners: Map<string, Set<Function>> = new Map();

  // ── Screen stack ──────────────────────────────────────────────────

  /** Push a screen onto the stack. */
  pushScreen(screen: ScreenType): void {
    this.screenStack.push(screen);
    this.emit('screen-change', screen);
  }

  /** Pop the top screen off the stack, returns it. */
  popScreen(): ScreenType | undefined {
    const screen = this.screenStack.pop();
    if (screen !== undefined) {
      this.emit('screen-change', this.currentScreen);
    }
    return screen;
  }

  /** Get current (top) screen. */
  get currentScreen(): ScreenType | undefined {
    return this.screenStack.length > 0
      ? this.screenStack[this.screenStack.length - 1]
      : undefined;
  }

  /** Get stack depth. */
  get screenDepth(): number {
    return this.screenStack.length;
  }

  /** Replace entire stack with a single screen. */
  setScreen(screen: ScreenType): void {
    this.screenStack = [screen];
    this.emit('screen-change', screen);
  }

  // ── Panel management ──────────────────────────────────────────────

  /** Open a panel. */
  openPanel(panel: PanelType): void {
    if (!this.openPanels.has(panel)) {
      this.openPanels.add(panel);
      this.emit('panel-open', panel);
    }
  }

  /** Close a panel. */
  closePanel(panel: PanelType): void {
    if (this.openPanels.has(panel)) {
      this.openPanels.delete(panel);
      this.emit('panel-close', panel);
    }
  }

  /** Toggle a panel open/closed. */
  togglePanel(panel: PanelType): void {
    if (this.openPanels.has(panel)) {
      this.closePanel(panel);
    } else {
      this.openPanel(panel);
    }
  }

  /** Check if a panel is open. */
  isPanelOpen(panel: PanelType): boolean {
    return this.openPanels.has(panel);
  }

  /** Get list of currently active panels. */
  get activePanels(): PanelType[] {
    return [...this.openPanels];
  }

  /** Close all panels. */
  closeAllPanels(): void {
    const panels = [...this.openPanels];
    this.openPanels.clear();
    for (const panel of panels) {
      this.emit('panel-close', panel);
    }
  }

  // ── Input focus ───────────────────────────────────────────────────

  /** Whether a UI input element (text field, etc.) currently has focus. */
  get inputFocused(): boolean {
    return this._inputFocused;
  }

  set inputFocused(val: boolean) {
    if (this._inputFocused !== val) {
      this._inputFocused = val;
      this.emit('input-focus-change', val);
    }
  }

  /**
   * Whether game input should be active.
   * Game input is active when no panels are open and UI input is not focused.
   */
  get gameInputActive(): boolean {
    return this.openPanels.size === 0 && !this._inputFocused;
  }

  // ── Event system ──────────────────────────────────────────────────

  /** Subscribe to an event. */
  on(event: string, callback: Function): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
  }

  /** Unsubscribe from an event. */
  off(event: string, callback: Function): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(callback);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /** Emit an event to all subscribers. */
  emit(event: string, ...args: any[]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const cb of set) {
        cb(...args);
      }
    }
  }
}
