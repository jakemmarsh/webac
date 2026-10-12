/**
 * UtilityBelt's `/ub` commands (docs/vtank-parity-gaps.md §11; UtilityBelt is
 * MIT, https://gitlab.com/utilitybelt/utilitybelt, ported from 5fe9825a with
 * attribution: NOTICE.md). The dispatcher is UB's (UtilityBelt.cs
 * Core_CommandLineText): the verb is the first word; a verb that isn't
 * registered runs the first command that allows suffix flags and whose verb
 * starts it (`usepi`, `jumpsw`, `givep`); else "Command not found!" with the
 * verbs within two edits.
 *
 * Every action goes through the client's own paths (the agent API: use,
 * select, give, the vendor bar, the character panel's Raise …), only what a
 * player can do; "@" server commands never. A feature an era lacks answers
 * with the era's reason (EraFeatures / the 1999 absent list), not a branch.
 * `/ub autostack`, `autocram`, `count`, `clearbugged` stay in
 * ui/automation/metaCommands.ts.
 */
import { exprToString, getMaterialName, type ExprValue, type LootRule, type VarScope } from '@ac/shared';
import type { AgentDialog, AgentItem, AgentObject, AgentObjectKind, AgentResult, AgentVendor } from '../types.ts';
import type { ItemProps } from '../RoutineEngine.ts';
import { lootRuleFor } from '../RoutineEngine.ts';
import { UB_GAME_EVENT_TYPES, UbStore, type UbActionType, type UbGameEventType } from './ubSettings.ts';
import { applyAliases, deathDrops, fireGameEvent, GAME_EVENT_VARS, type UbActionRunner } from './aliases.ts';
import { buyList, sellList, testModeLines, vendorRound } from './autoVendor.ts';
import { equipPlan, profileFromWorn, toTakeOff } from './equipProfiles.ts';
import { exportXpPolicy, flattenXpPlan, importXpPolicy, planXp, xpTargetLabel } from './autoXp.ts';
import { parseMyQuestsLine, type QuestTracker } from '../questTracker.ts';
import { bestGraniteIron, bloodThirstBonus, planTinkers, tinkerChance, tinkerRule, TINKER_SKILL_NAMES, type TinkerBag, type TinkerRow, type TinkerStep } from './tinker.ts';

export interface UbSelf { guid: number; name: string; heading: number; coords: string | null; cell: string; pos: { x: number; y: number; z: number }; vitae: number; pyreals: number; unassignedXp: number; combatMode: string }

/** What `/ub` reads and does in the game (main.ts builds it over the agent API; tests fake it). */
export interface UbHost {
  now(): number;
  /** Unix seconds (quest timers). */
  nowSec(): number;
  sleep(ms: number): Promise<void>;
  /** A later line for chat (UB's WriteToChat). */
  print(text: string): void;
  /** A line as typed into the chat box (UB DispatchChatToBoxWithPluginIntercept): `/ub`, `/vt` and the game's own commands. */
  chat(line: string): void;
  me(): UbSelf | null;
  screen(): string;
  selected(): number | null;
  inventory(): AgentItem[];
  /** Objects around you, nearest first (you not included). */
  nearby(radius: number): AgentObject[];
  position(guid: number): { cell: string; x: number; y: number; z: number; coords: string | null } | null;
  openContainer(): { guid: number; name: string; corpse: boolean; items: Array<{ guid: number; name: string }> } | null;
  itemData(guid: number): ItemProps | null;
  appraise(guid: number): Promise<AgentResult>;
  /** Walk up to it and use it, as a double-click (the agent API's use). */
  use(guid: number): Promise<AgentResult>;
  /** One use request, no approach (UB's UseItem). */
  useNow(guid: number): boolean;
  useOn(item: number, target: number): AgentResult;
  select(guid: number): AgentResult;
  give(item: number, target: number, amount: number | null): Promise<AgentResult>;
  turn(heading: number): AgentResult;
  jump(o: { holdMs: number; forward?: boolean; backward?: boolean; strafeLeft?: boolean; strafeRight?: boolean; walk?: boolean }): AgentResult;
  combatMode(mode: string): AgentResult;
  equip(guid: number): Promise<AgentResult>;
  /** Take a worn item off into the main pack (the drag onto the pack). */
  unequip(guid: number): AgentResult;
  splitStack(guid: number, amount: number): boolean;
  logout(): AgentResult;
  /** The game's own Exit Game (a browser tab can't close the client: UB's quit). */
  exitGame(): void;
  evaluate(expr: string): ExprValue;
  vars(scope: VarScope): Array<[string, ExprValue]>;
  setVar(name: string, value: string): void;
  propertyDump(): Promise<string[]>;
  /** VirindiTank's navigation following this player (UB's UBFollow nav). */
  follow(name: string): AgentResult;
  /** Hold the macro's navigation this long (UB's VTank navigation lock). */
  holdNav(ms: number): void;
  vendor(): AgentVendor | null;
  buy(guid: number, amount: number): AgentResult;
  sell(guid: number, amount: number | null): Promise<AgentResult>;
  freeSlots(): number;
  lootSet(name: string): LootRule[] | null;
  lootSetNames(): string[];
  dialogs(): AgentDialog[];
  answerDialog(button: string): boolean;
  playerOption(code: number): boolean | undefined;
  setPlayerOption(code: number, on: boolean): boolean;
  characters(): string[];
  setNextLogin(name: string | null): void;
  fellowship(action: string, arg?: string): Promise<AgentResult>;
  swear(guid: number): Promise<AgentResult>;
  breakAllegiance(name?: string): AgentResult;
  skills(): Array<{ id: number; name: string; training: string; base: number; buffed: number }>;
  raiseCosts(stat: string, steps: number): number[] | null;
  raise(stat: string): { ok: boolean; message: string; cost?: number };
  /** A character PropertyInt (augmentations). */
  charInt(id: number): number | undefined;
  /** The era's reason when it lacks this feature (EraFeatures), else null. */
  eraLacks(feature: string): string | null;
  /** The era's tinkering table (tools/build-tinker-tables.ts). */
  tinkerTable(): Promise<TinkerRow[]>;
  currentSeq(): number;
  eventsSince(seq: number): Array<{ seq: number; type: string; text: string }>;
  /** Open or close UB's Dungeon Maps / Landscape Maps window (ui/maps/UbMaps.ts); the line to print. */
  toggleMap?(which: 'dungeon' | 'landscape'): string;
}

/** ACE CharacterOption (retail PlayerOption) codes by UB's PlayerOption names (`/ub playeroption`). */
export const PLAYER_OPTIONS: Readonly<Record<string, number>> = {
  AutoRepeatAttack: 0x00, IgnoreAllegianceRequests: 0x01, IgnoreFellowshipRequests: 0x02, IgnoreTradeRequests: 0x03,
  DisableMostWeatherEffects: 0x04, PersistentAtDay: 0x05, AllowGive: 0x06, ViewCombatTarget: 0x07, ShowTooltips: 0x08,
  UseDeception: 0x09, ToggleRun: 0x0a, StayInChatMode: 0x0b, AdvancedCombatUI: 0x0c, AutoTarget: 0x0d,
  VividTargetingIndicator: 0x0e, FellowshipShareXP: 0x0f, AcceptLootPermits: 0x10, FellowshipShareLoot: 0x11,
  FellowshipAutoAcceptRequests: 0x12, SideBySideVitals: 0x13, CoordinatesOnRadar: 0x14, SpellDuration: 0x15,
  DisableHouseRestrictionEffects: 0x16, DragItemOnPlayerOpensSecureTrade: 0x17, DisplayAllegianceLogonNotifications: 0x18,
  UseChargeAttack: 0x19, UseCraftSuccessDialog: 0x1a, HearAllegianceChat: 0x1b, DisplayDateOfBirth: 0x1c, DisplayAge: 0x1d,
  DisplayChessRank: 0x1e, DisplayFishingSkill: 0x1f, DisplayNumberDeaths: 0x20, DisplayTimeStamps: 0x21, SalvageMultiple: 0x22,
  HearGeneralChat: 0x23, HearTradeChat: 0x24, HearLFGChat: 0x25, HearRoleplayChat: 0x26, AppearOffline: 0x27,
  DisplayNumberCharacterTitles: 0x28, MainPackPreferred: 0x29, LeadMissileTargets: 0x2a, UseFastMissiles: 0x2b,
  FilterLanguage: 0x2c, ConfirmVolatileRareUse: 0x2d, HearSocietyChat: 0x2e, ShowHelm: 0x2f, DisableDistanceFog: 0x30,
  UseMouseTurning: 0x31, ShowCloak: 0x32, LockUI: 0x33, HearPKDeath: 0x34,
};
/** The options an era lacks go with their feature (era/EraFeatures FEATURE_CHARACTER_OPTIONS). */
export const PLAYER_OPTION_FEATURES: Readonly<Record<string, string>> = {
  IgnoreTradeRequests: 'secureTrade', DragItemOnPlayerOpensSecureTrade: 'secureTrade', DisableHouseRestrictionEffects: 'housing',
  AcceptLootPermits: 'consent', DisplayChessRank: 'chess', DisplayNumberCharacterTitles: 'characterTitles',
  SalvageMultiple: 'salvage', UseCraftSuccessDialog: 'salvage', HearAllegianceChat: 'turbineChat', HearGeneralChat: 'turbineChat',
  HearTradeChat: 'turbineChat', HearLFGChat: 'turbineChat', HearRoleplayChat: 'turbineChat', HearSocietyChat: 'turbineChat',
};

