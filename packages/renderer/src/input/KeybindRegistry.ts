/**
 * KeybindRegistry — the single source of truth for "which physical key fires
 * which AC command", shared by the live input router (main.ts) and the
 * Keyboard Config dialog (gmKeyboardUI, layout 0x21000009).
 *
 * The command list (296 named actions across the 6 retail tabs) is baked from
 * the portal.dat ActionMap (KeybindActions.generated.ts). This registry holds
 * the *current* physical bindings — up to three per command, matching retail's
 * "Mapping 1 / Mapping 2 / Mapping 3" columns — and resolves a key event back
 * to an action id so the router can dispatch.
 *
 * Codes are a canonical string form of `KeyboardEvent.code` with optional
 * modifier prefixes ("Ctrl+", "Alt+", "Shift+", in that order), e.g.
 * "KeyW", "Shift+Digit1", "Backquote". This keeps the registry DOM-free and
 * unit-testable: eventToCode() accepts any {code, shiftKey, …}-shaped object.
 *
 * Conflict policy mirrors retail: within the input maps that can be active at
 * the same time a physical key maps to at most one command, so binding a key
 * that's already in use clears it from its previous owner. Maps that are never
 * co-active (the melee / missile / magic maps, the Quickslot map against the
 * magic map) may share a key — CInputMap::AddMapping @ 0068ef90 only refuses
 * a control that FindConflictingControls finds in one of the ActionMap's
 * co-active maps (INPUT_MAP_COACTIVE).
 *
 * CORE.17.k.b.b.a.g.f — resolution is per active input map, like the retail
 * CInputManager's registered-map list: `setActiveInputMaps` takes the maps in
 * priority order (KeybindDefaults.activeInputMaps) and `resolve` answers with
 * the highest-priority active map's command for the key. In magic mode the
 * digits are Spell Slot 1-9; in every other mode they are Quickslot 1-9.
 */
import { ActionClass } from './KeybindActionClass.js';
import { retailKeyLabel } from './KeyNames.js';
import { KEYBIND_ACTIONS, type KeybindAction } from './KeybindActions.generated.js';
import { ACTION_INPUT_MAP, INPUT_MAP_COACTIVE, RETAIL_SECTION_KEYBINDS } from './KeybindDefaults.generated.js';

/** The maps registered in the world out of combat (KeybindDefaults.activeInputMaps(NonCombat)), inlined to keep this module free of @ac/shared. */
const DEFAULT_ACTIVE_MAPS: number[] = [0xd, 0x1000000d, 0x1000000a, 0x10000002, 0x1000000c, 0x10000009, 0x10000008, 0x10000007, 0x10000006, 0x4, 0x5, 0x3, 0x10];

export const MAPPINGS_PER_ACTION = 3;
export type Mapping = string | null;

export interface KeyLike {
  code: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

const BARE_MODIFIERS = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

/** Canonical code string for a key event (modifier-prefixed `code`). */
export function eventToCode(e: KeyLike): string {
  // A bare modifier press (e.g. ShiftLeft for the run key) is its own code —
  // don't prefix it with itself.
  if (BARE_MODIFIERS.has(e.code)) return e.code;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, e.code].join('+');
}

/**
 * Human-readable label for a canonical code (the dialog's Mapping columns).
 * CORE.17.k.b.b.a.g.f.a — the retail name (KeyNames.retailKeyLabel: the
 * Windows key name DirectInput reports plus the language DAT's four
 * overrides, the metas named as their left key, joined with "+").
 */
export function codeToLabel(code: Mapping): string {
  return retailKeyLabel(code);
}

/** A command another command's new key would take away (the dialog's overwrite prompt). */
export interface KeybindConflict { id: number; slot: number; code: string }

export class KeybindRegistry {
  private bindings = new Map<number, Mapping[]>();
  /** code → every command bound to it (insertion order); resolve() picks by active-map priority. */
  private reverse = new Map<string, number[]>();
  private byId = new Map<number, KeybindAction>();
  private defaults: Record<number, string[]>;
  /** Active input maps, highest priority first (see setActiveInputMaps). */
  private activeMaps: number[] = DEFAULT_ACTIVE_MAPS.slice();
  private activeRank = new Map<number, number>();
  /**
   * Bindings a map holds for commands it does not OWN (ActionMap-wise): the
   * alternate camera map 0x6 re-binds the arrows to Rotate Camera
   * 0x35–0x38, which belong to the camera map 5. input map → code → action.
   * They only resolve while that map is active.
   */
  private sectionReverse = new Map<number, Map<string, number>>();

