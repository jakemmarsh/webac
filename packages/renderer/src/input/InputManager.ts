export interface KeyBindings {
  toggleInventory: string;
  toggleSpellbook: string;
  toggleMap: string;
  toggleCharacter: string;
  toggleSettings: string;
  focusChat: string;
  spellBar: string[];
  autoRun: string;
  tabTarget: string;
}

export interface RaycastResult {
  entityId: number;
  entityType: string;
  distance: number;
  worldPosition: { x: number; y: number; z: number };
}

const DEFAULT_BINDINGS: KeyBindings = {
  toggleInventory: 'KeyI',
  toggleSpellbook: 'KeyB',
  toggleMap: 'KeyM',
  toggleCharacter: 'KeyC',
  toggleSettings: 'Escape',
  focusChat: 'Enter',
  spellBar: [
    'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
    'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
  ],
  autoRun: 'NumLock',
  tabTarget: 'Tab',
};

export class InputManager {
  private keys: Set<string> = new Set();
  private _mouseX = 0;
  private _mouseY = 0;
  private _mouseDeltaX = 0;
  private _mouseDeltaY = 0;
  private _bindings: KeyBindings;
  private _lastRaycast: RaycastResult | null = null;

  // Tab targeting
  private _targetIndex = -1;
  private _nearbyEntities: { id: number; type: string; distance: number }[] = [];

  constructor(bindings?: Partial<KeyBindings>) {
    this._bindings = { ...DEFAULT_BINDINGS, ...bindings };
    if (bindings?.spellBar) {
      this._bindings.spellBar = [...bindings.spellBar];
    }
  }

  // ---- Key state ----

  isKeyDown(code: string): boolean {
    return this.keys.has(code);
  }

  onKeyDown(code: string): void {
    this.keys.add(code);
  }

  onKeyUp(code: string): void {
    this.keys.delete(code);
  }

  // ---- Mouse ----

  onMouseMove(x: number, y: number, dx: number, dy: number): void {
    this._mouseX = x;
    this._mouseY = y;
    this._mouseDeltaX += dx;
    this._mouseDeltaY += dy;
  }

  get mousePosition(): { x: number; y: number } {
    return { x: this._mouseX, y: this._mouseY };
  }

  consumeMouseDelta(): { dx: number; dy: number } {
    const dx = this._mouseDeltaX;
    const dy = this._mouseDeltaY;
    this._mouseDeltaX = 0;
    this._mouseDeltaY = 0;
    return { dx, dy };
  }

  // ---- Raycast ----

  setRaycastResult(result: RaycastResult | null): void {
    this._lastRaycast = result;
  }

  get lastRaycast(): RaycastResult | null {
    return this._lastRaycast;
  }

  // ---- Tab targeting ----

  setNearbyEntities(entities: { id: number; type: string; distance: number }[]): void {
    this._nearbyEntities = [...entities].sort((a, b) => a.distance - b.distance);

    // If the current target is no longer in the nearby list, reset the index
    if (this._targetIndex >= 0) {
      const currentId = this.currentTarget?.id;
      if (currentId !== undefined) {
        const newIndex = this._nearbyEntities.findIndex((e) => e.id === currentId);
        this._targetIndex = newIndex; // will be -1 if not found, clearing target
      }
    }
  }

  cycleTarget(preferHostile?: boolean): { id: number; type: string } | null {
    if (this._nearbyEntities.length === 0) {
      this._targetIndex = -1;
      return null;
    }

    let candidates = this._nearbyEntities;

    if (preferHostile) {
      const hostile = this._nearbyEntities.filter((e) => e.type === 'creature');
      if (hostile.length > 0) {
        candidates = hostile;
      }
    }

    // Find the current target's position within the candidates list
    let currentCandidateIndex = -1;
    if (this._targetIndex >= 0) {
      const currentId = this._nearbyEntities[this._targetIndex]?.id;
      if (currentId !== undefined) {
        currentCandidateIndex = candidates.findIndex((e) => e.id === currentId);
      }
    }

    // Advance to the next candidate
    const nextCandidateIndex = (currentCandidateIndex + 1) % candidates.length;
    const chosen = candidates[nextCandidateIndex];

    // Map back to the full nearby entities list to store the canonical index
    this._targetIndex = this._nearbyEntities.findIndex((e) => e.id === chosen.id);

    return { id: chosen.id, type: chosen.type };
  }

  get currentTarget(): { id: number; type: string } | null {
    if (this._targetIndex < 0 || this._targetIndex >= this._nearbyEntities.length) {
      return null;
    }
    const entity = this._nearbyEntities[this._targetIndex];
    return { id: entity.id, type: entity.type };
  }

  clearTarget(): void {
    this._targetIndex = -1;
  }

  // ---- Key binding checks ----

  get bindings(): Readonly<KeyBindings> {
    return this._bindings;
  }

  isBindingPressed(action: keyof KeyBindings): boolean {
    const value = this._bindings[action];
    if (Array.isArray(value)) {
      return value.some((key) => this.keys.has(key));
    }
    return this.keys.has(value);
  }

  // ---- Consume a key press (one-shot) ----

  consumeKey(code: string): boolean {
    if (this.keys.has(code)) {
      this.keys.delete(code);
      return true;
    }
    return false;
  }

  // ---- Reset ----

  clearAllKeys(): void {
    this.keys.clear();
    this._mouseDeltaX = 0;
    this._mouseDeltaY = 0;
  }
}
