/**
 * UtilityBelt's settings, kept per character (docs/vtank-parity-gaps.md §11;
 * UtilityBelt is MIT, https://gitlab.com/utilitybelt/utilitybelt, read at
 * 5fe9825a). UB keeps them in a per-character settings file; here they are
 * one JSON document per character in browser storage, read and written with
 * `/ub opt` exactly as UB's are (`list`, `get`, `set`, `toggle`, and
 * `add` / `remove` / `clear` on a list). The same document holds what UB
 * keeps in its own files: equipment profiles (its equip\*.utl), the AutoXp
 * policy, aliases and game events.
 *
 * Names and defaults are UB's own (each tool's `Setting<>` fields).
 * `AutoVendor.NeverSell` is ours: names AutoVendor never sells, on top of the
 * items UB itself never sells (worn, retained, attuned, inscribed, tinkered,
 * imbued, packs, foci, rares, zero value).
 */
import type { LootRule } from '@ac/shared';

export type UbSettingValue = boolean | number | string | string[];

/** UB's settings this client runs, with UB's defaults. */
export const UB_SETTING_DEFAULTS: Readonly<Record<string, UbSettingValue>> = Object.freeze({
  'Aliases.Enabled': true,
  'AutoTinker.MaxTinks': 10,
  'AutoTinker.MinPercentage': 99.5,
  'AutoVendor.EnableBuying': true,
  'AutoVendor.EnableSelling': true,
  'AutoVendor.Enabled': true,
  'AutoVendor.NeverSell': [],
  'AutoVendor.OnlyFromMainPack': false,
  'AutoVendor.ShowMerchantInfo': true,
  'AutoVendor.TestMode': false,
  'AutoVendor.Think': false,
  'AutoVendor.Tries': 4,
  'AutoVendor.TriesTime': 5000,
  'AutoXp.MaxXpChunk': 1_000_000_000,
  'AutoXp.StopBeforeMax': 10,
  'AutoXp.TriesTime': 300,
  'EquipmentManager.Think': false,
  'GameEvents.Enabled': true,
  'InventoryManager.IGFailure': 3,
  'InventoryManager.IGRange': 15,
  'InventoryManager.IGThink': false,
  'InventoryManager.TreatStackAsSingleItem': true,
  'Jumper.Attempts': 3,
  'Jumper.PauseNav': true,
  'Jumper.ThinkComplete': false,
  'Jumper.ThinkFail': false,
  'Plugin.PortalAttempts': 3,
  'Plugin.PortalThink': false,
  'Plugin.PortalTimeout': 5000,
});

/** UB's AutoXp default policy (AutoXp.cs `Policy`): weight per target; higher spends more there. */
export const UB_XP_POLICY_DEFAULT: Readonly<Record<string, number>> = Object.freeze({
  Strength: 1, Endurance: 1, Coordination: 1, Quickness: 1, Focus: 1, Self: 1,
  Health: 1.4, Stamina: 0.1, Mana: 0.1,
  Alchemy: 0, ArcaneLore: 0.1, ArmorTinkering: 0, AssessCreature: 0, AssessPerson: 0, Cooking: 0,
  CreatureEnchantment: 0.2, Deception: 0.1, DirtyFighting: 0.1, DualWield: 0.1, FinesseWeapons: 10,
  Fletching: 0.1, Healing: 0.1, HeavyWeapons: 10, ItemEnchantment: 0.2, ItemTinkering: 0, Jump: 0.02,
  Leadership: 0.1, LifeMagic: 1, LightWeapons: 10, Lockpick: 0, Loyalty: 0.1, MagicDefense: 0.1,
  MagicItemTinkering: 0, ManaConversion: 0.1, MeleeDefense: 5, MissileDefense: 5, MissileWeapons: 10,
  Recklessness: 0.1, Run: 0.1, Salvaging: 0.1, Shield: 0, SneakAttack: 0.1, Summoning: 1,
  TwoHandedCombat: 10, VoidMagic: 10, WarMagic: 10, WeaponTinkering: 0,
});

/** UB's alias / game-event action kinds (Lib/Actions/BaseAction.cs ActionType). */
export type UbActionType = 'Expression' | 'ChatExpression' | 'ChatCommand';
export interface UbAction { type: UbActionType; text: string }
export interface UbAlias { alias: string; action: UbAction; eat: boolean }
/** UB's game events (Lib/GameEvents/BaseGameEvent.cs GameEventType). */
export type UbGameEventType = 'Login' | 'LoginComplete' | 'Logout' | 'CharacterDeath';
export const UB_GAME_EVENT_TYPES: readonly UbGameEventType[] = ['Login', 'LoginComplete', 'Logout', 'CharacterDeath'];
export interface UbGameEvent { event: UbGameEventType; action: UbAction }