interface Command { verb: string; partial: boolean; usage: string; run: (verb: string, args: string) => Promise<string[]> | string[] }

/** Damerau-Levenshtein distance (UB Util.GetDamerauLevenshteinDistance), for "Did you mean". */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + cost);
    }
  }
  return d[a.length]![b.length]!;
}

/** UB's search flags for use / select: everywhere, inventory (i) or landscape (l). */
type Where = 'all' | 'inventory' | 'landscape';
interface Found { guid: number; name: string; kind: AgentObjectKind | 'item'; dist: number }

const PORTAL_KINDS: readonly AgentObjectKind[] = ['portal', 'npc'];
const PLAYER_KINDS: readonly AgentObjectKind[] = ['player'];

/** A friendly type name for a meta value (UB ExpressionVisitor.GetFriendlyType). */
function friendlyType(v: ExprValue): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  return v.kind;
}

export class UbRuntime {
  readonly store: UbStore;
  readonly quests: QuestTracker;
  private readonly commands: Command[] = [];
  /** Jobs that run over time (give, ig, vendor, equip, xp, tinker), so a second start says so and stop stops it. */
  private jobs = new Map<string, { cancelled: boolean }>();
  private prepClick: { button: 'Yes' | 'No'; until: number; seen: number } | null = null;
  private delayed: Array<{ at: number; line: string }> = [];
  private vendorLists: { buy: Array<{ guid: number; amount: number; name: string }>; sell: Array<{ guid: number; amount: number | null; name: string }> } = { buy: [], sell: [] };
  private vendorSeen: number | null = null;
  private tinkerQueue: { target: TinkerBag['guid']; targetName: string; steps: TinkerStep[]; stop: string } | null = null;
  private eventSeq = -1;
  /** The screen at the last tick (null before the first: the screen the runtime starts on fires nothing). */
  private lastScreen: string | null = null;
  private lastName: string | null = null;
  private deathMessage = '';
  private aliasDepth = 0;
  /** A loot-set lookup handed in by the command's caller (the automation window's loaded profile), used before the host's. */
  private lootContext: ((name: string) => LootRule[] | null) | null = null;

  /** `quests`: the client's one quest list (agent/questTracker.ts), shared with the meta functions. */
  constructor(private readonly host: UbHost, store: UbStore, quests: QuestTracker) {
    this.store = store;
    this.quests = quests;
    this.register();
  }

  private think(text: string): void {
    const me = this.host.me();
    if (me) this.host.chat(`/tell ${me.name}, ${text}`);
  }
  private thinkOrWrite(text: string, think: boolean): string[] {
    if (think) { this.think(text); return []; }
    return [text];
  }

  // ── finding things (UB Util.FindName / FindObjectByName) ──

  /** UB TryFindBySpecialName: a decimal id, a hex id, or "selected". */
  private special(search: string, ok: (f: Found) => boolean): Found | null {
    const s = search.trim();
    const all = this.everything();
    const byId = (id: number) => all.find((f) => f.guid === id >>> 0 && ok(f)) ?? null;
    if (/^-?\d+$/.test(s)) { const f = byId(Number(s)); if (f) return f; }
    if (/^(0x)?[0-9a-f]+$/i.test(s)) { const f = byId(parseInt(s.replace(/^0x/i, ''), 16)); if (f) return f; }
    if (/^selected$/i.test(s)) { const g = this.host.selected(); if (g !== null) { const f = byId(g); if (f) return f; } }
    return null;
  }

  private everything(): Found[] {
    const inv: Found[] = this.host.inventory().map((i) => ({ guid: i.guid, name: i.name, kind: 'item' as const, dist: 0 }));
    const c = this.host.openContainer();
    const inside: Found[] = c ? c.items.map((i) => ({ guid: i.guid, name: i.name, kind: 'item' as const, dist: 0 })) : [];
    const world: Found[] = this.host.nearby(600).map((o) => ({ guid: o.guid, name: o.name, kind: o.kind, dist: o.dist }));
    return [...inv, ...inside, ...world];
  }

  /** UB FindName: the nearest object of these kinds named `search` (contained when partial; any when empty). */
  findName(search: string, partial: boolean, kinds: readonly AgentObjectKind[]): Found | null {
    const sp = this.special(search, (f) => f.kind !== 'item' && (!kinds.length || kinds.includes(f.kind as AgentObjectKind)));
    if (sp) return sp;
    const want = search.trim().toLowerCase();
    for (const o of this.host.nearby(600)) {
      if (kinds.length && !kinds.includes(o.kind)) continue;
      const n = o.name.toLowerCase();
      if (!want || (partial ? n.includes(want) : n === want)) return { guid: o.guid, name: o.name, kind: o.kind, dist: o.dist };
    }
    return null;
  }

  /** UB FindObjectByName: inventory, then the open container, then the nearest on the landscape. */
  findObject(name: string, where: Where, partial: boolean, exclude?: number): Found | null {
    const sp = this.special(name, (f) => f.guid !== exclude);
    if (sp) return sp;
    const lc = name.toLowerCase();
    const hit = (n: string) => (partial ? n.toLowerCase().includes(lc) : n === name || n.toLowerCase() === lc);
    if (where !== 'landscape') {
      const i = this.host.inventory().find((x) => x.guid !== exclude && hit(x.name));
      if (i) return { guid: i.guid, name: i.name, kind: 'item', dist: 0 };
      if (where === 'all') {
        const c = this.host.openContainer()?.items.find((x) => x.guid !== exclude && hit(x.name));
        if (c) return { guid: c.guid, name: c.name, kind: 'item', dist: 0 };
      }
    }
    if (where !== 'inventory') {
      const o = this.host.nearby(600).find((x) => x.guid !== exclude && hit(x.name));
      if (o) return { guid: o.guid, name: o.name, kind: o.kind, dist: o.dist };
    }
    return null;
  }

  private lootSet(name: string): LootRule[] | null {
    const stem = name.replace(/\.utl$/i, '').trim();
    return this.lootContext?.(stem) ?? this.host.lootSet(stem);
  }

  // ── the dispatcher ──

  /**
   * A `/ub …` line, answered with chat lines (later lines come through host.print), or null when it isn't
   * one. `lootRules` is the automation window's loot-set lookup, when it has a profile loaded.
   */
  async command(line: string, lootRules?: (name: string) => LootRule[] | null): Promise<string[] | null> {
    const m = /^\s*[/@]+ub(?:\s+(.*))?$/i.exec(line);
    if (!m) return null;
    if (lootRules) this.lootContext = lootRules;
    const rest = (m[1] ?? '').trim();
    const sp = rest.indexOf(' ');
    const verb = sp < 0 ? rest : rest.slice(0, sp);
    const args = sp < 0 ? '' : rest.slice(sp + 1).trim();
    const lv = verb.toLowerCase();
    const exact = this.commands.find((c) => c.verb === lv);
    if (exact) return exact.run(verb, args);
    const partial = this.commands.find((c) => c.partial && c.verb && lv.startsWith(c.verb));
    if (partial) return partial.run(verb, args);
    const near = this.commands.filter((c) => c.verb && editDistance(lv, c.verb) <= 2).map((c) => c.verb);
    return ['Command not found! Type "/ub help" for a list of commands.', ...(near.length ? [`Did you mean one of these? ${near.join(', ')}`] : [])];
  }

  private add(verb: string, partial: boolean, usage: string, run: Command['run']): void {
    this.commands.push({ verb, partial, usage, run });
  }

  /** UB's verbs this port answers (help lists them; the importer imports them). */
  get verbs(): string[] { return this.commands.map((c) => c.verb).filter(Boolean).sort(); }

