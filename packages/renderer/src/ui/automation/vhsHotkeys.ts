/**
 * VHS-style hotkeys (docs/vtank-parity-gaps.md §5.4): the keys a player sets
 * for the automation plugins' actions, in a window of their own, the way the
 * Virindi Hotkey System kept them (Jake, 2026-10-12: not in retail's Keyboard
 * Config, whose command list is the DAT's ActionMap).
 *
 * What VHS did (its virindi.net wiki page and screenshot VHS_Main.jpg): a
 * list of every plugin's hotkeys (key, plugin, name, description) with Set
 * (then press the key), Unset, Reset (the plugin's default) and Add VVS
 * (a hotkey that opens or closes a Virindi Views window). No Virindi code is
 * used; VirindiHotkeySystem.dll is closed and never opened.
 *
 * The rules this module keeps:
 * - A hotkey fires only in the world and never while typing (main.ts calls
 *   onKey after its text-field guard).
 * - It never shadows a retail key silently: a key retail's Keyboard Config
 *   binds is refused at Set, with the retail command's name. A chord whose
 *   bare key is a retail command is allowed (the chord only fell back to the
 *   bare key) and the window says what it replaces, except a movement key,
 *   which would also move you. A key retail binds later stays retail's and
 *   the row says so.
 * - Bindings are per character in browser storage, as UB keeps its own.
 *
 * DOM-free: the window (VhsWindow.ts) draws it and tests drive it directly.
 */
import { MOVEMENT_CANONICAL } from '../../input/KeybindDefaults.js';
import { codeToLabel } from '../../input/KeybindRegistry.js';

/** One hotkey a plugin registered. */
export interface VhsHotkey {
  /** Stable key: `plugin/name`. */
  id: string;
  /** The plugin column (VTank, UtilityBelt, VVS). */
  plugin: string;
  name: string;
  description: string;
  /** The plugin's default key (Reset), a KeybindRegistry code, or null. */
  defaultCode: string | null;
  /** What pressing it does; lines for chat. */
  run(): string[] | Promise<string[]>;
}

/** What the model reads of retail's bindings (KeybindRegistry fits). */
export interface RetailKeys {
  ownersOf(code: string): number[];
  action(id: number): { name: string } | null;
}

export interface VhsStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** The saved document: a key per hotkey id (null: Unset; absent: the default), and the windows added with Add VVS. */
export interface VhsDoc { keys: Record<string, string | null>; vvs: string[] }

export const vhsStorageKey = (world: string, character: string): string => `acjs.vhs.v1.${world.toLowerCase()}.${character.toLowerCase()}`;

/** Keys the client keeps for itself (main.ts's system keys): Escape also cancels a Set. */
export const VHS_SYSTEM_KEYS: ReadonlySet<string> = new Set(['Escape', 'F7']);

const BARE_MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

/**
 * A key's name in the window: retail's own key names (KeyNames.retailKeyLabel),
 * except Pause, which Windows' key-name table calls "Num Lock" (retail's
 * dialog shows that quirk); VHS showed "pause".
 */
export function vhsKeyLabel(code: string | null): string {
  if (!code) return '';
  return code.split('+').map((part) => (part === 'Pause' ? 'Pause' : codeToLabel(part))).join('+');
}

/** How a key stands against retail's bindings. */
export type RetailClash =
  | { kind: 'taken'; names: string[] }
  | { kind: 'moves'; names: string[] }
  | { kind: 'replaces'; names: string[] };

/** Whether `code` clashes with a retail binding (see the module comment). */
export function retailClash(code: string, retail: RetailKeys | null): RetailClash | null {
  if (!retail) return null;
  const names = (ids: number[]) => [...new Set(ids.map((id) => retail.action(id)?.name ?? `command ${id}`))];
  const exact = retail.ownersOf(code);
  if (exact.length) return { kind: 'taken', names: names(exact) };
  const i = code.lastIndexOf('+');
  if (i < 0) return null;
  const bare = retail.ownersOf(code.slice(i + 1));
  if (!bare.length) return null;
  if (bare.some((id) => MOVEMENT_CANONICAL[id] !== undefined)) return { kind: 'moves', names: names(bare) };
  return { kind: 'replaces', names: names(bare) };
}

export interface VhsDeps {
  /** Every hotkey registered now (the plugins' lists can change: a meta's states). */
  list(): VhsHotkey[];
  storage(): VhsStorage | null;
  /** `world` and `character` for the storage key; null before a character is in the world. */
  who(): { world: string; character: string } | null;
  retail(): RetailKeys | null;
  report(line: string): void;
}

export interface VhsRow {
  hotkey: VhsHotkey;
  code: string | null;
  label: string;
  /** A retail binding the key has gained since (it stays retail's), else null. */
  clash: RetailClash | null;
}

export class VhsHotkeys {
  /** The row the window has selected (a hotkey id). */
  selected: string | null = null;
  /** The hotkey waiting for its key after Set, or null. */
  capturing: string | null = null;
  /** The window's line (what Set did, why it refused). */
  message = '';
  /** The window's redraw, while it is open. */
  onChange: () => void = () => {};
  /** Whether the window is open: a Set left waiting when it closed is dropped. */
  windowOpen: () => boolean = () => true;

  private doc: VhsDoc | null = null;
  private docKey: string | null = null;

  constructor(private readonly deps: VhsDeps) {}

