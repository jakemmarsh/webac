/**
 * Mag-Tools' options (docs/plugin-specs/magtools.md §3, §4): every setting with its `/mt opt`
 * path, label, default, tab and storage scope, over an injected store. Labels and paths are the
 * plugin's own, verbatim.
 *
 * Status:
 * - `build`: ours to run;
 * - `covered`: UtilityBelt AutoVendor / VirindiTank do it;
 * - `optional`: kept for parity;
 * - `dead`: Windows-only plumbing (window frame, FPS caps, chat size). Under the No Dead-End UI
 *   rule these are not listed, not settable through `/mt opt`, and never shown.
 */

export type MtOptionTab =
  | 'Misc/Options' | 'Misc/Filters' | 'Misc/Client'
  | 'Trackers/Mana' | 'Trackers/Combat/Options' | 'Trackers/Corpse/Options' | 'Trackers/Player/Options'
  | 'Loggers/Options';

export type MtOptionStatus = 'build' | 'covered' | 'optional' | 'dead';

export interface MtOptionDef {
  /** `/mt opt` path, `<Group>.<Field>`. */
  path: string;
  /** The row / checkbox text. */
  label: string;
  /** The setting's own description where it differs from the checkbox text. */
  description?: string;
  type: 'bool' | 'int';
  default: boolean | number;
  tab: MtOptionTab;
  /** Every Mag-Tools setting is global (one Mag-Tools.xml for all characters, accounts and servers). */
  scope: 'global';
  status: MtOptionStatus;
  /** XPath in Mag-Tools.xml where it differs from `<Group>/<Field>`. */
  xpath?: string;
  /** Turning this on also turns this option on. */
  parent?: string;
}

const b = (path: string, label: string, def: boolean, tab: MtOptionTab, status: MtOptionStatus, extra: Partial<MtOptionDef> = {}): MtOptionDef =>
  ({ path, label, type: 'bool', default: def, tab, scope: 'global', status, ...extra });

/** Misc → Options, in display order (spec §3.1), then its integer. */
const MISC_OPTIONS: MtOptionDef[] = [
  b('ItemInfoOnIdent.Enabled', 'Show Item Info On Ident', true, 'Misc/Options', 'build'),
  b('ItemInfoOnIdent.ShowBuffedValues', '- Show Item Info Buffed* Values', true, 'Misc/Options', 'build', { parent: 'ItemInfoOnIdent.Enabled' }),
  b('ItemInfoOnIdent.ShowValueAndBurden', '- Show Value and Burden', false, 'Misc/Options', 'build', { parent: 'ItemInfoOnIdent.Enabled' }),
  b('ItemInfoOnIdent.LeftClickIdent', '- Ident Items on Left Click', false, 'Misc/Options', 'build', { parent: 'ItemInfoOnIdent.Enabled' }),
  b('ItemInfoOnIdent.AutoClipboard', '- Clipboard Item Info On Ident', false, 'Misc/Options', 'build', { parent: 'ItemInfoOnIdent.Enabled' }),
  b('AutoBuySell.Enabled', 'Auto Buy/Sell Enabled', true, 'Misc/Options', 'covered'),
  b('AutoBuySell.TestMode', '- Auto Buy/Sell Test Mode', false, 'Misc/Options', 'covered', { parent: 'AutoBuySell.Enabled' }),
  b('AutoTradeAdd.Enabled', 'Auto Add To Trade Enabled', false, 'Misc/Options', 'build'),
  b('AutoTradeAccept.Enabled', 'Auto Trade Accept Enabled', false, 'Misc/Options', 'build'),
  b('Looting.AutoLootChests', 'Auto Loot Chests', true, 'Misc/Options', 'covered'),
  b('Looting.AutoLootCorpses', 'Auto Loot Corpses', true, 'Misc/Options', 'covered'),
  b('Looting.AutoLootMyCorpses', 'Auto Loot My Corpses', true, 'Misc/Options', 'covered', { xpath: 'Looting/AutoLootMyCorpse' }),
  b('Looting.LootSalvage', 'Auto Loot Salvage', false, 'Misc/Options', 'covered'),
  b('Tinkering.AutoClickYes', 'Auto Click Yes on 100%', false, 'Misc/Options', 'build'),
  b('InventoryManagement.InventoryLogger', 'Inventory Logger Enabled', false, 'Misc/Options', 'optional'),
  b('InventoryManagement.AetheriaRevealer', 'Auto Reveal Aetheria', true, 'Misc/Options', 'build'),
  b('InventoryManagement.HeartCarver', 'Auto Carve Hearts', false, 'Misc/Options', 'build'),
  b('InventoryManagement.ShatteredKeyFixer', 'Auto Fix Shattered Keys', false, 'Misc/Options', 'build'),
  b('InventoryManagement.KeyRinger', 'Auto Ring Keys', false, 'Misc/Options', 'build'),
  b('InventoryManagement.KeyDeringer', 'Auto Dering Keys', false, 'Misc/Options', 'build'),
  b('Misc.OpenMainPackOnLogin', 'Open Main Pack On Login', true, 'Misc/Options', 'build'),
  b('Misc.MaximizeChatOnLogin', 'Maximize Chat On Login', false, 'Misc/Options', 'dead'),
  b('Misc.LogOutOnDeath', 'Log Out on Death', false, 'Misc/Options', 'build'),
  b('Misc.DebuggingEnabled', 'Debugging Enabled', true, 'Misc/Options', 'optional'),
  b('Misc.VerboseDebuggingEnabled', 'Verbose Debugging Enabled', false, 'Misc/Options', 'optional'),
  { path: 'Misc.OutputTargetWindow', label: 'Target Output Window:', type: 'int', default: 1, tab: 'Misc/Options', scope: 'global', status: 'build' },
];