  private register(): void {
    const h = this.host;
    this.add('', false, '/ub', () => ['UtilityBelt (this client\'s port of UtilityBelt, MIT).', 'Type `/ub help` or `/ub help <command>` for help.']);
    this.add('help', false, '/ub help [command]', (_v, a) => {
      const c = a ? this.commands.find((x) => x.verb === a.toLowerCase()) : undefined;
      if (c) return [`Usage: ${c.usage}`];
      return [`All available UB commands: /ub {${[...this.verbs, 'autocram', 'autostack', 'clearbugged', 'count'].sort().join(', ')}}`, 'For help with a specific command, use `/ub help [command]`'];
    });

    // Acting on objects.
    this.add('use', true, '/ub use[li][p] <item> [on <item>]', (v, a) => this.use(v, a));
    this.add('select', true, '/ub select[li][p] <item>', (v, a) => {
      const f = this.flags(v, 'select');
      if (typeof f === 'string') return [f];
      if (!a) return [];
      const o = this.findObject(a, f.where, f.partial);
      if (o) h.select(o.guid);
      return [];
    });
    this.add('give', true, '/ub give[p{P|r}] [count] <item> to <target> | give stop', (v, a) => this.give(v, a));
    this.add('ig', true, '/ub ig[p] <lootProfile> to <target> | ig stop', (v, a) => this.itemGiver(v, a));
    this.add('follow', true, '/ub follow[p] <name>', (v, a) => {
      if (!a) return ['Usage: /ub follow[p] <name>'];
      const p = this.findName(a, v.slice(6).includes('p'), PLAYER_KINDS);
      if (!p) return [`Could not find player ${a}`];
      const r = h.follow(p.name);
      return r.ok ? [`Following ${p.name}[0x${p.guid.toString(16).toUpperCase().padStart(8, '0')}]`] : [`Failed to follow ${p.name}: ${r.message}`];
    });
    this.add('portal', true, '/ub portal[p] <portalName>', (v, a) => (a ? this.portal(a, v.slice(6).includes('p'), PORTAL_KINDS) : ['Usage: /ub portal[p] <portalName>']));
    this.add('closestportal', false, '/ub closestportal', () => this.portal('', true, ['portal']));
    this.add('face', false, '/ub face <heading>', (_v, a) => {
      const deg = Number(a);
      if (!/^[.\d]+$/.test(a) || !Number.isFinite(deg)) return [`Invalid jump heading: ${a}`];
      if (this.store.bool('Jumper.PauseNav')) h.holdNav(1000);
      const r = h.turn(deg);
      if (!r.ok) return this.thinkOrWrite('Turning failed', this.store.bool('Jumper.ThinkFail'));
      return this.store.bool('Jumper.ThinkComplete') ? (this.think('Turning Success'), []) : [];
    });
    this.add('pos', false, '/ub pos', () => {
      const g = h.selected();
      if (g === null) return ['pos: No object selected'];
      const p = h.position(g);
      if (!p) return ['pos: null object selected'];
      return [`Id: ${g} ( 0x${g.toString(16).toUpperCase().padStart(8, '0')} )`, `Coords: ${p.coords ?? '(indoors)'}`, `Phys lb: ${p.cell}`, `Phys pos: x:${p.x.toFixed(2)} y:${p.y.toFixed(2)} z:${p.z.toFixed(2)}`];
    });
    this.add('id', false, '/ub id', () => {
      const g = h.selected();
      return g === null ? ['Id: No object selected'] : [`Id: ${g} ( 0x${g.toString(16).toUpperCase().padStart(8, '0')} )`];
    });

    // Movement and combat state.
    this.add('jump', true, '/ub jump[swzxc] [heading] [holdtime]', (v, a) => this.jump(v, a));
    this.add('simplejump', true, '/ub simplejump [holdtime]', (_v, a) => this.jump('jump', a.trim()));
    this.add('combatstate', false, '/ub combatstate (peace|melee|missile|magic)', (_v, a) => this.combat(a));
    for (const mode of ['peace', 'melee', 'missile', 'magic']) this.add(mode, false, `/ub ${mode}`, () => this.combat(mode));

    // Scripting and inspection.
    this.add('delay', false, '/ub delay <milliseconds> <command>', (_v, a) => {
      const m = /^(\d+(?:\.\d+)?)\s+(.+)$/.exec(a);
      if (!m || !(Number(m[1]) > 0)) return ['Usage: /ub delay <milliseconds> <command>'];
      this.delayed.push({ at: h.now() + Number(m[1]), line: m[2]! });
      this.delayed.sort((x, y) => x.at - y.at);
      return [];
    });
    this.add('mexec', true, '/ub mexec[m] <expression>', (v, a) => {
      const silent = v.toLowerCase() === 'mexecm';
      const t0 = h.now();
      try {
        const r = h.evaluate(a);
        if (silent) return [];
        return [`Evaluating expression: "${a}"`, `Result: [${friendlyType(r)}] ${exprToString(r)} (${Math.round((h.now() - t0) * 1000) / 1000}ms)`];
      } catch (e) { return [`Error: ${(e as Error).message}`]; }
    });
    const listVars = (scope: VarScope, title: string) => () => [title, ...h.vars(scope).map(([n, val]) => `${n} (${friendlyType(val)}) = ${exprToString(val)}`)];
    this.add('listvars', false, '/ub listvars', listVars('var', 'Defined variables:'));
    this.add('listpvars', false, '/ub listpvars', listVars('pvar', 'Defined persistent variables:'));
    this.add('listgvars', false, '/ub listgvars', listVars('gvar', 'Defined global variables:'));
    this.add('opt', false, '/ub opt {list | get <option> | set <option> <newValue> | toggle <option>}', (_v, a) => this.opt(a));
    this.add('vitae', false, '/ub vitae', () => { this.think(`My vitae is ${h.me()?.vitae ?? 0}%`); return []; });
    this.add('close', true, '/ub close corpse|chest', (_v, a) => {
      const c = h.openContainer();
      if (!c) return ['No container is currently open.'];
      const want = a.trim().toLowerCase();
      if ((want === 'corpse' && c.corpse) || (want === 'chest' && !c.corpse)) h.useNow(c.guid);
      return [];
    });
    this.add('propertydump', false, '/ub propertydump', () => h.propertyDump());
    this.add('quit', false, '/ub quit', () => { h.exitGame(); return ['Quitting Client']; });
    this.add('logout', false, '/ub logout', () => { h.logout(); return ['Logging Out']; });
    this.add('date', true, '/ub date[utc] [format]', (v) => {
      const d = new Date(h.nowSec() * 1000);
      return [`Current Date: ${/utc/i.test(v) ? d.toUTCString() : d.toString()}`];
    });

    // AutoVendor.
    this.add('autovendor', false, '/ub autovendor [cancel|lootProfile]', (_v, a) => {
      if (/^(cancel|stop|quit)$/i.test(a)) { this.stopJob('vendor'); return [`AutoVendor finished: ${h.vendor()?.name ?? ''}`.trim()]; }
      return this.startVendor(a || null);
    });
    this.add('vendor', false, '/ub vendor {open[p] <vendor> | opencancel | buyall | sellall | clearbuy | clearsell | addbuy[p] [count] <item> | addsell[p] [count] <item>}', (_v, a) => this.vendorCmd(a));

    // Equipment.
    this.add('equip', false, '/ub equip {list | load [profile] | test [profile] | create [profile]}', (_v, a) => this.equip(a));
    this.add('calcdamage', false, '/ub calcdamage', () => this.calcDamage());

    // AutoXp.
    this.add('xp', false, '/ub xp [level|test|slow|export|import <policy>]', (_v, a) => this.xp(a));

    // Aliases and game events (UB edits these on its tabs; here by command).
    this.add('alias', false, '/ub alias {list | add [noeat] <ChatCommand|Expression|ChatExpression> <regex> => <text> | remove <n>}', (_v, a) => this.aliasCmd(a));
    this.add('events', false, '/ub events {list | add <Login|LoginComplete|Logout|CharacterDeath> <ChatCommand|Expression|ChatExpression> <text> | remove <n> | info <event>}', (_v, a) => this.eventsCmd(a));

    // Small commands.
    this.add('prepclick', false, '/ub prepclick {stop|yes <secondstowatch>|no <secondstowatch>}', (_v, a) => this.prepclick(a));
    this.add('playeroption', false, '/ub playeroption (list|<option> {on | true | off | false})', (_v, a) => this.playerOption(a));
    this.add('myquests', false, '/ub myquests', () => (this.quests.refresh() ? ['Refreshing quests'] : ['GetMyQuestsList called while it was already running']));
    this.add('quests', false, '/ub quests check <questFlag>', (_v, a) => {
      const m = /^(check|parse)\s+(.+)$/i.exec(a);
      if (!m) return ['Usage: /ub quests check <questFlag>'];
      if (m[1]!.toLowerCase() === 'parse') {
        const q = parseMyQuestsLine(m[2]!);
        return q ? [`Quest ${q.key} repeat:${q.repeatSeconds} solves:${q.solves}/${q.maxSolves}`] : ['Could not parse MyQuestLine'];
      }
      const r = this.quests.check(m[2]!);
      for (const t of r.thoughts) this.think(t);
      return r.truncated ? ['Quests output has been truncated to the first 5 matching quest flags.'] : [];
    });
    this.add('fellow', true, '/ub fellow {create <name> | quit | disband | open | close | status | recruit[p] [name] | dismiss[p] [name] | leader[p] [name]}', (_v, a) => this.fellow(a));
    this.add('login', false, '/ub login { clear | list | next[r][l] [part of name|index]}', (_v, a) => this.login(a));
    this.add('swearallegiance', true, '/ub swearallegiance[p] [name|id|selected]', async (v, a) => {
      const p = this.findName(a, v.slice(15).toLowerCase() === 'p', PLAYER_KINDS);
      if (!p) return [`Could not find ${a ? `player ${a}` : 'closest player'} Command:${v}`];
      const r = await h.swear(p.guid);
      return [`Swearing Allegiance to ${p.name}[0x${p.guid.toString(16).toUpperCase().padStart(8, '0')}]`, ...(r.ok ? [] : [r.message])];
    });
    this.add('breakallegiance', true, '/ub breakallegiance[p] [name|id|selected]', (v, a) => {
      const p = this.findName(a, v.slice(15).toLowerCase() === 'p', PLAYER_KINDS);
      if (!p) return [`Could not find ${a ? `player ${a}` : 'closest player'} Command:${v}`];
      const r = h.breakAllegiance(p.name);
      return [`Breaking Allegiance from ${p.name}[0x${p.guid.toString(16).toUpperCase().padStart(8, '0')}]`, ...(r.ok ? [] : [r.message])];
    });

    // Tinkering.
    this.add('tinkcalc', false, '/ub tinkcalc', () => this.tinkcalc());
    this.add('autotinker', false, '/ub autotinker [<salvage>|best] [maxTinks] | start | stop', (_v, a) => this.autotinker(a));
    this.add('getjob', false, '/ub getjob', () => this.getjob());

    // Maps (UB opens these windows from its Decal bar; here by command, or the automation window's Options tab).
    const map = (which: 'dungeon' | 'landscape') => () => [h.toggleMap?.(which) ?? 'Maps are not available in this client'];
    this.add('dungeonmaps', false, '/ub dungeonmaps', map('dungeon'));
    this.add('landscapemaps', false, '/ub landscapemaps', map('landscape'));
  }

