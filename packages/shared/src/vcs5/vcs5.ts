/**
 * Virindi Chat System 5 (VCS5): the rule model, rebuilt clean-room from its behaviour
 * (docs/plugin-specs/vcs5.md; virindi.net wiki and screenshots only; VCS5 is closed, no code or art).
 *
 * VCS sits between a chat line and the chat windows. A line can carry a preset (a plugin's category,
 * or one of AC's built-ins); a preset the player has set routes the line to its windows, recolours it
 * and fires its action. Otherwise the Patterns tab's rules are tried, top to bottom.
 *
 * Window numbers are the plugin API's (VCS_Connector, MIT): 1 = main chat, 2–5 = floating chat
 * windows 1–4. The Presets tab's toggles M / 1–4 are the same windows (M = 1).
 *
 * Colours are AC's own chat palette (`RETAIL_CHAT_COLORS`, from the retail client), named as VCS names
 * them (LightBlue, Orange, Yellow in its screenshots); `Any` keeps the line's own colour.
 *
 * Ours, where VCS's behaviour is unknown (spec §2, §6):
 * - A set preset decides its line: the patterns don't run for it. Patterns run top to bottom and the
 *   first match wins; its action fires once.
 * - A pattern's Windows box takes window digits ("13" = main + floating window 2); empty keeps the
 *   line where it would have gone (only the colour and the action apply). A set preset with no windows
 *   hides its line ("having none selected will eat your tells").
 * - Regex patterns are anchored to the whole line, as plain ones are.
 */
import { RETAIL_CHAT_COLORS } from '../enums/ChatMessageType.js';

/** Main chat in VCS's numbering; floating chat windows 1–4 are 2–5. */
export const VCS_MAIN = 1;
export const VCS_WINDOWS = [1, 2, 3, 4, 5] as const;

/** AC's chat palette by VCS's names (`RETAIL_CHAT_COLORS`, the retail client's named colours). */
export const VCS_COLORS: Readonly<Record<string, string>> = {
  Green: RETAIL_CHAT_COLORS.green,
  White: RETAIL_CHAT_COLORS.white,
  Grey: RETAIL_CHAT_COLORS.grey,
  Yellow: RETAIL_CHAT_COLORS.yellow,
  Tan: RETAIL_CHAT_COLORS.tan,
  Pink: RETAIL_CHAT_COLORS.pink,
  Orange: RETAIL_CHAT_COLORS.orange,
  BlueGrey: RETAIL_CHAT_COLORS.blueGrey,
  DarkRed: RETAIL_CHAT_COLORS.darkRed,
  LightRed: RETAIL_CHAT_COLORS.lightRed,
  LightBlue: RETAIL_CHAT_COLORS.lightBlue,
  Cyan: RETAIL_CHAT_COLORS.cyan,
  BrightPurple: RETAIL_CHAT_COLORS.brightPurple,
  BrightRed: RETAIL_CHAT_COLORS.brightRed,
};
export const VCS_ANY = 'Any';
/** Change to: Filter hides the line. */
export const VCS_FILTER = 'Filter';

/** The palette name of a CSS colour (`#rrggbb` or `rgb(r, g, b)`), or null when it isn't one of AC's. */
export function vcsColorName(css: string): string | null {
  const hex = cssHex(css);
  if (!hex) return null;
  for (const [name, v] of Object.entries(VCS_COLORS)) if (v.toLowerCase() === hex) return name;
  return null;
}

function cssHex(css: string): string | null {
  const s = css.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (!m) return null;
  return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
}

/** A Presets row: a plugin's category (RegisterPreset). */
export interface VcsPresetDef { plugin: string; category: string; description: string }
/** A set preset: its windows (1–5), colour name or Any, action number (0 = none). */
export interface VcsPresetSetting { windows: number[]; color: string; action: number }
/** A Patterns rule. */
export interface VcsPattern { pattern: string; regex: boolean; patternColor: string; changeTo: string; windows: number[]; action: number }
/** An Actions row. `sound` is a portal.dat wave (0x0A…) in ours; `soundName` its label. */
export interface VcsAction { id: number; sound: number | null; soundName: string; chatboxDo: string; tellTarget: string }

export interface VcsSettings { v: 1; presets: Record<string, VcsPresetSetting>; patterns: VcsPattern[]; actions: VcsAction[] }

export const emptyVcsSettings = (): VcsSettings => ({ v: 1, presets: {}, patterns: [], actions: [] });

/** A new pattern rule's fields (spec §5): Change to Any, Action 1, no windows, Pattern color Any, plain. */
export const newVcsPattern = (): VcsPattern => ({ pattern: '', regex: false, patternColor: VCS_ANY, changeTo: VCS_ANY, windows: [], action: 1 });

export const vcsPresetKey = (plugin: string, category: string): string => `${plugin}\u0001${category}`;