/** Misc → Filters, in display order (spec §3.2); all default off. */
const FILTERS: MtOptionDef[] = ([
  ['AttackEvades', 'Attack Evades'], ['DefenseEvades', 'Defense Evades'], ['AttackResists', 'Attack Resists'],
  ['DefenseResists', 'Defense Resists'], ['NPKFails', 'NPK Fails'], ['DirtyFighting', 'Dirty Fighting'],
  ['MonsterDeaths', 'Monster Deaths'], ['SpellCastingMine', 'Spell Casting - Mine'], ['SpellCastingOthers', 'Spell Casting - Others'],
  ['SpellCastFizzles', 'Spell Cast Fizzles'], ['CompUsage', 'Comp Usage'], ['SpellExpires', 'Spell Expires'],
  ['HealingKitSuccess', 'Healing Kit Success'], ['HealingKitFail', 'Healing Kit Fail'], ['Salvaging', 'Salvaging'],
  ['SalvagingFails', 'Salvaging Fails'], ['AuraOfCraftman', 'Aura Of Craftman Spam'], ['ManaStoneUsage', 'Mana Stone Usage'],
  ['TradeBuffBotSpam', 'Trade/Buff Bot Spam'], ['FailedAssess', 'Someone failed to assess you'],
  ['KillTaskComplete', 'Kill Task Complete'], ['VendorTells', 'Vendor Tells'], ['MonsterTell', 'Monster Tells'],
  ['NpcChatter', 'NPC Chatter'], ['MasterArbitratorSpam', 'Master Arbitrator Spam'],
  ['AllMasterArbitratorChat', 'All Master Arbitrator Chat'], ['StatusTextYoureTooBusy', "Status Text: You're too busy!"],
  ['StatusTextCasting', 'Status Text: Casting ...'], ['StatusTextAll', 'Status Text: All'],
] as const).map(([field, label]) => b(`Filters.${field}`, label, false, 'Misc/Filters', 'build', field === 'NpcChatter' ? { xpath: 'Filters/NPCChatter' } : {}));

/** Options on the tracker and logger tabs (spec §3.3). */
const TAB_OPTIONS: MtOptionDef[] = [
  b('ManaManagement.AutoRecharge', 'Recharge', true, 'Trackers/Mana', 'covered', { description: 'Auto Recharge Mana' }),
  b('CombatTracker.Persistent', 'Keep Persistent Stats', true, 'Trackers/Combat/Options', 'build', { description: 'Keep Stats Persistent' }),
  b('CombatTracker.ExportOnLogOff', 'Export Current Stats On LogOff', false, 'Trackers/Combat/Options', 'build', { description: 'Export Stats on LogOff' }),
  b('CombatTracker.SortAlphabetically', 'Sort Alphabetically', false, 'Trackers/Combat/Options', 'build'),
  b('CorpseTracker.Enabled', 'Corpse Tracker Enabled', true, 'Trackers/Corpse/Options', 'build'),
  b('CorpseTracker.Persistent', 'Keep Persistent Stats', true, 'Trackers/Corpse/Options', 'build', { description: 'Keep Stats Persistent' }),
  b('CorpseTracker.TrackAllCorpses', 'Track All Corpses', false, 'Trackers/Corpse/Options', 'build'),
  b('CorpseTracker.TrackFellowCorpses', 'Track Fellow Corpses', false, 'Trackers/Corpse/Options', 'build'),
  b('CorpseTracker.TrackPermittedCorpses', 'Track Permitted Corpses', true, 'Trackers/Corpse/Options', 'build'),
  b('PlayerTracker.Enabled', 'Player Tracker Enabled', false, 'Trackers/Player/Options', 'build'),
  b('PlayerTracker.Persistent', 'Keep Persistent Stats', false, 'Trackers/Player/Options', 'build', { description: 'Keep Stats Persistent' }),
  b('ChatLogger.Persistent', 'Keep Persistent Logs', true, 'Loggers/Options', 'build', { description: 'Keep Logs Persistent' }),
  b('Misc.RemoveWindowFrame', 'Remove Window Frame', false, 'Misc/Client', 'dead'),
  { path: 'Misc.NoFocusFPS', label: 'No Focus FPS', type: 'int', default: 10, tab: 'Misc/Client', scope: 'global', status: 'dead' },
  { path: 'Misc.MaxFPS', label: 'Max FPS', type: 'int', default: 0, tab: 'Misc/Client', scope: 'global', status: 'dead' },
];