  /** UB's [l][i][p] suffix flags on use / select. */
  private flags(v: string, base: string): { where: Where; partial: boolean } | string {
    const f = v.slice(base.length).toLowerCase();
    if (f.includes('l') && f.includes('i')) return 'l and i cannot be used in the same command';
    return { where: f.includes('i') ? 'inventory' : f.includes('l') ? 'landscape' : 'all', partial: f.includes('p') };
  }

  private async use(v: string, a: string): Promise<string[]> {
    const f = this.flags(v, 'use');
    if (typeof f === 'string') return [f];
    const m = /^(.+?)(?:\s+on\s+(.+))?$/i.exec(a.trim());
    if (!m) return [];
    const [, one, two] = m;
    const o = this.findObject(one!, f.where, f.partial);
    if (!o) return [`Could not find object: ${one}`];
    if (!two) {
      if (o.kind === 'portal') return this.portal(o.name, f.partial, ['portal']);
      if (o.kind === 'vendor') return this.vendorOpen(o.name, f.partial);
      const r = await this.host.use(o.guid);
      return [`using ${o.name}`, ...(r.ok ? [] : [r.message])];
    }
    const t = this.findObject(two, 'all', f.partial, o.guid);
    if (!t) return [`${two} is null`];
    const r = this.host.useOn(o.guid, t.guid);
    return [`using ${o.name} on ${t.name}`, ...(r.ok ? [] : [r.message])];
  }

  private combat(mode: string): string[] {
    const m = mode.trim().toLowerCase();
    if (!['peace', 'melee', 'missile', 'magic'].includes(m)) return ['Usage: /ub combatstate (peace|melee|missile|magic)'];
    const r = this.host.combatMode(m);
    return r.ok ? [] : [r.message];
  }

  private jump(v: string, a: string): string[] {
    const m = /^\s*(?:([.\d]+)\s+)?(\d+)?\s*$/.exec(a);
    if (!m) return [`Usage: /ub jump[swzxc] [heading] [holdtime]`];
    if (this.jobs.has('jump')) return ['You are already jumping. try again later.'];
    const hold = m[2] !== undefined ? Number(m[2]) : 0;
    if (hold < 0 || hold > 1000) return ['holdtime should be a number between 0 and 1000'];
    const flags = v.slice(4).toLowerCase();
    if (m[1] !== undefined) {
      const deg = Number(m[1]);
      if (!(deg >= 0 && deg <= 359)) return ['direction should be a number between 0 and 359'];
      this.host.turn(deg);
    }
    if (this.store.bool('Jumper.PauseNav')) this.host.holdNav(hold + 5000);
    const job = { cancelled: false };
    this.jobs.set('jump', job);
    const r = this.host.jump({ holdMs: hold, forward: flags.includes('w'), backward: flags.includes('x'), strafeLeft: flags.includes('z'), strafeRight: flags.includes('c'), walk: flags.includes('s') });
    void this.host.sleep(hold + 600).then(() => { this.jobs.delete('jump'); });
    if (!r.ok) return this.thinkOrWrite('You have failed to jump too many times.', this.store.bool('Jumper.ThinkFail'));
    if (this.store.bool('Jumper.ThinkComplete')) this.think('Jumper Success');
    return [];
  }

  private opt(a: string): string[] {
    const t = a.trim();
    if (/^list$/i.test(t)) return ['All Settings:', ...this.store.listAll()];
    const m = /^(?:(get|set|toggle)\s+)?(\S+)\s*(.*)$/i.exec(t);
    if (!m) return ['Usage: /ub opt {list | get <option> | set <option> <newValue> | toggle <option>}'];
    const [, verb = 'get', name, value = ''] = m;
    const k = this.store.name(name!);
    if (!k) return [`Invalid option: ${name}`];
    try {
      if (verb.toLowerCase() === 'toggle') {
        const cur = this.store.get(k);
        if (typeof cur !== 'boolean') return [`Unable to toggle setting ${k}: not a true/false setting`];
        this.store.setValue(k, !cur);
        return [this.store.display(k)];
      }
      const cur = this.store.get(k);
      if (Array.isArray(cur)) {
        if (value) {
          const [sub = '', items = ''] = value.split(/\s+(.*)/s);
          const parts = items.split(',').map((s) => s.trim()).filter(Boolean);
          if (sub.toLowerCase() === 'add') { if (!parts.length) return ['Missing items to add']; this.store.setValue(k, [...cur, ...parts.filter((p) => !cur.includes(p))]); }
          else if (sub.toLowerCase() === 'remove') { if (!parts.length) return ['Missing items to remove']; this.store.setValue(k, cur.filter((x) => !parts.includes(x))); }
          else if (sub.toLowerCase() === 'clear') this.store.setValue(k, []);
          else return [`Unknown verb: ${sub}`];
        }
        return [this.store.display(k)];
      }
      if (verb.toLowerCase() === 'get' || !value) return [this.store.display(k)];
      this.store.setText(k, value);
      return [this.store.display(k)];
    } catch (e) { return [(e as Error).message]; }
  }

  // ── give / ig (UB InventoryManager) ──

  private inRange(target: Found): string | null {
    const range = this.store.num('InventoryManager.IGRange');
    return target.dist > range ? `${target.name} is ${target.dist.toFixed(2)} meters away, IGRange is set to ${range}. bailing.` : null;
  }

  private async give(v: string, a: string): Promise<string[]> {
    if (/^(stop|cancel|quit|abort)$/i.test(a.trim())) { this.stopJob('give'); return []; }
    const m = /^(?:(\d+)\s+)?(.+?)\s+to\s+(.+)$/i.exec(a.trim());
    if (!m) return ['Usage: /ub give[p{P|r}] [count] <item> to <target>'];
    if (this.jobs.has('give')) return ['Already running.  Please wait until it completes or use /ub give stop to quit previous session'];
    const flags = v.slice(4);
    const [, count, itemName, targetName] = m;
    const target = this.findName(targetName!, flags.includes('P'), ['player', 'npc', 'vendor']);
    if (!target) return [`player ${targetName} not found`];
    if (target.guid === this.host.me()?.guid) return ["You can't give to yourself"];
    const far = this.inRange(target);
    if (far) return [far];
    const regex = flags.includes('r');
    let re: RegExp | null = null;
    if (regex) { try { re = new RegExp(itemName!); } catch (e) { return [`bad item pattern: ${(e as Error).message}`]; } }
    const want = itemName!.toLowerCase();
    const max = count ? Number(count) : Infinity;
    const single = this.store.bool('InventoryManager.TreatStackAsSingleItem');
    const picks: Array<{ guid: number; amount: number | null }> = [];
    let pending = 0;
    for (const i of this.host.inventory().filter((x) => x.where !== 'equipped')) {
      if (pending >= max) break;
      const ok = re ? re.test(i.name) : flags.includes('p') ? i.name.toLowerCase().includes(want) : i.name.toLowerCase() === want;
      if (!ok) continue;
      const stack = Math.max(1, i.stack ?? 1);
      if (single) { picks.push({ guid: i.guid, amount: null }); pending++; } else if (stack > max - pending) { picks.push({ guid: i.guid, amount: max - pending }); pending = max; } else { picks.push({ guid: i.guid, amount: null }); pending += stack; }
    }
    return this.runGive('give', `${itemName}`, target, picks);
  }

  private async itemGiver(v: string, a: string): Promise<string[]> {
    if (/^(stop|cancel|quit|abort)$/i.test(a.trim())) { this.stopJob('give'); return []; }
    const m = /^(.+?)\s+to\s+(.+)$/i.exec(a.trim());
    if (!m) return ['Usage: /ub ig[p] <lootProfile> to <target>'];
    if (this.jobs.has('give')) return ['Already running.  Please wait until it completes or use /ub ig stop to quit previous session'];
    const [, profile, targetName] = m;
    const target = this.findName(targetName!, v.slice(2).includes('p'), ['player', 'npc', 'vendor']);
    if (!target) return [`player ${targetName} not found`];
    if (target.guid === this.host.me()?.guid) return ["You can't give to yourself"];
    const range = this.store.num('InventoryManager.IGRange');
    if (target.dist > range) return [`ItemGiver ${targetName} is ${target.dist.toFixed(2)} meters away. IGRange is set to ${range}`];
    const rules = this.lootSet(profile!);
    if (!rules) return [`ItemGiver Profile does not exist: ${profile}`];
    const single = this.store.bool('InventoryManager.TreatStackAsSingleItem');
    const counted = new Map<string, number>();
    const picks: Array<{ guid: number; amount: number | null }> = [];
    for (const i of this.host.inventory().filter((x) => x.where !== 'equipped')) {
      const p = this.host.itemData(i.guid);
      const r = lootRuleFor(rules, { name: i.name, ...(i.value !== undefined ? { value: i.value } : {}), ...(i.burden !== undefined ? { burden: i.burden } : {}), ...(i.type ? { type: i.type } : {}), ...(p ? { props: p } : {}) });
      if (!r || (r.action !== 'keep' && r.action !== 'keep-up-to')) continue;
      if (r.action === 'keep-up-to') {
        // UB TestIGItem, KeepUpTo with a positive count: give up to that many.
        const key = r.label ?? JSON.stringify(r.match);
        const given = counted.get(key) ?? 0;
        const n = r.count ?? 0;
        if (given >= n) continue;
        const stack = single ? 1 : Math.max(1, i.stack ?? 1);
        if (!single && stack > n - given) { picks.push({ guid: i.guid, amount: n - given }); counted.set(key, n); continue; }
        counted.set(key, given + stack);
      }
      picks.push({ guid: i.guid, amount: null });
    }
    return this.runGive('ig', profile!, target, picks);
  }