export interface UbDoc {
  settings: Record<string, UbSettingValue>;
  /** Equipment profiles by name (`/ub equip create`), as loot rules: Keep = wear it. */
  equip: Record<string, LootRule[]>;
  xpPolicy: Record<string, number>;
  aliases: UbAlias[];
  events: UbGameEvent[];
}

export interface UbStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export const ubStorageKey = (server: string, character: string): string => `acjs.ub.v1.${server.toLowerCase()}.${character.toLowerCase()}`;

function blank(): UbDoc {
  return { settings: {}, equip: {}, xpPolicy: { ...UB_XP_POLICY_DEFAULT }, aliases: [], events: [] };
}

/** One character's UB document, loaded lazily and saved on every change (storage failures leave it in memory). */
export class UbStore {
  private doc: UbDoc | null = null;
  private key: string | null = null;

  constructor(private readonly who: () => { server: string; character: string } | null, private readonly storage: () => UbStorage | null) {}

  private load(): UbDoc {
    const w = this.who();
    const key = w ? ubStorageKey(w.server, w.character) : null;
    if (this.doc && this.key === key) return this.doc;
    this.key = key;
    let d = blank();
    try {
      const raw = key ? this.storage()?.getItem(key) : null;
      if (raw) {
        const j = JSON.parse(raw) as Partial<UbDoc>;
        d = {
          settings: j.settings && typeof j.settings === 'object' ? j.settings : {},
          equip: j.equip && typeof j.equip === 'object' ? j.equip : {},
          xpPolicy: { ...UB_XP_POLICY_DEFAULT, ...(j.xpPolicy ?? {}) },
          aliases: Array.isArray(j.aliases) ? j.aliases : [],
          events: Array.isArray(j.events) ? j.events : [],
        };
      }
    } catch { /* unreadable: start from the defaults */ }
    this.doc = d;
    return d;
  }

  get data(): UbDoc { return this.load(); }

  save(): void {
    const d = this.load();
    if (!this.key) return;
    try { this.storage()?.setItem(this.key, JSON.stringify(d)); } catch { /* blocked storage: kept for this page */ }
  }

  /** A setting's full name as UB spells it (case-insensitive lookup), or null. */
  name(n: string): string | null {
    const want = n.trim().toLowerCase();
    return Object.keys(UB_SETTING_DEFAULTS).find((k) => k.toLowerCase() === want) ?? null;
  }

  get(name: string): UbSettingValue {
    const k = this.name(name);
    if (!k) throw new Error(`Invalid option: ${name}`);
    const v = this.load().settings[k];
    const def = UB_SETTING_DEFAULTS[k]!;
    return v === undefined || typeof v !== typeof def ? (Array.isArray(def) ? [...def] : def) : v;
  }

  bool(name: string): boolean { return this.get(name) === true; }
  num(name: string): number { const v = this.get(name); return typeof v === 'number' ? v : Number(v) || 0; }
  list(name: string): string[] { const v = this.get(name); return Array.isArray(v) ? v : []; }

  /** Set from text as `/ub opt set` does: booleans take true/false, numbers a number. */
  setText(name: string, text: string): UbSettingValue {
    const k = this.name(name);
    if (!k) throw new Error(`Invalid option: ${name}`);
    const def = UB_SETTING_DEFAULTS[k]!;
    let v: UbSettingValue;
    if (typeof def === 'boolean') {
      if (!/^(true|false)$/i.test(text.trim())) throw new Error(`${k} takes true or false`);
      v = /^true$/i.test(text.trim());
    } else if (typeof def === 'number') {
      const n = Number(text.trim());
      if (!text.trim() || !Number.isFinite(n)) throw new Error(`${k} takes a number`);
      v = n;
    } else if (Array.isArray(def)) {
      v = text.split(',').map((s) => s.trim()).filter(Boolean);
    } else v = text;
    this.load().settings[k] = v;
    this.save();
    return v;
  }

  setValue(name: string, v: UbSettingValue): void {
    const k = this.name(name);
    if (!k) throw new Error(`Invalid option: ${name}`);
    this.load().settings[k] = v;
    this.save();
  }

  /** UB's display of a setting: `Name = value` (lists comma-joined, as UB's DisplayValue). */
  display(name: string): string {
    const k = this.name(name) ?? name;
    const v = this.get(k);
    return `${k} = ${Array.isArray(v) ? `[${v.join(', ')}]` : String(v)}`;
  }

  /** `/ub opt list`: every setting with its type and value. */
  listAll(): string[] {
    return Object.keys(UB_SETTING_DEFAULTS).map((k) => {
      const def = UB_SETTING_DEFAULTS[k]!;
      const type = Array.isArray(def) ? 'List' : typeof def === 'boolean' ? 'Boolean' : typeof def === 'number' ? 'Number' : 'String';
      const v = this.get(k);
      return `${k} (${type}) = ${Array.isArray(v) ? `[${v.join(', ')}]` : String(v)}`;
    });
  }
}