  /**
   * @param defaults  actionId → up to 3 canonical codes. Actions absent from
   *                  this map start unbound (still selectable in the dialog).
   */
  constructor(defaults: Record<number, string[]> = {}) {
    this.defaults = defaults;
    for (const a of KEYBIND_ACTIONS) this.byId.set(a.id, a);
    this.setActiveInputMaps(DEFAULT_ACTIVE_MAPS);
    // The alternate camera map (registered only while F2 / Numpad-/ is held).
    this.setSectionBindings(0x6, RETAIL_SECTION_KEYBINDS[0x6] ?? {});
    this.resetToDefaults();
  }

  /**
   * The input maps currently registered, highest priority first (the retail
   * CInputManager list order — KeybindDefaults.activeInputMaps(combatMode)).
   * A command whose map is not in the list does not resolve; a command with
   * no known map (not in the ActionMap) ranks below every listed map.
   */
  setActiveInputMaps(maps: readonly number[]): void {
    this.activeMaps = maps.slice();
    this.activeRank.clear();
    maps.forEach((m, i) => { if (!this.activeRank.has(m)) this.activeRank.set(m, i); });
  }

  getActiveInputMaps(): number[] { return this.activeMaps.slice(); }

  /** The input map that owns a command (ActionMap section), or null. */
  inputMapOf(id: number): number | null {
    const m = ACTION_INPUT_MAP[id];
    return m === undefined ? null : m;
  }

  /** Whether two commands can be live at once (ActionMap InputMapConflicts; unknown maps count as co-active). */
  coactive(idA: number, idB: number): boolean {
    const a = this.inputMapOf(idA);
    const b = this.inputMapOf(idB);
    if (a === null || b === null || a === b) return true;
    const list = INPUT_MAP_COACTIVE[a];
    return list ? list.includes(b) : true;
  }

  /** Restore every command to its built-in default binding. */
  resetToDefaults(): void {
    this.bindings.clear();
    for (const a of KEYBIND_ACTIONS) {
      const slots: Mapping[] = [null, null, null];
      const d = this.defaults[a.id];
      if (d) for (let i = 0; i < Math.min(MAPPINGS_PER_ACTION, d.length); i++) slots[i] = d[i];
      this.bindings.set(a.id, slots);
    }
    this.rebuildReverse();
  }

  private rebuildReverse(): void {
    this.reverse.clear();
    for (const [id, slots] of this.bindings) {
      for (const c of slots) {
        if (!c) continue;
        const owners = this.reverse.get(c);
        if (!owners) this.reverse.set(c, [id]);
        else if (!owners.includes(id)) owners.push(id);
      }
    }
  }

  /** All known commands, in generated (class, id) order. */
  actions(): readonly KeybindAction[] { return KEYBIND_ACTIONS; }

  actionsForClass(cls: ActionClass): KeybindAction[] {
    return KEYBIND_ACTIONS.filter((a) => a.cls === cls);
  }

  action(id: number): KeybindAction | null { return this.byId.get(id) ?? null; }

  /** Current Mapping 1/2/3 for a command (copy). */
  getMappings(id: number): Mapping[] {
    return (this.bindings.get(id) ?? [null, null, null]).slice(0, MAPPINGS_PER_ACTION);
  }

  /**
   * Which command (if any) a physical key currently fires: among the commands
   * bound to the key, the one whose input map is active with the highest
   * priority (a command in an inactive map never fires).
   */
  resolve(code: string): number | null {
    let best: number | null = null;
    let bestRank = Infinity;
    for (const id of this.reverse.get(code) ?? []) {
      const map = this.inputMapOf(id);
      const rank = map === null ? this.activeMaps.length : this.activeRank.get(map);
      if (rank === undefined) continue; // the map is not registered
      if (rank < bestRank) { bestRank = rank; best = id; }
    }
    for (const [map, rev] of this.sectionReverse) {
      const id = rev.get(code);
      const rank = this.activeRank.get(map);
      if (id === undefined || rank === undefined) continue;
      if (rank < bestRank) { bestRank = rank; best = id; }
    }
    return best;
  }