  private async runGive(kind: 'give' | 'ig', what: string, target: Found, picks: Array<{ guid: number; amount: number | null }>): Promise<string[]> {
    const job = { cancelled: false };
    this.jobs.set('give', job);
    this.host.holdNav(30_000);
    const started = this.host.now();
    let given = 0, failures = 0;
    try {
      for (const p of picks) {
        if (job.cancelled) break;
        this.host.holdNav(30_000);
        const r = await this.host.give(p.guid, target.guid, p.amount);
        if (r.ok) given++; else if (++failures >= this.store.num('InventoryManager.IGFailure')) break;
      }
    } finally { this.jobs.delete('give'); this.host.holdNav(0); }
    const secs = Math.round((this.host.now() - started) / 1000);
    return this.thinkOrWrite(`ItemGiver finished: ${what} to ${target.name}. took ${secs}s to give ${given} item(s). ${failures}`, this.store.bool('InventoryManager.IGThink'));
  }

  private stopJob(name: string): void {
    const j = this.jobs.get(name);
    if (j) j.cancelled = true;
    this.jobs.delete(name);
    if (name === 'vendor' || name === 'give' || name === 'equip') this.host.holdNav(0);
  }

  // ── portals (UB Plugin.UB_portal) ──

  private async portal(name: string, partial: boolean, kinds: readonly AgentObjectKind[]): Promise<string[]> {
    const p = this.findName(name, partial, kinds);
    const think = this.store.bool('Plugin.PortalThink');
    if (!p) return this.thinkOrWrite('Could not find a portal', think);
    this.host.print(`Attempting to use portal: ${p.name}`);
    const timeout = this.store.num('Plugin.PortalTimeout');
    for (let attempt = 1; attempt <= this.store.num('Plugin.PortalAttempts'); attempt++) {
      this.host.holdNav(500 + timeout);
      const r = await this.host.use(p.guid);
      const end = this.host.now() + timeout;
      while (this.host.now() < end) {
        if (this.host.screen() === 'portal-space' || /portal space|You have entered/i.test(r.message)) { this.host.holdNav(0); return this.thinkOrWrite('portal used successfully', think); }
        await this.host.sleep(200);
      }
    }
    this.host.holdNav(0);
    return [`Unable to use portal ${p.name}`, ...this.thinkOrWrite('failed to use portal', think)];
  }

  // ── AutoVendor ──

  private vendorProfile(vendorName: string, given: string | null): { name: string; rules: LootRule[] } | null {
    for (const n of given ? [given] : [vendorName, 'default']) {
      const r = this.lootSet(n);
      if (r) return { name: n.replace(/\.utl$/i, ''), rules: r };
    }
    return null;
  }

  private startVendor(profile: string | null): string[] {
    const v = this.host.vendor();
    if (!v) return this.thinkOrWrite('AutoVendor Fatal - no vendor, cannot start', this.store.bool('AutoVendor.Think'));
    const prof = this.vendorProfile(v.name, profile);
    if (!prof) return [`No vendor profile exists: ${profile ?? `${v.name}.utl`}`];
    this.stopJob('vendor');
    const job = { cancelled: false };
    this.jobs.set('vendor', job);
    void this.runVendor(job, v.guid, prof.rules).then((lines) => lines.forEach((l) => this.host.print(l)));
    return [];
  }

  /** UB AutoVendor's rounds: buy, sell, again until there's nothing; bails after 60 s without progress. */
  async runVendor(job: { cancelled: boolean }, vendorGuid: number, rules: LootRule[]): Promise<string[]> {
    const h = this.host;
    const name = h.vendor()?.name ?? '';
    const think = this.store.bool('AutoVendor.Think');
    const opts = { neverSell: this.store.list('AutoVendor.NeverSell'), onlyMainPack: this.store.bool('AutoVendor.OnlyFromMainPack') };
    const plan = () => {
      const v = h.vendor();
      if (!v || v.guid !== vendorGuid) return null;
      const inv = h.inventory();
      return {
        buys: this.store.bool('AutoVendor.EnableBuying') ? buyList(rules, v.items, inv) : [],
        sells: this.store.bool('AutoVendor.EnableSelling') ? sellList(rules, inv, (g) => h.itemData(g), opts) : [],
      };
    };
    try {
      if (this.store.bool('AutoVendor.TestMode')) {
        const p = plan();
        return p ? [...testModeLines(p.buys, p.sells), ...this.thinkOrWrite(`AutoVendor finished: ${name}`, think)] : [];
      }
      let bail = h.now();
      for (let round = 0; round < 50 && !job.cancelled; round++) {
        h.holdNav(30_000);
        const p = plan();
        if (!p) return this.thinkOrWrite(`AutoVendor finished: ${name}`, think);
        const step = vendorRound({ buys: p.buys, sells: p.sells, pyreals: h.me()?.pyreals ?? 0, freeSlots: h.freeSlots() });
        if (!step) break;
        if ('buy' in step) {
          for (const b of step.buy) { if (!job.cancelled) h.buy(b.item.guid, b.amount); }
          await h.sleep(1500);
        } else if (step.splitNote) {
          h.splitStack(step.splitNote.guid, 1);
          await h.sleep(1500);
        } else {
          let sold = 0;
          for (const s of step.sell) {
            if (job.cancelled) break;
            const r = await h.sell(s.guid, null);
            if (r.ok) sold++;
          }
          if (!sold) break; // the vendor took none of it: don't ask again
        }
        if (h.now() - bail > 60_000) return ['bail, Timeout expired', ...this.thinkOrWrite(`AutoVendor finished: ${name}`, think)];
        bail = h.now();
      }
      return this.thinkOrWrite(`AutoVendor finished: ${name}`, think);
    } finally {
      if (this.jobs.get('vendor') === job) this.jobs.delete('vendor');
      h.holdNav(0);
    }
  }

  private vendorOpen(name: string, partial: boolean): string[] {
    const v = this.findName(name, partial, ['vendor']);
    const think = this.store.bool('AutoVendor.Think');
    if (!v) return this.thinkOrWrite('AutoVendor failed to open vendor', think);
    const job = { cancelled: false };
    this.jobs.set('vendor-open', job);
    void (async () => {
      const tries = this.store.num('AutoVendor.Tries');
      const wait = this.store.num('AutoVendor.TriesTime');
      for (let i = 0; i < tries && !job.cancelled; i++) {
        this.host.holdNav(500 + wait);
        await this.host.use(v.guid);
        const end = this.host.now() + wait;
        while (this.host.now() < end && !job.cancelled) {
          if (this.host.vendor()?.guid === v.guid) { this.jobs.delete('vendor-open'); return; }
          await this.host.sleep(200);
        }
      }
      this.jobs.delete('vendor-open');
      this.host.holdNav(0);
      if (!job.cancelled) for (const l of this.thinkOrWrite('AutoVendor failed to open vendor', think)) this.host.print(l);
    })();
    return [];
  }

  private async vendorCmd(a: string): Promise<string[]> {
    const [verb = '', ...restParts] = a.trim().split(/\s+/);
    const rest = restParts.join(' ');
    const v = this.host.vendor();
    const lv = verb.toLowerCase();
    const countAndName = (s: string): { n: number; name: string } => { const m = /^(\d+)\s+(.+)$/.exec(s); return m ? { n: Number(m[1]), name: m[2]! } : { n: 1, name: s }; };
    switch (lv) {
      case 'open': return this.vendorOpen(rest, !rest);
      case 'openp': return this.vendorOpen(rest, true);
      case 'opencancel': { const j = this.jobs.get('vendor-open'); if (j) j.cancelled = true; this.host.holdNav(0); return []; }
      case 'buy': case 'buyall': {
        if (!v) return ['buyall: No vendor open'];
        const list = this.vendorLists.buy.splice(0);
        for (const b of list) this.host.buy(b.guid, b.amount);
        return [];
      }
      case 'sell': case 'sellall': {
        if (!v) return ['sellall: No vendor open'];
        const list = this.vendorLists.sell.splice(0);
        for (const s of list) await this.host.sell(s.guid, s.amount);
        return [];
      }
      case 'clearbuy': this.vendorLists.buy = []; return [];
      case 'clearsell': this.vendorLists.sell = []; return [];
      case 'addbuy': case 'addbuyp': {
        const { n, name } = countAndName(rest);
        if (!v) return ['addbuy: No vendor open'];
        const want = name.toLowerCase();
        const it = v.items.find((i) => (lv === 'addbuyp' ? i.name.toLowerCase().includes(want) : i.name.toLowerCase() === want));
        if (!it) return [`addbuy: Unable to find item ${lv === 'addbuyp' ? 'partially ' : ''}named '${name}' in vendor sell list`];
        this.vendorLists.buy.push({ guid: it.guid, amount: n, name: it.name });
        return [`Added item to buy list: ${it.name} * ${n}`];
      }
      case 'addsell': case 'addsellp': {
        const { n, name } = countAndName(rest);
        if (!v) return ['addsell: No vendor open'];
        const want = name.toLowerCase();
        const opts = { neverSell: this.store.list('AutoVendor.NeverSell'), onlyMainPack: false };
        const found = this.host.inventory().filter((i) => (lv === 'addsellp' ? i.name.toLowerCase().includes(want) : i.name.toLowerCase() === want)).filter((i) => this.safe(i, opts));
        if (!found.length) return [`addsell: Unable to find item ${lv === 'addsellp' ? 'partially ' : ''}named '${name}' in inventory`];
        // UB AddItemToSellList: whole stacks while they fit the count, then a split of the smallest bigger one.
        let need = n;
        let oversized: AgentItem | null = null;
        for (const i of found) {
          const s = Math.max(1, i.stack ?? 1);
          if (s <= need) { this.vendorLists.sell.push({ guid: i.guid, amount: null, name: i.name }); need -= s; } else if (!oversized || (oversized.stack ?? 1) > s) oversized = i;
          if (need === 0) break;
        }
        if (need > 0 && oversized) { this.vendorLists.sell.push({ guid: oversized.guid, amount: need, name: oversized.name }); need = 0; }
        return need === 0 ? [`Added item to sell list: ${found[0]!.name} * ${n}`] : [`Added item to sell list: ${found[0]!.name} * ${n}, but was missing ${need} items`];
      }
      default: return ['Usage: /ub vendor {open[p] [vendorname,vendorid,vendorhex],opencancel,buyall,sellall,clearbuy,clearsell,addsell[p] [count] itemname,addbuy[p] [count] itemname}'];
    }
  }