/** The built-in presets VCS registers for AC's own text (the Presets tab in [S-new]). */
export const VCS_AC_PRESETS: readonly VcsPresetDef[] = [
  { plugin: 'AC', category: 'MAtEvade', description: 'Melee evades when you are attacking.' },
  { plugin: 'AC', category: 'MDfEvade', description: 'Melee evades when you are defending.' },
  { plugin: 'AC', category: 'NPCTellInc', description: 'An incoming tell from an NPC.' },
  { plugin: 'AC', category: 'TellInc', description: 'An incoming tell from another player.' },
];
/** VTank's registrations (the Presets tab in [S-new]). */
export const VCS_VTANK_PRESETS: readonly VcsPresetDef[] = [
  { plugin: 'VTank', category: 'CommandLine', description: 'Generic plugin text' },
  { plugin: 'VTank', category: 'Echo', description: 'Messages from /vt echo' },
  { plugin: 'VTank', category: 'Errors', description: 'Errors which stop operation' },
  { plugin: 'VTank', category: 'Logging', description: '/vt log messages' },
  { plugin: 'VTank', category: 'MetaUpdates', description: 'Meta status updates' },
  { plugin: 'VTank', category: 'Warnings', description: 'Non-fatal warnings' },
];
/** Mag-Tools' registrations (its PluginCore: plugin name "MagTools"). */
export const VCS_MAGTOOLS_PRESETS: readonly VcsPresetDef[] = [
  { plugin: 'MagTools', category: 'CommandLine', description: 'Generic plugin text' },
  { plugin: 'MagTools', category: 'Errors', description: 'Error messages' },
  { plugin: 'MagTools', category: 'IDs', description: 'ID messages' },
];

/**
 * A pattern as a matcher (spec §2): case-sensitive and whole-line. Plain: `*` is any run of text and
 * every other character is literal. Regex: a JavaScript regular expression (VCS's were .NET's), anchored.
 * A bad regex matches nothing. Shared with UtilityBelt's chat filter when that is built.
 */
export function vcsMatcher(pattern: string, regex: boolean): (text: string) => boolean {
  let re: RegExp;
  try {
    re = regex
      ? new RegExp(`^(?:${pattern})$`, 's')
      : new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
  } catch { return () => false; }
  return (text) => re.test(text);
}

/** A line as VCS sees it: its text and colour, and its preset when it carries one. */
export interface VcsLine { text: string; color: string; preset?: { plugin: string; category: string } | null }

/** What VCS does with a line. */
export interface VcsRoute {
  /** Hide the line (a set preset with no windows, or a pattern's Filter). */
  hide: boolean;
  /** The windows to show it in (1–5); empty = where it would have gone. */
  windows: number[];
  /** Its colour (CSS). */
  color: string;
  /** The action to fire, if any. */
  action: VcsAction | null;
  /** What decided it: a preset's key, or a pattern's index. */
  by: { preset: string } | { pattern: number };
}

/** Windows from a Windows box's digits (1–5, each once, in order). */
export function vcsParseWindows(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) { const n = Number(ch); if (n >= 1 && n <= 5 && !out.includes(n)) out.push(n); }
  return out.sort((a, b) => a - b);
}
/** The Presets tab's Wnds cell: M for main chat, 1–4 for the floating windows ("M3"). */
export function vcsPresetWindowsText(windows: readonly number[]): string {
  return [...windows].sort((a, b) => a - b).map((w) => (w === VCS_MAIN ? 'M' : String(w - 1))).join('');
}

export interface VcsStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

/** The model: the preset registry, the player's settings (kept per character), and routing. */
export class VcsModel {
  private registry: VcsPresetDef[] = [];
  private cache: { who: string; s: VcsSettings } | null = null;
  private matchers = new Map<string, (t: string) => boolean>();
  /** Runs after any change the window shows. */
  onChange: (() => void) | null = null;

  constructor(private readonly storage: () => VcsStorage | null, private readonly who: () => string) {
    for (const p of VCS_AC_PRESETS) this.register(p.plugin, p.category, p.description);
  }

  /** RegisterPreset: a Presets row (once per plugin + category). AC's built-ins stay last, as in VCS's list. */
  register(plugin: string, category: string, description: string): void {
    if (this.registry.some((p) => p.plugin === plugin && p.category === category)) return;
    const def = { plugin, category, description };
    const firstAc = plugin === 'AC' ? -1 : this.registry.findIndex((p) => p.plugin === 'AC');
    if (firstAc >= 0) this.registry.splice(firstAc, 0, def); else this.registry.push(def);
    this.onChange?.();
  }
  presets(): readonly VcsPresetDef[] { return this.registry; }

  private key(): string { return `acjs.vcs5.${this.who()}`; }

  settings(): VcsSettings {
    const who = this.who();
    if (this.cache?.who === who) return this.cache.s;
    let s = emptyVcsSettings();
    try {
      const raw = this.storage()?.getItem(this.key());
      if (raw) s = normalizeVcsSettings(JSON.parse(raw));
    } catch { /* unreadable: defaults */ }
    this.cache = { who, s };
    return s;
  }