/** Every Mag-Tools setting, dead ones included (filter on `status`). */
export const MT_OPTIONS: readonly MtOptionDef[] = [...MISC_OPTIONS, ...FILTERS, ...TAB_OPTIONS];

/** The chat logger's two groups × six channels (not `/mt opt` settings: Groups is an array upstream). Group 1 Tells defaults on. */
export const MT_CHAT_LOGGER_CHANNELS = ['Area', 'Tells', 'Fellowship', 'General', 'Trade', 'Allegiance'] as const;
export type MtChatLoggerChannel = typeof MT_CHAT_LOGGER_CHANNELS[number];
export function mtChatLoggerDefault(group: 1 | 2, channel: MtChatLoggerChannel): boolean {
  return group === 1 && channel === 'Tells';
}

/** The On Login / On Login Complete / Periodic command lists (Tools → Character and Tools → Server, spec §4). */
export const MT_COMMAND_LISTS = ['OnLoginCommands', 'OnLoginCompleteCommands', 'PeriodicCommands'] as const;
export type MtCommandList = typeof MT_COMMAND_LISTS[number];
/** Storage key for a command list: per account + server + character (Character tab) or per server (Server tab). */
export function mtCommandListKey(list: MtCommandList, scope: { account: string; server: string; character: string } | { server: string }): string {
  return 'character' in scope ? `_${scope.account}_${scope.server}/${scope.character}/${list}` : `_${scope.server}/${list}`;
}
/** Storage key for AutoTradeAccept's whitelist (global; each entry a regex anchored ^…$). */
export const MT_TRADE_WHITELIST_KEY = 'AutoTradeAccept.Whitelist';

/** Where options persist (one global store, as upstream's Mag-Tools.xml). Values are text: `True` / `False`, integers. */
export interface MtOptionStorage {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

const byPath = new Map(MT_OPTIONS.map((o) => [o.path.toLowerCase(), o]));

/** .NET bool.ToString(). */
const boolText = (v: boolean): string => (v ? 'True' : 'False');

/** Mag-Tools' settings over a store. */
export class MtOptions {
  constructor(private readonly store: MtOptionStorage) {}

  /** The definition for a path (case-insensitive); dead options are not found. */
  def(path: string): MtOptionDef | null {
    const d = byPath.get(path.trim().toLowerCase());
    return d && d.status !== 'dead' ? d : null;
  }

  /** The options shown and listed (dead ones dropped), in display order; `tab` narrows it. */
  list(tab?: MtOptionTab): MtOptionDef[] {
    return MT_OPTIONS.filter((o) => o.status !== 'dead' && (!tab || o.tab === tab));
  }

  get(path: string): boolean | number {
    const d = this.def(path);
    if (!d) throw new Error(`No Mag-Tools option ${path}`);
    const raw = this.store.get(d.path);
    if (raw === undefined) return d.default;
    if (d.type === 'bool') return /^true$/i.test(raw) ? true : /^false$/i.test(raw) ? false : d.default;
    const n = Number(raw);
    return /^-?\d+$/.test(raw.trim()) ? n : d.default;
  }

  bool(path: string): boolean { return this.get(path) === true; }
  int(path: string): number { const v = this.get(path); return typeof v === 'number' ? v : 0; }

  /** Set a value; turning a child on turns its parent on too. */
  set(path: string, value: boolean | number): void {
    const d = this.def(path);
    if (!d) throw new Error(`No Mag-Tools option ${path}`);
    this.store.set(d.path, typeof value === 'boolean' ? boolText(value) : String(Math.trunc(value)));
    if (d.parent && value === true) this.set(d.parent, true);
  }

  /**
   * Parse text the way `/mt opt set` does (bool.TryParse / int.TryParse) and set it; false when
   * it doesn't parse. The Target Output Window edit falls back to the default on non-integer text.
   */
  setText(path: string, text: string): boolean {
    const d = this.def(path);
    if (!d) return false;
    const t = text.trim();
    if (d.type === 'bool') {
      if (!/^(true|false)$/i.test(t)) return false;
      this.set(d.path, /^true$/i.test(t));
      return true;
    }
    if (!/^[+-]?\d+$/.test(t)) return false;
    this.set(d.path, Number(t));
    return true;
  }

  /** A value as `/mt opt` prints it (`True` / `False` / the integer). */
  text(path: string): string {
    const v = this.get(path);
    return typeof v === 'boolean' ? boolText(v) : String(v);
  }
}