  private safe(i: AgentItem, o: { neverSell: readonly string[]; onlyMainPack: boolean }): boolean {
    return sellList([{ action: 'sell', match: {} }], [i], (g) => this.host.itemData(g), o).length === 1;
  }

  // ── Equipment Manager ──

  private equipProfile(name: string): LootRule[] | null {
    const stem = name.replace(/\.utl$/i, '').trim();
    const own = Object.entries(this.store.data.equip).find(([k]) => k.toLowerCase() === stem.toLowerCase());
    return own ? own[1] : this.lootSet(stem);
  }

  private async equip(a: string): Promise<string[]> {
    const m = /^(load|list|test|create)(?:\s+(.*))?$/i.exec(a.trim());
    if (!m) return ['Usage: /ub equip {list | load [lootProfile] | test [lootProfile] | create [lootProfile]}'];
    const verb = m[1]!.toLowerCase();
    const given = (m[2] ?? '').replace(/\.utl$/i, '').trim();
    const me = this.host.me();
    if (verb === 'list') {
      const own = Object.keys(this.store.data.equip);
      const sets = this.host.lootSetNames();
      return ['Equip Profiles:', ...own.map((n) => ` * ${n}.utl (this character)`), ...sets.map((n) => ` * ${n}.utl (loot profiles)`)];
    }
    if (verb === 'create') {
      const name = given || me?.name || 'equip';
      this.store.data.equip[name] = profileFromWorn(this.host.inventory());
      this.store.save();
      return [`Profile created: ${name}.utl (${this.store.data.equip[name]!.length} items)`];
    }
    const name = given || me?.name || '';
    const rules = this.equipProfile(name) ?? this.equipProfile('default');
    if (!rules) return [`No equip profile exists: ${name}.utl`];
    if (this.jobs.has('equip')) return ['Equipment Manager is already running'];
    const job = { cancelled: false };
    this.jobs.set('equip', job);
    try {
      // UB asks the server about every wearable piece it doesn't know yet (its Assessor), then plans.
      const inv = this.host.inventory();
      for (const i of inv) if ((i.fits || i.where === 'equipped') && !this.host.itemData(i.guid)) await this.host.appraise(i.guid);
      const wear = equipPlan(rules, this.host.inventory(), (g) => this.host.itemData(g));
      if (verb === 'test') return ['Will attempt to equip the following items in order:', ...wear.map((i) => ` * ${i.name} <${i.guid}>`)];
      const t0 = this.host.now();
      this.host.holdNav(30_000);
      for (const off of toTakeOff(this.host.inventory(), wear)) {
        if (job.cancelled) break;
        this.host.unequip(off.guid);
        await this.host.sleep(600);
      }
      for (const w of wear) {
        for (let tries = 0; tries < 15 && !job.cancelled; tries++) {
          if (this.host.inventory().find((i) => i.guid === w.guid)?.where === 'equipped') break;
          this.host.holdNav(30_000);
          await this.host.equip(w.guid);
        }
      }
      const secs = Math.round((this.host.now() - t0) / 100) / 10;
      return this.thinkOrWrite(`Equipment Manager: Finished equipping items in ${secs}s`, this.store.bool('EquipmentManager.Think'));
    } finally { this.jobs.delete('equip'); this.host.holdNav(0); }
  }

  /** UB calcdamage: a missile weapon's damage with its Blood Thirst cantrips and the mahogany it can still take. */
  private calcDamage(): string[] {
    const g = this.host.selected();
    if (g === null) return ['Nothing selected'];
    const item = this.host.inventory().find((i) => i.guid === g);
    const name = item?.name ?? this.host.nearby(60).find((o) => o.guid === g)?.name ?? `#${g.toString(16)}`;
    const p = this.host.itemData(g);
    if (!p) return [`${name} does not have id data, please examine it first.`];
    if (!(((item?.itemType ?? 0) & 0x100) !== 0)) return [`Calc Damage: ${item?.type ?? 'this item'} is not currently supported`];
    const maxDamage = p.int?.[44] ?? 0;
    const damageBonus = Math.round((p.float?.[63] ?? 0) * 100) / 100;
    const elemental = p.int?.[204] ?? 0;
    const spellBonus = bloodThirstBonus(p.spells ?? []);
    const tinks = p.int?.[171] ?? 0;
    const imbued = (p.int?.[179] ?? 0) > 0;
    const left = 10 - Math.min(10, tinks + (imbued ? 0 : 1));
    const dmg = (maxDamage + spellBonus + elemental) * (damageBonus + left * 0.04 - 1);
    return [
      ...(left > 0 ? [`${left} mahogany salvage adds ${Math.round(left * 0.04 * 100) / 100} to DamageModifier`] : []),
      'Formula: (DamageBonus + ElementalBonus) * DamageModifier',
      `Calculated Formula: (${maxDamage}(+${spellBonus} from cantrips) + ${elemental}) * ${Math.round((damageBonus - 1) * 100) / 100}(+${Math.round(left * 0.04 * 100) / 100} from ${left} tinkers)`,
      `Calculated (after tinks): ${Math.round(dmg * 100) / 100}`,
    ];
  }

  // ── AutoXp ──

  private xp(a: string): string[] {
    const m = /^(level|slow|test|export|import)(?:\s+(.*))?$/i.exec(a.trim());
    const policy = this.store.data.xpPolicy;
    if (!m) return ['Current experience policy weights:', ...Object.entries(policy).filter(([, w]) => w > 0).map(([k, w]) => `${k}: ${w}`)];
    const verb = m[1]!.toLowerCase();
    if (verb === 'export') return [exportXpPolicy(policy)];
    if (verb === 'import') {
      const r = importXpPolicy(policy, m[2] ?? '');
      this.store.data.xpPolicy = r.policy;
      this.store.save();
      return r.errors;
    }
    const xp = this.host.me()?.unassignedXp ?? 0;
    const plan = planXp({ xp, policy, costs: (t, n) => this.host.raiseCosts(t, n), stopBeforeMax: this.store.num('AutoXp.StopBeforeMax') });
    if (verb === 'test') {
      return [`Experience plan for ${xp} exp:`, ...[...plan].map(([t, steps]) => `${t}: ${steps.length} levels for ${steps.reduce((x, y) => x + y, 0)} xp`)];
    }
    if (this.jobs.has('xp')) { this.stopJob('xp'); return ['Stopping AutoXp.']; }
    const flat = flattenXpPlan(plan);
    if (!flat.length) return [];
    const job = { cancelled: false };
    this.jobs.set('xp', job);
    const gap = verb === 'slow' ? this.store.num('AutoXp.TriesTime') : 0;
    void (async () => {
      let done = 0;
      for (const step of flat) {
        if (job.cancelled) break;
        const r = this.host.raise(xpTargetLabel(step.target));
        if (!r.ok) continue;
        done++;
        await this.host.sleep(gap);
      }
      this.jobs.delete('xp');
      this.host.print(`Finished leveling ${done} targets.`);
    })();
    return [`Spending on a plan consisting of ${flat.length} steps with ${xp} available exp.`];
  }

  // ── aliases / game events ──

  private runner(): UbActionRunner {
    return {
      chat: (line) => this.host.chat(line),
      evaluate: (expr) => { try { return exprToString(this.host.evaluate(expr)); } catch (e) { this.host.print(`Error: ${(e as Error).message}`); return ''; } },
      setVar: (n, v) => this.host.setVar(n, v),
    };
  }

  /**
   * A line the player typed (main.ts's chat send): run the aliases it matches. True when one eats it
   * (the line goes no further). Aliases can't recurse into themselves past a few levels.
   */
  onChatSend(line: string): boolean {
    if (!this.store.bool('Aliases.Enabled') || !this.store.data.aliases.length || this.aliasDepth > 3) return false;
    this.aliasDepth++;
    try { return applyAliases(line, this.store.data.aliases, this.runner()); } finally { this.aliasDepth--; }
  }

  private fire(event: UbGameEventType, vars: Record<string, string | number>): void {
    if (!this.store.bool('GameEvents.Enabled')) return;
    fireGameEvent(event, vars, this.store.data.events, this.runner());
  }