  /** Change the settings and keep them (per character). */
  update(fn: (s: VcsSettings) => void): void {
    const s = this.settings();
    fn(s);
    this.cache = { who: this.who(), s };
    try { this.storage()?.setItem(this.key(), JSON.stringify(s)); } catch { /* storage blocked: this page only */ }
    this.onChange?.();
  }

  preset(plugin: string, category: string): VcsPresetSetting | null { return this.settings().presets[vcsPresetKey(plugin, category)] ?? null; }
  /** Set (or change) a preset's fields; an unset preset starts with no windows, Any, action 0. */
  setPreset(plugin: string, category: string, patch: Partial<VcsPresetSetting>): void {
    this.update((s) => {
      const k = vcsPresetKey(plugin, category);
      const cur = s.presets[k] ?? { windows: [], color: VCS_ANY, action: 0 };
      s.presets[k] = { ...cur, ...patch, ...(patch.windows ? { windows: [...patch.windows].sort((a, b) => a - b) } : {}) };
    });
  }
  /** Unset: the plugin's own windows and colour apply again. */
  unsetPreset(plugin: string, category: string): void { this.update((s) => { delete s.presets[vcsPresetKey(plugin, category)]; }); }

  action(id: number): VcsAction | null { return id > 0 ? this.settings().actions.find((a) => a.id === id) ?? null : null; }

  private matcher(p: VcsPattern): (t: string) => boolean {
    const k = `${p.regex ? 'r' : 'p'}${p.pattern}`;
    let m = this.matchers.get(k);
    if (!m) { m = vcsMatcher(p.pattern, p.regex); this.matchers.set(k, m); }
    return m;
  }

  /** What VCS does with `line`, or null when nothing applies (the line goes on as it would). */
  route(line: VcsLine): VcsRoute | null {
    const s = this.settings();
    const colorOf = (name: string) => (name === VCS_ANY ? line.color : VCS_COLORS[name] ?? line.color);
    if (line.preset) {
      const k = vcsPresetKey(line.preset.plugin, line.preset.category);
      const set = s.presets[k];
      if (set) return { hide: set.windows.length === 0, windows: [...set.windows], color: colorOf(set.color), action: this.action(set.action), by: { preset: k } };
    }
    const lineColor = vcsColorName(line.color);
    for (let i = 0; i < s.patterns.length; i++) {
      const p = s.patterns[i]!;
      if (!p.pattern) continue;
      if (p.patternColor !== VCS_ANY && p.patternColor !== lineColor) continue;
      if (!this.matcher(p)(line.text)) continue;
      const hide = p.changeTo === VCS_FILTER;
      return { hide, windows: [...p.windows], color: hide ? line.color : colorOf(p.changeTo), action: this.action(p.action), by: { pattern: i } };
    }
    return null;
  }
}

/** Stored settings, checked field by field (anything unreadable is dropped). */
export function normalizeVcsSettings(raw: unknown): VcsSettings {
  const s = emptyVcsSettings();
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  const wins = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= 5) : []);
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
  const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);
  if (r.presets && typeof r.presets === 'object') {
    for (const [k, v] of Object.entries(r.presets as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const p = v as Record<string, unknown>;
      s.presets[k] = { windows: wins(p.windows), color: str(p.color, VCS_ANY), action: int(p.action) };
    }
  }
  if (Array.isArray(r.patterns)) {
    for (const v of r.patterns) {
      if (!v || typeof v !== 'object') continue;
      const p = v as Record<string, unknown>;
      s.patterns.push({ pattern: str(p.pattern, ''), regex: p.regex === true, patternColor: str(p.patternColor, VCS_ANY), changeTo: str(p.changeTo, VCS_ANY), windows: wins(p.windows), action: int(p.action) });
    }
  }
  if (Array.isArray(r.actions)) {
    for (const v of r.actions) {
      if (!v || typeof v !== 'object') continue;
      const a = v as Record<string, unknown>;
      const id = int(a.id);
      if (!id) continue;
      s.actions.push({ id, sound: Number.isInteger(a.sound) ? (a.sound as number) : null, soundName: str(a.soundName, ''), chatboxDo: str(a.chatboxDo, ''), tellTarget: str(a.tellTarget, '') });
    }
  }
  return s;
}

/**
 * VTank's lines sorted into its six VCS categories, from what our engine says (ours: VTank's own split is
 * unknown beyond the descriptions). `/vt log` lines are Logging; the rest without a category from their
 * source are CommandLine.
 */
export type VtVcsCategory = 'CommandLine' | 'Echo' | 'Errors' | 'Logging' | 'MetaUpdates' | 'Warnings';
export function vtVcsCategory(text: string, hint?: VtVcsCategory | null): VtVcsCategory {
  if (hint) return hint;
  if (text.startsWith('[VT log ')) return 'Logging';
  return 'CommandLine';
}

/** Tell forwarding's line: `/t <target>, <line>` (ours). VCS's own forwarded format is unknown (spec §6). */
export function vcsForwardCommand(target: string, line: string): string {
  return `/t ${target}, ${line}`;
}