  /**
   * resolve(), and a modifier chord with no binding of its own answers as the
   * bare key / control: retail casts spell slot 1 on Shift+1 while walking
   * (MOVE.combination-sweep sweep-cast-walkW), and a meta-qualified mouse
   * press runs the bare button's command.
   */
  resolveOrBare(code: string): number | null {
    const id = this.resolve(code);
    if (id != null) return id;
    const i = code.lastIndexOf('+');
    return i < 0 ? null : this.resolve(code.slice(i + 1));
  }

  /** Register a map's bindings for commands it does not own (see sectionReverse). */
  setSectionBindings(map: number, binds: Record<number, readonly string[]>): void {
    const rev = new Map<string, number>();
    for (const [id, codes] of Object.entries(binds)) for (const c of codes) rev.set(c, Number(id));
    this.sectionReverse.set(map, rev);
  }

  /** Every command bound to a key, whatever its map (the dialog's conflict view). */
  ownersOf(code: string): number[] {
    return (this.reverse.get(code) ?? []).slice();
  }

  /**
   * CORE.17.k.b.b.a.g.f.a — the bindings `code` would take away from OTHER
   * commands if bound to `id` (UIOption_ActionKeyMap::KeyHitHandler @
   * 00489570: FindConflictingInputMaps(m_idInputMap) then
   * FindConflictingControls over each — the commands in a map co-active with
   * this one that hold the same qualified control). Empty when the key is
   * free, or already one of this command's own mappings.
   */
  conflictsFor(id: number, code: string): KeybindConflict[] {
    const out: KeybindConflict[] = [];
    if (!code) return out;
    for (const [otherId, slots] of this.bindings) {
      if (otherId === id || !this.coactive(id, otherId)) continue;
      for (let i = 0; i < slots.length; i++) if (slots[i] === code) out.push({ id: otherId, slot: i, code });
    }
    return out;
  }

  /**
   * Bind `code` to command `id` in slot `slot` (0..2). Retail conflict policy
   * (CInputMap::AddMapping @ 0068ef90): the code is first removed from every
   * command in a map co-active with this one; a command in a map that is
   * never live at the same time keeps it. Pass null to clear the slot.
   */
  setMapping(id: number, slot: number, code: Mapping): void {
    const slots = this.bindings.get(id);
    if (!slots || slot < 0 || slot >= MAPPINGS_PER_ACTION) return;
    if (code) {
      for (const [otherId, other] of this.bindings) {
        if (otherId !== id && !this.coactive(id, otherId)) continue;
        for (let i = 0; i < other.length; i++) if (other[i] === code) other[i] = null;
      }
    }
    slots[slot] = code;
    this.rebuildReverse();
  }

  clearMapping(id: number, slot: number): void {
    this.setMapping(id, slot, null);
  }

  /** Deep copy of all bindings (for the dialog's Revert). */
  snapshot(): Record<number, Mapping[]> {
    const out: Record<number, Mapping[]> = {};
    for (const [id, slots] of this.bindings) out[id] = slots.slice();
    return out;
  }

  restore(snap: Record<number, Mapping[]>): void {
    this.bindings.clear();
    for (const a of KEYBIND_ACTIONS) {
      const s = snap[a.id];
      this.bindings.set(a.id, s ? s.slice(0, MAPPINGS_PER_ACTION) : [null, null, null]);
    }
    this.rebuildReverse();
  }

  /** JSON of every non-empty binding (for localStorage / "Save As"). */
  serialize(): string {
    const out: Record<string, Mapping[]> = {};
    for (const [id, slots] of this.bindings) {
      if (slots.some((s) => s)) out[id] = slots.slice();
    }
    return JSON.stringify(out);
  }

  /**
   * Load bindings from serialize() output, overlaying saved mappings onto the
   * current state. An action id absent from `json` is left as-is (its
   * constructor-default binding from resetToDefaults()) rather than being
   * wiped to unbound — this keeps a save written before an action existed
   * from clobbering that action's shipped default.
   */
  loadSerialized(json: string): void {
    let parsed: Record<string, Mapping[]>;
    try { parsed = JSON.parse(json); } catch { return; }
    for (const a of KEYBIND_ACTIONS) {
      const s = parsed[a.id] ?? parsed[String(a.id)];
      if (!Array.isArray(s)) continue;
      const slots: Mapping[] = [null, null, null];
      for (let i = 0; i < Math.min(MAPPINGS_PER_ACTION, s.length); i++) slots[i] = s[i] ?? null;
      this.bindings.set(a.id, slots);
    }
    this.rebuildReverse();
  }
}