  private parseAction(s: string): { type: UbActionType; rest: string } | null {
    const m = /^(ChatCommand|Expression|ChatExpression)\s+(.+)$/i.exec(s.trim());
    if (!m) return null;
    const type = (['ChatCommand', 'Expression', 'ChatExpression'] as const).find((t) => t.toLowerCase() === m[1]!.toLowerCase())!;
    return { type, rest: m[2]! };
  }

  private aliasCmd(a: string): string[] {
    const t = a.trim();
    const aliases = this.store.data.aliases;
    if (!t || /^list$/i.test(t)) return aliases.length ? aliases.map((x, i) => `${i + 1}. ${x.alias} -> ${x.action.type}: ${x.action.text}${x.eat ? '' : ' (not eaten)'}`) : ['No aliases.'];
    let m = /^remove\s+(\d+)$/i.exec(t);
    if (m) {
      const i = Number(m[1]) - 1;
      if (!aliases[i]) return [`No alias ${m[1]}`];
      aliases.splice(i, 1);
      this.store.save();
      return [`Removed alias ${m[1]}`];
    }
    m = /^add\s+(noeat\s+)?(.+)$/i.exec(t);
    if (!m) return ['Usage: /ub alias {list | add [noeat] <ChatCommand|Expression|ChatExpression> <regex> => <text> | remove <n>}'];
    const act = this.parseAction(m[2]!);
    const parts = act ? /^(.+?)\s+=>\s+(.+)$/.exec(act.rest) : null;
    if (!act || !parts) return ['Usage: /ub alias add [noeat] <ChatCommand|Expression|ChatExpression> <regex> => <text>'];
    try { new RegExp(parts[1]!); } catch (e) { return [`Invalid Alias Regex. ${(e as Error).message}`]; }
    aliases.push({ alias: parts[1]!, action: { type: act.type, text: parts[2]! }, eat: !m[1] });
    this.store.save();
    return [`Added alias ${aliases.length}: ${parts[1]} -> ${act.type}: ${parts[2]}`];
  }

  private eventsCmd(a: string): string[] {
    const t = a.trim();
    const events = this.store.data.events;
    if (!t || /^list$/i.test(t)) return events.length ? events.map((x, i) => `${i + 1}. ${x.event} -> ${x.action.type}: ${x.action.text}`) : ['No game events.'];
    let m = /^info\s+(\S+)$/i.exec(t);
    if (m) {
      const e = UB_GAME_EVENT_TYPES.find((x) => x.toLowerCase() === m![1]!.toLowerCase());
      return e ? [`Event: ${e}`, 'Event Variables:', ...GAME_EVENT_VARS[e].map((v) => `  $gevt_${v}`)] : [`Unknown event ${m[1]} (${UB_GAME_EVENT_TYPES.join(', ')})`];
    }
    m = /^remove\s+(\d+)$/i.exec(t);
    if (m) {
      const i = Number(m[1]) - 1;
      if (!events[i]) return [`No game event ${m[1]}`];
      events.splice(i, 1);
      this.store.save();
      return [`Removed game event ${m[1]}`];
    }
    m = /^add\s+(\S+)\s+(.+)$/i.exec(t);
    const e = m ? UB_GAME_EVENT_TYPES.find((x) => x.toLowerCase() === m![1]!.toLowerCase()) : undefined;
    const act = m ? this.parseAction(m[2]!) : null;
    if (!e || !act) return [`Usage: /ub events add <${UB_GAME_EVENT_TYPES.join('|')}> <ChatCommand|Expression|ChatExpression> <text>`];
    events.push({ event: e, action: { type: act.type, text: act.rest } });
    this.store.save();
    return [`Added game event ${events.length}: ${e} -> ${act.type}: ${act.rest}`];
  }

  // ── small commands ──

  private prepclick(a: string): string[] {
    const m = /^(yes|no|stop)(?:\s+(\d+))?$/i.exec(a.trim());
    if (!m) return ['Usage: /ub prepclick {stop|yes <secondstowatch>|no <secondstowatch>}'];
    if (m[1]!.toLowerCase() === 'stop') {
      if (!this.prepClick) return ['Message boxes are not currently being watched'];
      this.prepClick = null;
      return ['Stopping...'];
    }
    const lacks = this.host.eraLacks('confirmations');
    if (lacks) return [`This world has no ${lacks}, so there is no dialog to click.`];
    const secs = Number(m[2] ?? 0);
    if (secs > 3600) return [`${secs} is not a valid number of seconds to wait`];
    const button = m[1]!.toLowerCase() === 'yes' ? 'Yes' : 'No';
    this.prepClick = { button, until: this.host.now() + secs * 1000, seen: this.host.dialogs().length };
    return [`Will click ${m[1]!.toLowerCase()} on the next dialog to appear within ${secs} seconds`];
  }

  private playerOption(a: string): string[] {
    const t = a.trim();
    const names = Object.keys(PLAYER_OPTIONS);
    if (/^list$/i.test(t)) return [`Valid values are: ${names.join(', ')}`];
    const p = t.split(/\s+/);
    if (p.length !== 2) return ['Usage: /ub playeroption <option> <on/true|off/false>'];
    const name = names.find((n) => n.toLowerCase() === p[0]!.toLowerCase());
    if (!name) return [`Invalid option. Valid values are: ${names.join(', ')}`];
    if (!/^(on|true|off|false)$/i.test(p[1]!)) return ['Usage: /ub playeroption <option> <on/true|off/false>'];
    const feature = PLAYER_OPTION_FEATURES[name];
    const lacks = feature ? this.host.eraLacks(feature) : null;
    if (lacks) return [`This world has no ${lacks}, so ${name} has nothing to set.`];
    const on = /^(on|true)$/i.test(p[1]!);
    if (!this.host.setPlayerOption(PLAYER_OPTIONS[name]!, on)) return [`Unable to set ${name}`];
    return [`Set player option ${name} to ${on ? 'On' : 'Off'}`];
  }

  private async fellow(a: string): Promise<string[]> {
    const m = /^(create|quit|disband|open|close|status|recruitp?|dismissp?|leaderp?)(?:\s+(.+))?$/i.exec(a.trim());
    if (!m) return ['Usage: /ub fellow {create <name> | quit | disband | open | close | status | recruit[p] [name] | dismiss[p] [name] | leader[p] [name]}'];
    const verb = m[1]!.toLowerCase();
    const arg = (m[2] ?? '').trim();
    const base = verb.replace(/p$/, '');
    const partial = verb.endsWith('p') && base !== verb;
    if (verb === 'status') { const r = await this.host.fellowship('show'); return [r.message]; }
    if (verb === 'create') { if (!arg) return ['Usage: /ub fellow create <name>']; const r = await this.host.fellowship('create', arg); return r.ok ? [] : [r.message]; }
    if (['quit', 'disband', 'open', 'close'].includes(verb)) { const r = await this.host.fellowship(verb); return r.ok ? [] : [r.message]; }
    // recruit / dismiss / leader: a player by name (closest without one, as UB FindName).
    const p = this.findName(arg, partial, PLAYER_KINDS);
    if (!p) return [`Could not find ${arg ? `player ${arg}` : 'closest player'}`];
    const r = await this.host.fellowship(base, base === 'recruit' ? p.name : p.name);
    return r.ok ? [] : [r.message];
  }

  private login(a: string): string[] {
    const m = /^(next|clear|list)(.*)$/i.exec(a.trim());
    if (!m) return ['Available /ub login commands are: clear|list|next'];
    const sorted = [...this.host.characters()].sort((x, y) => x.localeCompare(y));
    const me = this.host.me()?.name ?? '';
    switch (m[1]!.toLowerCase()) {
      case 'list': return [`Listing ${sorted.length} logins.`, `${'Index'.padEnd(10)}${'Name'.padEnd(30)}`, ...sorted.map((n, i) => `${String(i).padEnd(10)}${(n === me ? `**${n}**` : n).padEnd(30)}`)];
      case 'clear': this.host.setNextLogin(null); return ['Next login cleared.'];
      default: {
        let t = m[2]!.trim();
        if (!t) return ['Specify part of name or index: /ub login next <name|index>'];
        let relative = false, looping = false;
        if (t.startsWith('r')) { relative = true; t = t.slice(1).trim(); }
        if (t.startsWith('l')) { looping = true; t = t.slice(1).trim(); }
        let index: number;
        if (/^-?\d+$/.test(t)) {
          index = Number(t);
          if (relative) {
            const cur = sorted.findIndex((n) => n.toLowerCase().includes(me.toLowerCase()) && !!me);
            if (cur < 0) { this.host.setNextLogin(null); return ['Unable to login relative to newly created characters.']; }
            index += cur;
          }
          if (looping && sorted.length) index = (((index + sorted.length) % sorted.length) + sorted.length) % sorted.length;
        } else {
          index = sorted.findIndex((n) => n.toLowerCase().includes(t.toLowerCase()));
          if (index < 0) { this.host.setNextLogin(null); return [`No character found with name ${t}.  Clearing next login.`]; }
        }
        if (index < 0 || index >= sorted.length) { this.host.setNextLogin(null); return ['Login index is out of bounds.  Use the [l]oop option to wrap around: /ub login nextl -100']; }
        this.host.setNextLogin(sorted[index]!);
        return [`Logging in as ${sorted[index]} next at index ${index}`];
      }
    }
  }

  // ── tinkering ──