  private load(): VhsDoc {
    const w = this.deps.who();
    const key = w ? vhsStorageKey(w.world, w.character) : null;
    if (this.doc && this.docKey === key) return this.doc;
    this.docKey = key;
    let d: VhsDoc = { keys: {}, vvs: [] };
    try {
      const raw = key ? this.deps.storage()?.getItem(key) : null;
      if (raw) {
        const j = JSON.parse(raw) as Partial<VhsDoc>;
        const keys: Record<string, string | null> = {};
        if (j.keys && typeof j.keys === 'object') for (const [k, v] of Object.entries(j.keys)) if (v === null || typeof v === 'string') keys[k] = v;
        d = { keys, vvs: Array.isArray(j.vvs) ? j.vvs.filter((x): x is string => typeof x === 'string') : [] };
      }
    } catch { /* unreadable: the defaults */ }
    this.doc = d;
    return d;
  }

  private save(): void {
    const d = this.load();
    if (!this.docKey) return;
    try { this.deps.storage()?.setItem(this.docKey, JSON.stringify(d)); } catch { /* blocked storage: kept for this page */ }
  }

  /** The windows added with Add VVS (their titles). */
  get vvs(): readonly string[] { return this.load().vvs; }

  /** Add VVS: add or remove a window's toggle hotkey. */
  toggleVvs(title: string): void {
    const d = this.load();
    d.vvs = d.vvs.includes(title) ? d.vvs.filter((x) => x !== title) : [...d.vvs, title];
    this.save();
    this.onChange();
  }

  /** A hotkey's key now: the player's, else the plugin's default. */
  codeOf(h: VhsHotkey): string | null {
    const k = this.load().keys;
    return Object.prototype.hasOwnProperty.call(k, h.id) ? k[h.id] ?? null : h.defaultCode;
  }

  rows(): VhsRow[] {
    const retail = this.deps.retail();
    return this.deps.list().map((h) => {
      const code = this.codeOf(h);
      const c = code ? retailClash(code, retail) : null;
      return { hotkey: h, code, label: vhsKeyLabel(code), clash: c && c.kind !== 'replaces' ? c : null };
    });
  }

  private find(id: string | null): VhsHotkey | null {
    return id ? this.deps.list().find((h) => h.id === id) ?? null : null;
  }

  /** Set: the next key pressed becomes the selected hotkey's. */
  beginSet(): void {
    const h = this.find(this.selected);
    if (!h) { this.message = 'Select a hotkey first.'; this.onChange(); return; }
    this.capturing = h.id;
    this.message = `Press the key for ${h.name}. Escape cancels.`;
    this.onChange();
  }

  /** Unset: no key fires the selected hotkey. */
  unset(): void {
    const h = this.find(this.selected);
    if (!h) { this.message = 'Select a hotkey first.'; this.onChange(); return; }
    this.capturing = null;
    this.load().keys[h.id] = null;
    this.save();
    this.message = `${h.name}: no key.`;
    this.onChange();
  }

  /** Reset: the plugin's default key (checked against retail's keys like any other). */
  reset(): void {
    const h = this.find(this.selected);
    if (!h) { this.message = 'Select a hotkey first.'; this.onChange(); return; }
    this.capturing = null;
    if (!h.defaultCode) {
      this.load().keys[h.id] = null;
      this.save();
      this.message = `${h.name} has no default key.`;
      this.onChange();
      return;
    }
    this.assign(h, h.defaultCode);
  }

  /** Give `h` the key `code`, or refuse it (a retail key, a system key). */
  assign(h: VhsHotkey, code: string): boolean {
    this.capturing = null;
    const label = vhsKeyLabel(code);
    if (VHS_SYSTEM_KEYS.has(code)) { this.message = `${label} is the game's own key. Pick another.`; this.onChange(); return false; }
    const clash = retailClash(code, this.deps.retail());
    if (clash?.kind === 'taken') {
      this.message = `${label} is ${clash.names.join(', ')} in Keyboard Config. Unbind it there, or pick another key.`;
      this.onChange();
      return false;
    }
    if (clash?.kind === 'moves') {
      this.message = `${label} would also move you (${clash.names.join(', ')}). Pick another key.`;
      this.onChange();
      return false;
    }
    const d = this.load();
    // One key, one hotkey: another hotkey on this key loses it.
    const others = this.deps.list().filter((o) => o.id !== h.id && this.codeOf(o) === code);
    for (const o of others) d.keys[o.id] = null;
    d.keys[h.id] = code;
    this.save();
    const notes = [
      ...(others.length ? [`taken from ${others.map((o) => o.name).join(', ')}`] : []),
      ...(clash?.kind === 'replaces' ? [`it no longer does ${clash.names.join(', ')}`] : []),
    ];
    this.message = `${h.name}: ${label}${notes.length ? ` (${notes.join('; ')})` : ''}.`;
    this.onChange();
    return true;
  }

  /**
   * A key pressed in the world (main.ts, after its text-field guard). True
   * when the hotkeys took it: a Set waiting for its key, or a hotkey's key
   * that retail doesn't bind exactly.
   */
  onKey(code: string, repeat = false): boolean {
    if (this.capturing && !this.windowOpen()) { this.capturing = null; this.message = ''; }
    if (this.capturing) {
      if (BARE_MODIFIERS.has(code)) return true; // the chord's main key is still to come
      const h = this.find(this.capturing);
      if (code === 'Escape' || !h) { this.capturing = null; this.message = 'Set cancelled.'; this.onChange(); return true; }
      this.assign(h, code);
      return true;
    }
    const retail = this.deps.retail();
    if (retail && retail.ownersOf(code).length) return false;
    const h = this.deps.list().find((x) => this.codeOf(x) === code);
    if (!h) return false;
    if (repeat) return true; // a held key fires once
    void Promise.resolve(h.run()).then((lines) => { for (const l of lines) this.deps.report(l); this.onChange(); }, (e: unknown) => this.deps.report(`${h.name}: ${String((e as Error)?.message ?? e)}`));
    return true;
  }
}
