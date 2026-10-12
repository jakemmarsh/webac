/**
 * The game side of `/ub` (ubCommands.ts UbHost) over the agent API, so every
 * action takes the client's own path (use, select, give, the vendor bar, the
 * character panel's Raise, the fellowship and allegiance panes). main.ts hands
 * in only what the agent API doesn't carry.
 */
import type { ExprValue, LootRule, VarScope } from '@ac/shared';
import type { AgentApi } from '../AgentApi.ts';
import type { UbHost, UbSelf } from './ubCommands.ts';
import type { TinkerRow } from './tinker.ts';

export interface UbHostExtras {
  print(text: string): void;
  /** A line as typed into the chat box. */
  chat(line: string): void;
  vitae(): number;
  position(guid: number): { cell: string; x: number; y: number; z: number; coords: string | null } | null;
  openContainer(): { guid: number; name: string; corpse: boolean; items: Array<{ guid: number; name: string }> } | null;
  useNow(guid: number): boolean;
  exitGame(): void;
  evaluate(expr: string): ExprValue;
  vars(scope: VarScope): Array<[string, ExprValue]>;
  setVar(name: string, value: string): void;
  freeSlots(): number;
  /** The running routine profile's loot sets (and their names). */
  lootSets(): Record<string, LootRule[]> | null;
  playerOption(code: number): boolean | undefined;
  setPlayerOption(code: number, on: boolean): boolean;
  characters(): string[];
  setNextLogin(name: string | null): void;
  raiseCosts(stat: string, steps: number): number[] | null;
  charInt(id: number): number | undefined;
  eraLacks(feature: string): string | null;
  tinkerTable(): Promise<TinkerRow[]>;
  /** UB's map windows (ui/maps/UbMaps.ts). */
  toggleMap?(which: 'dungeon' | 'landscape'): string;
}

export function createUbHost(api: AgentApi, x: UbHostExtras): UbHost {
  const sets = (): Record<string, LootRule[]> => x.lootSets() ?? {};
  return {
    now: () => performance.now(),
    nowSec: () => Date.now() / 1000,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
    print: x.print,
    chat: x.chat,
    me: (): UbSelf | null => {
      const s = api.self();
      if (!s) return null;
      return { guid: s.guid, name: s.name, heading: s.heading, coords: s.coords, cell: s.cell, pos: s.pos, vitae: x.vitae(), pyreals: s.pyreals ?? 0, unassignedXp: s.xp?.unassigned ?? 0, combatMode: s.combatMode };
    },
    screen: () => api.status().screen,
    selected: () => api.selectedGuid(),
    inventory: () => api.inventory(),
    nearby: (r) => api.nearby(r),
    position: x.position,
    openContainer: x.openContainer,
    itemData: (g) => api.itemData(g),
    appraise: (g) => api.appraise(g, { quiet: true }),
    use: (g) => api.use(g),
    useNow: x.useNow,
    useOn: (a, b) => api.useOn(a, b),
    select: (g) => api.select(g),
    give: (i, t, n) => api.give(i, t, n),
    turn: (h) => api.turn(h),
    jump: (o) => api.jump(o),
    combatMode: (m) => api.combatMode(m),
    equip: (g) => api.equip(g),
    unequip: (g) => api.placeItem(g, { packSlot: 0 }),
    splitStack: (g, n) => api.splitStack(g, n).ok,
    logout: () => api.logout(),
    exitGame: x.exitGame,
    evaluate: x.evaluate,
    vars: x.vars,
    setVar: x.setVar,
    propertyDump: () => api.routine.propertyDump(),
    follow: (name) => api.routine.followPlayer(name),
    holdNav: (ms) => api.routine.holdNav(ms),
    vendor: () => (api.vendorOpen() ? vendorOf(api) : null),
    buy: (g, n) => api.buy(g, n),
    sell: (g, n) => api.sell(g, n),
    freeSlots: x.freeSlots,
    lootSet: (name) => {
      const all = sets();
      const k = Object.keys(all).find((n) => n.toLowerCase() === name.toLowerCase());
      return k ? all[k]! : null;
    },
    lootSetNames: () => Object.keys(sets()),
    dialogs: () => api.openDialogs(),
    answerDialog: (b) => api.dialog(b).ok,
    playerOption: x.playerOption,
    setPlayerOption: x.setPlayerOption,
    characters: x.characters,
    setNextLogin: x.setNextLogin,
    fellowship: (a, arg) => api.fellowship(a, arg),
    swear: (g) => api.swearAllegiance(g),
    breakAllegiance: (n) => api.breakAllegiance(n),
    skills: () => api.skillList(),
    raiseCosts: x.raiseCosts,
    raise: (stat) => {
      const r = api.raiseOnce(stat, Number.MAX_SAFE_INTEGER);
      return r.ok ? { ok: true, message: `${r.name} ${r.from} → ${r.to}`, cost: r.cost } : { ok: false, message: r.message };
    },
    charInt: x.charInt,
    eraLacks: x.eraLacks,
    tinkerTable: x.tinkerTable,
    currentSeq: () => api.currentSeq(),
    eventsSince: (seq) => api.eventsSince(seq),
    toggleMap: x.toggleMap,
  };
}

/** The open vendor as the agent API lists it (its window's merchandise). */
function vendorOf(api: AgentApi): ReturnType<UbHost['vendor']> {
  return api.vendorData();
}