  private async tinkerReady(): Promise<{ table: TinkerRow[] } | string> {
    const lacks = this.host.eraLacks('salvage');
    if (lacks) return `This world has no ${lacks}.`;
    const table = await this.host.tinkerTable();
    if (!table.length) return "This world's recipes have no tinkering.";
    return { table };
  }

  private async tinkcalc(): Promise<string[]> {
    const ready = await this.tinkerReady();
    if (typeof ready === 'string') return [ready];
    const g = this.host.selected();
    if (g === null) return ['Nothing selected'];
    const item = this.host.inventory().find((i) => i.guid === g);
    const name = item?.name ?? `#${g.toString(16)}`;
    const r = await this.host.appraise(g);
    const p = this.host.itemData(g);
    if (!r.ok || !p) return [name, `${name} does not have id data`];
    if (((item?.itemType ?? 0) & 0x1) === 0) return [name, 'tinkcalc only currently works with melee weapons'];
    const best = bestGraniteIron({ maxDamage: p.int?.[44] ?? 0, variance: p.float?.[22] ?? 0, tinks: p.int?.[171] ?? 0, spells: p.spells ?? [] });
    return [name, `${name}: Final max damage: ${best.finalDps.toFixed(2)}, ${best.granite} granite, ${best.iron} iron`];
  }

  private bags(): TinkerBag[] {
    return this.host.inventory().filter((i) => i.materialType && /salvage/i.test(i.name) && (i.structure ?? 100) >= 100)
      .map((i) => ({ guid: i.guid, name: i.name, material: i.materialType!, workmanship: i.workmanship ?? 0 }));
  }

  private async autotinker(a: string): Promise<string[]> {
    const t = a.trim();
    if (/^stop$/i.test(t)) { this.stopJob('tinker'); return ['AutoTinker stopped.']; }
    const ready = await this.tinkerReady();
    if (typeof ready === 'string') return [ready];
    if (/^start$/i.test(t)) return this.runTinkers();
    const g = this.host.selected();
    if (g === null) return ['Select the item to tinker first.'];
    const item = this.host.inventory().find((i) => i.guid === g);
    if (!item) return ['The item to tinker must be in your inventory.'];
    await this.host.appraise(g);
    const p = this.host.itemData(g);
    if (!p) return [`${item.name} does not have id data`];
    const m = /^(.*?)(?:\s+(\d+))?$/.exec(t)!;
    const which = (m[1] ?? '').trim();
    let material: number | 'best' = 'best';
    if (which && !/^best$/i.test(which)) {
      const want = which.toLowerCase().replace(/\s+/g, '');
      const hit = ready.table.find((r) => getMaterialName(r[0]).toLowerCase().replace(/\s+/g, '') === want);
      if (!hit) return [`${which} doesn't tinker in this world`];
      material = hit[0];
    }
    const maxTinks = m[2] ? Math.min(10, Number(m[2])) : this.store.num('AutoTinker.MaxTinks');
    const skills = this.host.skills();
    // ACE GetTinkerChance: the skill's current value plus LumAugSkilledCraft (PropertyInt 343); imbues add
    // AugmentationBonusImbueChance (236) × 5 %. (Jack of All Trades is already in the skill's current value.)
    const craft = this.host.charInt(343) ?? 0;
    const plan = planTinkers({
      table: ready.table,
      target: { guid: g, name: item.name, workmanship: p.int?.[105] ?? 0, tinks: p.int?.[171] ?? 0, melee: ((item.itemType ?? 0) & 0x1) !== 0, maxDamage: p.int?.[44] ?? 0, variance: p.float?.[22] ?? 0, spells: p.spells ?? [] },
      bags: this.bags(),
      material,
      skillOf: (id) => (skills.find((s) => s.id === id)?.buffed ?? 0) + craft,
      minChance: this.store.num('AutoTinker.MinPercentage'),
      maxTinks,
      imbueAugs: this.host.charInt(236) ?? 0,
    });
    this.tinkerQueue = { target: g, targetName: item.name, steps: plan.steps, stop: plan.stop };
    return [...this.getjob(), 'Type /ub autotinker start to apply them, /ub autotinker stop to stop.'];
  }

  private getjob(): string[] {
    const q = this.tinkerQueue;
    if (!q || !q.steps.length) return [`No tinker jobs queued${q ? ` (${q.stop})` : ''}.`];
    return [`Tinker jobs for ${q.targetName}:`, ...q.steps.map((s) => `  ${s.tinkNo}. ${s.bag.name} (w${s.bag.workmanship.toFixed(2)}): ${(s.chance * 100).toFixed(2)}%`), `  then: ${q.stop}`];
  }

  private async runTinkers(): Promise<string[]> {
    const q = this.tinkerQueue;
    if (!q || !q.steps.length) return ['No tinker jobs queued: select the item and /ub autotinker <salvage>|best first.'];
    if (this.jobs.has('tinker')) return ['AutoTinker is already running.'];
    const job = { cancelled: false };
    this.jobs.set('tinker', job);
    void (async () => {
      const table = await this.host.tinkerTable();
      let applied = 0;
      for (const s of q.steps) {
        if (job.cancelled) break;
        // Re-check against what the item is now (a failed tink destroys it; a success raises its count).
        await this.host.appraise(q.target);
        const p = this.host.itemData(q.target);
        if (!p || !this.host.inventory().some((i) => i.guid === q.target)) { this.host.print(`AutoTinker: ${q.targetName} is gone.`); break; }
        const rule = tinkerRule(table, s.bag.material);
        const skills = this.host.skills();
        const chance = rule ? tinkerChance({ material: s.bag.material, bagWork: s.bag.workmanship, itemWork: p.int?.[105] ?? 0, tinks: p.int?.[171] ?? 0, skill: (skills.find((x) => x.id === rule.skill)?.buffed ?? 0) + (this.host.charInt(343) ?? 0), imbue: rule.imbue, imbueAugs: this.host.charInt(236) ?? 0 }) : 0;
        if (chance * 100 < this.store.num('AutoTinker.MinPercentage')) { this.host.print(`AutoTinker: ${s.bag.name} is now ${(chance * 100).toFixed(2)}%, under ${this.store.num('AutoTinker.MinPercentage')}%: stopping.`); break; }
        const r = this.host.useOn(s.bag.guid, q.target);
        if (!r.ok) { this.host.print(`AutoTinker: ${r.message}`); break; }
        // The server's chance-of-success confirmation, as UB answers it.
        for (let i = 0; i < 25; i++) {
          await this.host.sleep(200);
          if (this.host.dialogs().some((d) => d.buttons.some((b) => /^yes$/i.test(b)))) { this.host.answerDialog('Yes'); break; }
        }
        await this.host.sleep(2500);
        applied++;
      }
      this.jobs.delete('tinker');
      this.tinkerQueue = null;
      this.host.print(`AutoTinker finished: ${applied} applied to ${q.targetName}.`);
    })();
    return [`AutoTinker: applying ${q.steps.length} to ${q.targetName}.`];
  }

  // ── every frame ──

  /**
   * The frame tick (main.ts): delayed commands, prepclick, the quest reply, AutoVendor on a vendor's
   * opening, and the game events (login, logout, death).
   */
  tick(): void {
    const h = this.host;
    const t = h.now();
    while (this.delayed.length && this.delayed[0]!.at <= t) h.chat(this.delayed.shift()!.line);
    if (this.prepClick) {
      const d = h.dialogs();
      if (t > this.prepClick.until) { h.print(`Time has expired: ${Math.round((this.prepClick.until - t) / 1000)}`); this.prepClick = null; }
      else if (d.length > this.prepClick.seen) {
        const b = this.prepClick.button;
        h.print(`Click ${b} on ${d[d.length - 1]!.text}`);
        h.answerDialog(b);
        this.prepClick = null;
      } else this.prepClick.seen = d.length;
    }
    // AutoVendor starts when a vendor opens (UB WorldFilter_ApproachVendor), when a profile names it.
    const v = h.vendor();
    if ((v?.guid ?? null) !== this.vendorSeen) {
      this.vendorSeen = v?.guid ?? null;
      if (v && this.store.bool('AutoVendor.Enabled') && !this.jobs.has('vendor') && this.vendorProfile(v.name, null)) this.startVendor(null).forEach((l) => h.print(l));
    }
    // Game events: LoginComplete when the world is reached, Logout on leaving it, CharacterDeath on the drop line.
    const screen = h.screen();
    const me = h.me();
    if (this.lastScreen === null) { this.lastScreen = screen; this.lastName = me?.name ?? null; }
    if (screen !== this.lastScreen) {
      if (screen === 'world' && me && this.lastScreen !== 'portal-space') {
        this.fire('Login', { id: me.guid, name: me.name });
        this.fire('LoginComplete', { id: me.guid, name: me.name });
        this.lastName = me.name;
      } else if ((screen === 'character-select' || screen === 'loading') && this.lastScreen === 'world' && this.lastName) {
        this.fire('Logout', { id: 0, name: this.lastName });
      }
      this.lastScreen = screen;
    }
    if (this.eventSeq < 0) this.eventSeq = h.currentSeq();
    for (const e of h.eventsSince(this.eventSeq)) {
      this.eventSeq = Math.max(this.eventSeq, e.seq);
      if (e.type === 'death') this.deathMessage = e.text;
      if (e.type === 'chat') {
        const drops = deathDrops(e.text.replace(/^\([a-z]+\) /, ''));
        if (drops !== null && this.deathMessage) { this.fire('CharacterDeath', { deathmessage: this.deathMessage, droppeditems: drops }); this.deathMessage = ''; }
      }
    }
  }

}
