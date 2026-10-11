/**
 * AGENT.vtank-window — the automation UI's default: a window laid out as
 * VirindiTank's (Jake, 2026-10-10: "i would rather have the vtank-style
 * window and it should be the default"), so players coming from Decal find
 * every control where they left it. Reference: the virindi.net wiki's
 * screenshots of each tab (Virindi_Tank_Standard_Options, Virindi_Tank_Meta_
 * System). Tabs in VTank's order; settings under VTank's own option names
 * (profile.settings, vtankOptions.ts); a change applies to the running macro
 * at once and saves to the account, as VTank saves every change.
 *
 * The art is the game's: VVS draws portal.dat images, and the matching ids
 * (bullets 0x06004d15/17, dropdown 0x060012b1, arrows 0x060028fc/fd, set-
 * current 0x060011f7, delete 0x060011f8, scrollbar 0x06004c63/69/6c, frame
 * 0x06006129-2b) were found by pixel match against the screenshots
 * (docs/automation-vtank-window.md). No Virindi art or code is used.
 *
 * A control is drawn only when the engine does what it says (no dead-end UI).
 */
import {
  type RoutineAction, type RoutineCondition, type RoutineDoc, type RoutineProfile, type RoutineRule, type Route, type VtMonsterRow, type VtOption, type VtankProfileData,
  ROUTINE_SCHEMA_VERSION, VT_DEFAULT_MONSTER, VT_MONSTER_COLUMNS, VT_OPTIONS, emptyVtankData, validateRoutineDoc, vtankChatCommand, vtDisplayValue, vtFromVTank, vtOption, vtStoredValue, vtToVTank,
} from '@ac/shared';
import type { RoutineStatus } from '../../agent/RoutineEngine.js';
import { matchMonsterRow } from '../../agent/macro/combatPlan.js';
import { addAllPeas } from '../../agent/macro/peaPlan.js';
import { dispelOptionsAvailable } from '../../agent/macro/vtMacro.js';
import { type AutomationKit, type AutomationSource, type MenuItem, newProfile } from './AutomationPanel.js';

export type VtTab = 'options' | 'profiles' | 'vitals' | 'monsters' | 'items' | 'consumables' | 'buffs' | 'route' | 'meta';

/** VirindiTank's tabs, in its order. A tab whose engine support isn't built is left out (VT_TAB_READY). */
export const VT_TABS: Array<{ id: VtTab; label: string }> = [
  { id: 'options', label: 'Options' }, { id: 'profiles', label: 'Profiles' }, { id: 'vitals', label: 'Vitals' },
  { id: 'monsters', label: 'Monsters' }, { id: 'items', label: 'Items' }, { id: 'consumables', label: 'Consumables' },
  { id: 'buffs', label: 'Buffs' }, { id: 'route', label: 'Route' }, { id: 'meta', label: 'Meta' },
];
export const VT_TAB_READY: Record<VtTab, boolean> = {
  options: true, profiles: true, vitals: true, monsters: true, items: true, consumables: true, buffs: true, route: true, meta: true,
};

/** What the window needs beyond the panel's source: live settings and state, and live profile edits. */
export interface VTankSource extends AutomationSource {
  setting(name: string): string | number | boolean | undefined;
  setSetting(name: string, value: string | number | boolean): void;
  setState(name: string): { ok: boolean; message: string };
  update(profile: RoutineProfile): { ok: boolean; message: string };
  /** /vt mexec: run a meta expression, its value as text. */
  mexec(expr: string): string;
  /** /vt jump [heading] [shift] [ms]. */
  jump(opts: { heading?: number; walk?: boolean; holdMs?: number }): { ok: boolean; message: string };
  /** /vt fakedeath. */
  fakeDeath(): { ok: boolean; message: string };
  /** /vt reverseroute. */
  reverseRoute(): { ok: boolean; message: string };
  /** VirindiTank's current-waypoint arrow: the running macro's loaded (circular) route walks next to its point nearest you. */
  setNearestWaypoint(): { ok: boolean; message: string };
  /** VirindiTank's Force Buff / Cancel Force Buff. */
  forceBuff(): { ok: boolean; message: string };
  cancelForceBuff(): { ok: boolean; message: string };
  /** The active era's SpellTable (options that need a spell the era lacks are hidden); null while unknown. */
  spellTable?(): { spells: Map<number, { desc: string }> } | null;
  /** The selected object's name and kind (Route's Add Portal/NPC, Open Vendor; Items / Consumables' Add: an item you carry is kind 'item'). */
  selection(): { name: string; kind: string } | null;
  /**
   * Whether the active era's SkillTable (0x0E000004) has a skill, by name
   * ("Summoning", "Void Magic"); undefined when the table isn't loaded. Controls
   * for a skill the era lacks are not drawn (Dark Majesty and AC1999 have
   * neither Summoning nor Void Magic).
   */
  hasSkill?(name: string): boolean | undefined;
  /** Whether the active era's SpellTable has a spell id (Tusker Fists 2934 for the Fists damage type); undefined when unknown. */
  hasSpell?(id: number): boolean | undefined;
}

/** The options that only mean something with the Summoning skill (Summon Pets and its settings). */
export const VT_PET_OPTIONS = new Set(['SummonPets', 'PetRangeMode', 'PetCustomRange', 'PetMonsterDensity', 'PetRefillCount-Idle', 'PetRefillCount-Normal']);
/** The Monsters-tab columns that cast Void Magic. */
export const VT_VOID_COLUMNS = new Set<string>(['WC', 'FC', 'Cp', 'DC', 'Cs']);

/** The window's extra parts (GameUI implements them from the DAT; tests fake them). */
export interface VTankKit extends AutomationKit {
  /** A portal.dat image, drawn `size` px square; clickable when given a handler. */
  icon(id: number, size: number, onClick?: () => void): HTMLElement;
  /** VVS's button: a label in a 1 px tan frame. */
  flatButton(label: string, onClick: () => void, width: number, height?: number): HTMLElement;
  /** VVS's dropdown: the value's text and the green arrow (0x060012b1); a click hands the anchor over. */
  dropdown(text: string, onClick: (anchor: HTMLElement) => void, width: number): HTMLElement;
  /** VVS's slider: a tan track and a knob; integer values min..max. */
  slider(value: number, min: number, max: number, width: number, onChange: (v: number) => void): HTMLElement;
  /** A tab label (VVS draws them as plain text, the open one gold). */
  textTab(label: string, on: boolean, onClick: () => void): HTMLElement;
  /** A list box with VVS's scrollbar (the retail blue track and gold caps). */
  list(host: HTMLElement): void;
}

/** A second window (Edit Meta Rule) the host floats over the world. */
export interface VTankDialogs {
  open(title: string, w: number, h: number, draw: (body: HTMLElement, redraw: () => void, close: () => void) => void): void;
  close(): void;
}

/** VirindiTank's Options tab: each option's place (Vtank_Main.PNG). Drawn only when the engine acts on it. */
/** What Follow mode's Add takes as the follow target: a player or any creature (VTank: the selection). */
const FOLLOW_KINDS = new Set(['player', 'monster', 'npc', 'vendor']);

export const VT_OPTIONS_LAYOUT: Array<{ name: string; kind: 'range' | 'check' | 'field' | 'box'; x: number; y: number }> = [
  { name: 'AttackDistance', kind: 'range', x: 8, y: 2 }, { name: 'RingDistance', kind: 'range', x: 8, y: 36 },
  { name: 'ApproachDistance', kind: 'range', x: 8, y: 69 }, { name: 'NavCloseStopRange', kind: 'range', x: 8, y: 103 },
  { name: 'EnableBuffing', kind: 'check', x: 97, y: 69 }, { name: 'EnableCombat', kind: 'check', x: 97, y: 89 },
  { name: 'EnableNav', kind: 'check', x: 97, y: 109 }, { name: 'EnableLooting', kind: 'check', x: 97, y: 129 }, { name: 'EnableMeta', kind: 'check', x: 97, y: 149 },
  { name: 'AutoStack', kind: 'check', x: 228, y: 9 }, { name: 'AutoCram', kind: 'check', x: 228, y: 29 },
  { name: 'UseDispelItems', kind: 'check', x: 228, y: 49 }, { name: 'CastDispelSelf', kind: 'check', x: 228, y: 69 },
  { name: 'AutoFellowManagement', kind: 'check', x: 228, y: 129 }, { name: 'ManaChargesWhenOff', kind: 'check', x: 228, y: 149 },
  { name: 'NavPriorityBoost', kind: 'check', x: 395, y: 9 }, { name: 'LootPriorityBoost', kind: 'check', x: 395, y: 29 },
  { name: 'LootOnlyRareCorpses', kind: 'check', x: 395, y: 49 }, { name: 'IdlePeaceMode', kind: 'check', x: 395, y: 69 }, { name: 'IdleBuffTopoff', kind: 'check', x: 395, y: 89 },
  { name: 'SummonPets', kind: 'check', x: 560, y: 9 }, { name: 'PetRangeMode', kind: 'check', x: 560, y: 29 }, { name: 'PetCustomRange', kind: 'box', x: 680, y: 27 }, { name: 'PetMonsterDensity', kind: 'field', x: 560, y: 51 },
];

/** The Vitals tab's sliders, in its three groups (an empty slot is the gap between groups). */
export const VT_VITALS_LAYOUT = ['Recharge-Norm-HitP', 'Recharge-Norm-Stam', 'Recharge-Norm-Mana', '', 'Recharge-NoTarg-HitP', 'Recharge-NoTarg-Stam', 'Recharge-NoTarg-Mana', '', 'Recharge-Helper-HitP', 'Recharge-Helper-Stam', 'Recharge-Helper-Mana'];
/** The Monsters tab's columns drawn in red (the attacks; Vtank_monsters.PNG). */
export const VT_ATTACK_COLUMNS = new Set<string>(['A', 'R', 'S', 'Cp', 'DC', 'Cs']);
const DAMAGE_NAMES: Record<number, string> = { 0: 'Pierce', 1: 'Bludgeon', 2: 'Slash', 3: 'Acid', 4: 'Lightning', 5: 'Cold', 6: 'Fire', 7: 'Harm', 8: 'Auto', 9: 'Void', 10: 'Drain Auto', 11: 'Prismatic', 12: 'Random', 13: 'Fists', 98: 'None', 99: 'Physical' };
export const vtDamageName = (v: number): string => DAMAGE_NAMES[v] ?? String(v);
/**
 * What a click on Dmg type / Ex. Vuln / PetDmg steps through (VTank cycles
 * them; its own order is not public). Only the types the combat planner acts
 * on. Prismatic (11) is Auto that shoots prismatic ammunition first (combatPlan
 * ammoFor). Void (9) needs Void Magic and Fists (13) Tusker Fists in the era's
 * tables (VTankWindow.damageCycle).
 */
export const VT_DAMAGE_CYCLE = [8, 0, 1, 2, 3, 4, 5, 6, 9, 7, 10, 11, 12, 13];
export const VT_EXVULN_CYCLE = [98, 8, 0, 1, 2, 3, 4, 5, 6];
/** PetDmg: PAuto, Auto, None, then the elements a summoning essence comes in (its UiEffects: acid, lightning, frost, fire). */
export const VT_PET_CYCLE = [101, 8, 98, 3, 4, 5, 6];
const PET_NAMES: Record<number, string> = { 101: 'PAuto' };
export const vtPetDamageName = (v: number): string => PET_NAMES[v] ?? vtDamageName(v);
const nextIn = (cycle: number[], v: number): number => cycle[(cycle.indexOf(v) + 1) % cycle.length];

/** Printed once when the macro first starts: each server sets its own rules on automation. */
export const VT_SERVER_RULES_NOTE = 'The macro plays this character for you. Each server has its own rules on macroing; check yours before leaving it running.';

export const VT_ICON = { up: 0x060028fc, down: 0x060028fd, current: 0x060011f7, remove: 0x060011f8 } as const;

const el = (tag: string, style: Partial<CSSStyleDeclaration> = {}, data: Record<string, string> = {}): HTMLElement => {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  for (const [k, v] of Object.entries(data)) e.dataset[k] = v;
  return e;
};
const at = (e: HTMLElement, x: number, y: number): HTMLElement => { Object.assign(e.style, { position: 'absolute', left: `${x}px`, top: `${y}px` }); return e; };
const tag = (e: HTMLElement, data: Record<string, string>): HTMLElement => { for (const [k, v] of Object.entries(data)) e.dataset[k] = v; return e; };
const row = (gap = 6): HTMLElement => el('div', { display: 'flex', alignItems: 'center', gap: `${gap}px`, position: 'relative' });

// ── Meta: VirindiTank's conditions and actions, in its order, under its names ──

type Param = { key: string; label: string; type: 'number' | 'text' | 'state' | 'route' };
export interface VtCondDef { id: string; label: string; make: () => RoutineCondition; is: (c: RoutineCondition) => boolean; params?: Param[]; get?: (c: RoutineCondition) => Record<string, string | number>; set?: (v: Record<string, string>) => RoutineCondition }
export interface VtActDef { id: string; label: string; make: (p: RoutineProfile) => RoutineAction[]; is: (a: RoutineAction[]) => boolean; params?: Param[]; get?: (a: RoutineAction[]) => Record<string, string | number>; set?: (v: Record<string, string>, p: RoutineProfile) => RoutineAction[] }

const n = (v: string | undefined, d = 0): number => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const isNever = (c: RoutineCondition) => c.kind === 'not' && c.condition.kind === 'always';

/** VirindiTank's condition list (the Edit Meta Rule dropdown, in the wiki's order), mapped to ours; "≤ n" is ours "below n + 1". */
export const VT_CONDITIONS: VtCondDef[] = [
  { id: 'never', label: 'Never', make: () => ({ kind: 'not', condition: { kind: 'always' } }), is: isNever },
  { id: 'always', label: 'Always', make: () => ({ kind: 'always' }), is: (c) => c.kind === 'always' },
  { id: 'any', label: 'Any', make: () => ({ kind: 'any', conditions: [] }), is: (c) => c.kind === 'any' },
  { id: 'all', label: 'All', make: () => ({ kind: 'all', conditions: [] }), is: (c) => c.kind === 'all' },
  { id: 'chat', label: 'Chat Message', make: () => ({ kind: 'chat-matches', pattern: '' }), is: (c) => c.kind === 'chat-matches',
    params: [{ key: 'pattern', label: 'Message (regex)', type: 'text' }], get: (c) => ({ pattern: (c as { pattern: string }).pattern }), set: (v) => ({ kind: 'chat-matches', pattern: v.pattern ?? '' }) },
  { id: 'slots', label: 'Pack Slots <=', make: () => ({ kind: 'free-slots-below', slots: 1 }), is: (c) => c.kind === 'free-slots-below',
    params: [{ key: 'slots', label: 'Slots', type: 'number' }], get: (c) => ({ slots: (c as { slots: number }).slots - 1 }), set: (v) => ({ kind: 'free-slots-below', slots: n(v.slots) + 1 }) },
  { id: 'secs', label: 'Seconds in State >=', make: () => ({ kind: 'seconds-in-state', seconds: 10 }), is: (c) => c.kind === 'seconds-in-state',
    params: [{ key: 'seconds', label: 'Seconds', type: 'number' }], get: (c) => ({ seconds: (c as { seconds: number }).seconds }), set: (v) => ({ kind: 'seconds-in-state', seconds: n(v.seconds) }) },
  { id: 'navempty', label: 'Navroute Empty', make: () => ({ kind: 'route-done' }), is: (c) => c.kind === 'route-done' },
  { id: 'death', label: 'Character Death', make: () => ({ kind: 'died' }), is: (c) => c.kind === 'died' },
  { id: 'vopen', label: 'Any Vendor Open', make: () => ({ kind: 'vendor-open' }), is: (c) => c.kind === 'vendor-open' },
  { id: 'vclosed', label: 'Vendor Closed', make: () => ({ kind: 'vendor-closed' }), is: (c) => c.kind === 'vendor-closed' },
  { id: 'countle', label: 'Inventory Item Count <=', make: () => ({ kind: 'item-count-below', item: '', count: 1 }), is: (c) => c.kind === 'item-count-below',
    params: [{ key: 'item', label: 'Item name', type: 'text' }, { key: 'count', label: 'Count', type: 'number' }],
    get: (c) => ({ item: (c as { item: string }).item, count: (c as { count: number }).count - 1 }), set: (v) => ({ kind: 'item-count-below', item: v.item ?? '', count: n(v.count) + 1 }) },
  { id: 'countge', label: 'Inventory Item Count >=', make: () => ({ kind: 'not', condition: { kind: 'item-count-below', item: '', count: 1 } }),
    is: (c) => c.kind === 'not' && c.condition.kind === 'item-count-below',
    params: [{ key: 'item', label: 'Item name', type: 'text' }, { key: 'count', label: 'Count', type: 'number' }],
    get: (c) => { const x = (c as { condition: { item: string; count: number } }).condition; return { item: x.item, count: x.count }; },
    set: (v) => ({ kind: 'not', condition: { kind: 'item-count-below', item: v.item ?? '', count: n(v.count) } }) },
  { id: 'moncount', label: 'Monster Name Count Within Distance', make: () => ({ kind: 'monster-count', pattern: '', count: 1, meters: 10 }),
    is: (c) => c.kind === 'monster-count' || (c.kind === 'monster-within' && !!c.names?.length),
    params: [{ key: 'pattern', label: 'Name (regex)', type: 'text' }, { key: 'count', label: 'Count', type: 'number' }, { key: 'meters', label: 'Distance', type: 'number' }],
    get: (c): Record<string, string | number> => c.kind === 'monster-count' ? { pattern: c.pattern, count: c.count, meters: c.meters } : c.kind === 'monster-within' ? { pattern: (c.names ?? []).join('|'), count: 1, meters: c.meters } : {},
    set: (v) => ({ kind: 'monster-count', pattern: v.pattern || '.', count: Math.max(1, n(v.count, 1)), meters: n(v.meters, 10) }) },
  { id: 'monprio', label: 'Monster Priority Count Within Distance', make: () => ({ kind: 'monster-priority-count', priority: 1, count: 1, meters: 10 }), is: (c) => c.kind === 'monster-priority-count',
    params: [{ key: 'priority', label: 'Priority', type: 'number' }, { key: 'count', label: 'Count', type: 'number' }, { key: 'meters', label: 'Distance', type: 'number' }],
    get: (c) => { const x = c as { priority: number; count: number; meters: number }; return { priority: x.priority, count: x.count, meters: x.meters }; },
    set: (v) => ({ kind: 'monster-priority-count', priority: Math.max(-1, Math.min(4, Math.round(n(v.priority, 1)))), count: Math.max(1, n(v.count, 1)), meters: n(v.meters, 10) }) },
  { id: 'needbuff', label: 'Need to Buff', make: () => ({ kind: 'need-buff' }), is: (c) => c.kind === 'need-buff' },
  { id: 'nomon', label: 'No Monsters Within Distance', make: () => ({ kind: 'no-monster-within', meters: 10 }), is: (c) => c.kind === 'no-monster-within',
    params: [{ key: 'meters', label: 'Distance', type: 'number' }], get: (c) => ({ meters: (c as { meters: number }).meters }), set: (v) => ({ kind: 'no-monster-within', meters: n(v.meters, 10) }) },
  { id: 'landblock', label: 'Landblock ==', make: () => ({ kind: 'landblock', landblock: 0 }), is: (c) => c.kind === 'landblock',
    params: [{ key: 'landblock', label: 'Landblock (hex)', type: 'text' }], get: (c) => ({ landblock: ((c as { landblock: number }).landblock >>> 0).toString(16).toUpperCase() }), set: (v) => ({ kind: 'landblock', landblock: (parseInt(v.landblock ?? '0', 16) >>> 0) || 0 }) },
  { id: 'landcell', label: 'Landcell ==', make: () => ({ kind: 'landcell', cell: 0 }), is: (c) => c.kind === 'landcell',
    params: [{ key: 'cell', label: 'Landcell (hex)', type: 'text' }], get: (c) => ({ cell: ((c as { cell: number }).cell >>> 0).toString(16).toUpperCase() }), set: (v) => ({ kind: 'landcell', cell: (parseInt(v.cell ?? '0', 16) >>> 0) || 0 }) },
  { id: 'pin', label: 'Portalspace Entered', make: () => ({ kind: 'portal-entered' }), is: (c) => c.kind === 'portal-entered' },
  { id: 'pout', label: 'Portalspace Exited', make: () => ({ kind: 'portal-exited' }), is: (c) => c.kind === 'portal-exited' },
  { id: 'not', label: 'Not', make: () => ({ kind: 'not', condition: { kind: 'died' } }), is: (c) => c.kind === 'not' },
  { id: 'psecs', label: 'Seconds in state (P) >=', make: () => ({ kind: 'seconds-in-state-persistent', seconds: 10 }), is: (c) => c.kind === 'seconds-in-state-persistent',
    params: [{ key: 'seconds', label: 'Seconds', type: 'number' }], get: (c) => ({ seconds: (c as { seconds: number }).seconds }), set: (v) => ({ kind: 'seconds-in-state-persistent', seconds: n(v.seconds) }) },
  { id: 'spelltime', label: 'Time Left On Spell >=', make: () => ({ kind: 'spell-time-at-least', spell: '', seconds: 60 }), is: (c) => c.kind === 'spell-time-at-least',
    params: [{ key: 'spell', label: 'Spell', type: 'text' }, { key: 'seconds', label: 'Seconds', type: 'number' }],
    get: (c) => { const x = c as { spell: string; spellId?: number; seconds: number }; return { spell: x.spell || (x.spellId ? `#${x.spellId}` : ''), seconds: x.seconds }; },
    set: (v) => { const id = /^#(\d+)$/.exec((v.spell ?? '').trim()); return id ? { kind: 'spell-time-at-least', spell: '', spellId: Number(id[1]), seconds: n(v.seconds) } : { kind: 'spell-time-at-least', spell: v.spell ?? '', seconds: n(v.seconds) }; } },
  { id: 'burden', label: 'Burden Percent >=', make: () => ({ kind: 'burden-above', percent: 99 }), is: (c) => c.kind === 'burden-above',
    params: [{ key: 'percent', label: 'Percent', type: 'number' }], get: (c) => ({ percent: (c as { percent: number }).percent + 1 }), set: (v) => ({ kind: 'burden-above', percent: Math.max(0, n(v.percent) - 1) }) },
  { id: 'routedist', label: 'Dist Any Route Pt >=', make: () => ({ kind: 'route-distance-at-least', meters: 20 }), is: (c) => c.kind === 'route-distance-at-least',
    params: [{ key: 'meters', label: 'Distance', type: 'number' }], get: (c) => ({ meters: (c as { meters: number }).meters }), set: (v) => ({ kind: 'route-distance-at-least', meters: n(v.meters, 20) }) },
  { id: 'expr', label: 'Expression', make: () => ({ kind: 'expression', expr: '' }), is: (c) => c.kind === 'expression',
    params: [{ key: 'expr', label: 'Expression', type: 'text' }], get: (c) => ({ expr: (c as { expr: string }).expr }), set: (v) => ({ kind: 'expression', expr: v.expr ?? '' }) },
  { id: 'capture', label: 'Chat Message Capture', make: () => ({ kind: 'chat-capture', pattern: '' }), is: (c) => c.kind === 'chat-capture',
    params: [{ key: 'pattern', label: 'Pattern (regex)', type: 'text' }, { key: 'colors', label: 'Color ids (;)', type: 'text' }],
    get: (c) => ({ pattern: (c as { pattern: string }).pattern, colors: ((c as { colors?: number[] }).colors ?? []).join(';') }),
    set: (v) => { const colors = (v.colors ?? '').split(';').map((x) => x.trim()).filter(Boolean).map(Number).filter((x) => Number.isFinite(x) && x >= 0); return { kind: 'chat-capture', pattern: v.pattern ?? '', ...(colors.length ? { colors } : {}) }; } },
];

const one = (a: RoutineAction[], kind: RoutineAction['kind']) => a.length === 1 && a[0].kind === kind;
/** How an imported Get VT Option reads (vtank.ts: setvar[variable,vtgetsetting[option]]). */
const GETOPT = /^setvar\[([^,\]]+),vtgetsetting\[([^\]]+)\]\]$/i;
/** VirindiTank's action list, mapped to our action lists (All = several in order). */
export const VT_ACTIONS: VtActDef[] = [
  { id: 'none', label: 'None', make: () => [], is: (a) => a.length === 0 },
  { id: 'state', label: 'Set Meta State', make: (p) => [{ kind: 'set-state', state: p.states[0]?.name ?? 'Default' }], is: (a) => one(a, 'set-state'),
    params: [{ key: 'state', label: 'State', type: 'state' }], get: (a) => ({ state: (a[0] as { state: string }).state }), set: (v) => [{ kind: 'set-state', state: v.state ?? '' }] },
  { id: 'chat', label: 'Chat Command', make: () => [{ kind: 'say', text: '' }], is: (a) => one(a, 'say'),
    params: [{ key: 'text', label: 'Command', type: 'text' }], get: (a) => ({ text: (a[0] as { text: string }).text }), set: (v, p) => vtankChatCommand(v.text ?? '', p.routes.map((r) => r.name)) },
  { id: 'all', label: 'All', make: () => [], is: (a) => a.length > 1 },
  { id: 'nav', label: 'Load Embedded Navroute', make: (p) => [{ kind: 'load-route', route: p.routes[0]?.name ?? '' }], is: (a) => one(a, 'load-route'),
    params: [{ key: 'route', label: 'Route', type: 'route' }], get: (a) => ({ route: (a[0] as { route: string }).route }), set: (v) => [{ kind: 'load-route', route: v.route ?? '' }] },
  { id: 'call', label: 'Call Meta State', make: (p) => [{ kind: 'call-state', state: p.states[0]?.name ?? 'Default', returnTo: p.states[0]?.name ?? 'Default' }], is: (a) => one(a, 'call-state'),
    params: [{ key: 'state', label: 'Call state', type: 'state' }, { key: 'returnTo', label: 'Return to', type: 'state' }],
    get: (a) => ({ state: (a[0] as { state: string }).state, returnTo: (a[0] as { returnTo: string }).returnTo }), set: (v) => [{ kind: 'call-state', state: v.state ?? '', returnTo: v.returnTo ?? '' }] },
  { id: 'return', label: 'Return From Call', make: () => [{ kind: 'return' }], is: (a) => one(a, 'return') },
  { id: 'expr', label: 'Expression Action', make: () => [{ kind: 'expression', expr: '' }], is: (a) => one(a, 'expression') && !/^chatbox\[/i.test((a[0] as { expr: string }).expr) && !GETOPT.test((a[0] as { expr: string }).expr),
    params: [{ key: 'expr', label: 'Expression', type: 'text' }], get: (a) => ({ expr: (a[0] as { expr: string }).expr }), set: (v) => [{ kind: 'expression', expr: v.expr ?? '' }] },
  { id: 'chatexpr', label: 'Chat Expression', make: () => [{ kind: 'expression', expr: 'chatbox[]' }], is: (a) => one(a, 'expression') && /^chatbox\[/i.test((a[0] as { expr: string }).expr),
    params: [{ key: 'expr', label: 'Expression', type: 'text' }], get: (a) => ({ expr: (a[0] as { expr: string }).expr.replace(/^chatbox\[([\s\S]*)\]$/i, '$1') }), set: (v) => [{ kind: 'expression', expr: `chatbox[${v.expr ?? ''}]` }] },
  { id: 'watchdog', label: 'Set Watchdog', make: (p) => [{ kind: 'set-watchdog', state: p.states[0]?.name ?? 'Default', meters: 5, seconds: 60 }], is: (a) => one(a, 'set-watchdog'),
    params: [{ key: 'state', label: 'State', type: 'state' }, { key: 'meters', label: 'Range', type: 'number' }, { key: 'seconds', label: 'Time (s)', type: 'number' }],
    get: (a) => { const x = a[0] as { state: string; meters: number; seconds: number }; return { state: x.state, meters: x.meters, seconds: x.seconds }; },
    set: (v) => [{ kind: 'set-watchdog', state: v.state ?? '', meters: n(v.meters, 5), seconds: Math.max(1, n(v.seconds, 60)) }] },
  { id: 'clearwd', label: 'Clear Watchdog', make: () => [{ kind: 'clear-watchdog' }], is: (a) => one(a, 'clear-watchdog') },
  { id: 'getopt', label: 'Get VT Option', make: () => [{ kind: 'expression', expr: 'setvar[range,vtgetsetting[AttackDistance]]' }],
    is: (a) => one(a, 'expression') && GETOPT.test((a[0] as { expr: string }).expr),
    params: [{ key: 'name', label: 'Option', type: 'text' }, { key: 'variable', label: 'Into variable', type: 'text' }],
    get: (a) => { const m = GETOPT.exec((a[0] as { expr: string }).expr)!; return { variable: m[1], name: m[2] }; },
    set: (v) => [{ kind: 'expression', expr: `setvar[${(v.variable ?? '').trim()},vtgetsetting[${(v.name ?? '').trim()}]]` }] },
  { id: 'setopt', label: 'Set VT Option', make: () => [{ kind: 'set-setting', name: 'EnableCombat', value: true }], is: (a) => one(a, 'set-setting'),
    params: [{ key: 'name', label: 'Option', type: 'text' }, { key: 'value', label: 'Value', type: 'text' }],
    get: (a) => { const x = a[0] as { name: string; value: string | number | boolean }; return { name: x.name, value: String(vtDisplayValue(x.name, x.value)) }; },
    set: (v) => { const name = vtOption(v.name ?? '')?.name ?? (v.name ?? ''); return [{ kind: 'set-setting', name, value: vtStoredValue(name, v.value ?? '') }]; } },
  { id: 'createview', label: 'Create View', make: () => [{ kind: 'create-view', name: 'View', xml: '<?xml version="1.0"?><view width="300" height="200" title="View"><control type="layout"></control></view>' }], is: (a) => one(a, 'create-view'),
    params: [{ key: 'name', label: 'View name', type: 'text' }, { key: 'xml', label: 'XML', type: 'text' }],
    get: (a) => ({ name: (a[0] as { name: string }).name, xml: (a[0] as { xml: string }).xml }), set: (v) => [{ kind: 'create-view', name: v.name ?? '', xml: v.xml ?? '' }] },
  { id: 'destroyview', label: 'Destroy View', make: () => [{ kind: 'destroy-view', name: 'View' }], is: (a) => one(a, 'destroy-view'),
    params: [{ key: 'name', label: 'View name', type: 'text' }], get: (a) => ({ name: (a[0] as { name: string }).name }), set: (v) => [{ kind: 'destroy-view', name: v.name ?? '' }] },
  { id: 'destroyall', label: 'Destroy All Views', make: () => [{ kind: 'destroy-all-views' }], is: (a) => one(a, 'destroy-all-views') },
];

export const vtCondDef = (c: RoutineCondition): VtCondDef | undefined => VT_CONDITIONS.find((d) => d.is(c));
export const vtActDef = (a: RoutineAction[]): VtActDef | undefined => VT_ACTIONS.find((d) => d.is(a));

/** A condition as VirindiTank's Meta list shows it: its name, then its values. */
export function vtConditionText(c: RoutineCondition): string {
  const d = vtCondDef(c);
  if (!d) return describeOther(c);
  if (c.kind === 'all' || c.kind === 'any') return c.conditions.length ? `${d.label}: ${c.conditions.map(vtConditionText).join(c.kind === 'all' ? ', ' : ' | ')}` : d.label;
  if (d.id === 'not' && c.kind === 'not') return `Not ${vtConditionText(c.condition)}`;
  const v = d.get?.(c);
  return v && Object.keys(v).length ? `${d.label} ${Object.values(v).join(', ')}` : d.label;
}
function describeOther(c: RoutineCondition): string {
  switch (c.kind) {
    case 'vital-below': return `${c.vital[0].toUpperCase()}${c.vital.slice(1)} below ${c.percent}%`;
    case 'vital-above': return `${c.vital[0].toUpperCase()}${c.vital.slice(1)} above ${c.percent}%`;
    case 'monster-within': return `Monsters within ${c.meters}`;
    case 'buff-missing': return `Buff not on: ${c.spell}`;
    case 'near': return `Near ${c.coords} (${c.meters})`;
    case 'unassigned-xp-above': return `Unassigned XP above ${c.xp}`;
    case 'unsupported': return `[can't run: ${c.what}]`;
    default: return c.kind;
  }
}

/** An action list as VirindiTank's Meta list shows it. */
export function vtActionText(a: RoutineAction[]): string {
  const d = vtActDef(a);
  if (d?.id === 'all') return `All: ${a.map((x) => vtActionText([x])).join('; ')}`;
  if (d) { const v = d.get?.(a); return v ? `${d.label}: ${d.id === 'setopt' ? `${v.name} = ${v.value}` : d.id === 'call' ? `${v.state} (return to ${v.returnTo})` : d.id === 'createview' ? v.name : Object.values(v).join(', ')}` : d.label; }
  const x = a[0];
  switch (x?.kind) {
    case 'cast': return `Cast: ${x.spell}`;
    case 'use-item': return `Use: ${x.item}`;
    case 'use-object': return `Use: ${x.name}`;
    case 'attack-nearest': return 'Attack nearest';
    case 'loot-nearby': return 'Loot';
    case 'walk-to': return `Walk to ${x.coords}`;
    case 'wait': return `Wait ${x.seconds} s`;
    case 'stop': return 'Stop';
    case 'load-loot': return `Load loot profile: ${x.set}`;
    case 'jump': return 'Jump';
    case 'train': return `Spend XP: ${x.plan.map((e) => `${e.stat} ${e.upTo}`).join(', ')}`;
    case 'cast-buffs': return `Cast buff set: ${x.set}`;
    case 'follow-route': return `Follow route: ${x.route}`;
    case 'sell-by-loot-rules': return x.vendor ? `Sell loot to: ${x.vendor}` : 'Sell loot';
    case 'give': return `Give: ${x.count ? `${x.count} ` : ''}${x.item} to ${x.to}`;
    case 'combat-mode': return `Combat mode: ${x.mode}`;
    case 'unsupported': return `[can't run: ${x.what}]`;
    default: return x?.kind ?? 'None';
  }
}

/** The Meta list: every rule, grouped by state as VirindiTank lists them (state name, case-insensitive), in rule order within a state. */
export function metaRows(p: RoutineProfile): Array<{ state: string; index: number; rule: RoutineRule; first: boolean; last: boolean }> {
  const states = [...p.states].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return states.flatMap((s) => s.rules.map((rule, index) => ({ state: s.name, index, rule, first: index === 0, last: index === s.rules.length - 1 })));
}

/** A rule's condition as one VirindiTank condition (several of ours are an All). */
export function ruleCondition(r: RoutineRule): RoutineCondition {
  return r.when.length === 1 ? r.when[0] : { kind: 'all', conditions: r.when };
}
export function setRuleCondition(r: RoutineRule, c: RoutineCondition): void {
  r.when = c.kind === 'all' ? (c.conditions.length ? c.conditions : [{ kind: 'always' }]) : [c];
}

// ── Route: one VirindiTank waypoint per point, with its step ──

export interface Waypoint { coords: string; step: RoutineAction[] | null }
export function routeWaypoints(r: Route): Waypoint[] {
  return r.points.map((coords, i) => ({ coords, step: r.stops?.find((s) => s.at === i)?.do ?? null }));
}
export function setRouteWaypoints(r: Route, wps: Waypoint[]): void {
  r.points = wps.map((w) => w.coords);
  const stops = wps.flatMap((w, i) => (w.step ? [{ at: i, do: w.step }] : []));
  if (stops.length) r.stops = stops; else delete r.stops;
}
export function waypointText(w: Waypoint): string {
  const s = w.step?.[0];
  if (!s) return `Point ${w.coords}`;
  switch (s.kind) {
    case 'cast': return `Recall: ${s.spell}`;
    case 'wait': return `Pause ${s.seconds} s`;
    case 'say': return `Chat: ${s.text}`;
    case 'use-object': return `Use: ${s.name}`;
    case 'talk-to': return `NPC Talk: ${s.name}`;
    case 'sell-by-loot-rules': return `Vendor: ${s.vendor}`;
    case 'jump': return 'Jump';
    default: return `${s.kind} (${w.coords})`;
  }
}
/** The recalls Add Recall offers (VirindiTank's list; ACE spell names). */
export const VT_RECALLS = ['Primary Portal Recall', 'Secondary Portal Recall', 'Lifestone Recall', 'Lifestone Sending', 'Portal Recall', 'Recall the Sanctuary', 'Recall Aphus Lassel', 'Recall to the Singularity Caul', 'Glenden Wood Recall', 'Aerlinthe Recall', 'Mount Lethe Recall', "Ulgrim's Recall", 'Bur Recall', 'Call of the Mhoire Forge', 'Colosseum Recall', 'Facility Hub Recall', 'Return to the Keep'];

// ── the window ──

export class VTankWindow {
  tab: VtTab = 'options';
  private doc: RoutineDoc | null = null;
  private profileName: string | null = null;
  message = '';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private routeName: string | null = null;
  private waypoint = -1;
  private insertMode: 'end' | 'above' | 'below' = 'end';
  private pauseSeconds = '5';
  private chatText = '/ls';
  private recall = VT_RECALLS[0];
  private advanced = false;
  /** The server-rules line has been printed (once per session). */
  private rulesNoted = false;
  /** The Meta rule being edited (state + index), or null. */
  private editing: { state: string; index: number } | null = null;

  constructor(private readonly kit: VTankKit, readonly source: VTankSource, private readonly dialogs: VTankDialogs) {}

  get document(): RoutineDoc | null { return this.doc; }

  /** The character the loaded document's selection was made for. */
  private loadedFor: string | null = null;
  private standbyTry = -Infinity;
  private standbyLoading = false;

  /**
   * VTank's M. Charges When Off runs with the macro off: the macro settings
   * profile this window has selected for the character in the world (the
   * engine's stand-by profile). Loads the account's document the first time
   * it's asked for a character (again every 30 s while that fails).
   */
  standbyProfile(): RoutineProfile | null {
    const ch = this.source.character();
    if (!ch) return null;
    if (this.loadedFor !== ch || !this.doc) {
      const t = this.source.now();
      if (!this.standbyLoading && t - this.standbyTry >= 30_000) {
        this.standbyTry = t;
        this.standbyLoading = true;
        void this.load(() => {}).finally(() => { this.standbyLoading = false; });
      }
      return null;
    }
    return this.profile();
  }

  async load(redraw: () => void): Promise<void> {
    this.message = 'Loading…';
    redraw();
    const r = await this.source.load();
    if (r.ok) {
      this.doc = r.doc as RoutineDoc;
      const ch = this.source.character();
      this.loadedFor = ch;
      this.standbyTry = -Infinity;
      this.profileName = this.source.status().profile ?? (ch ? this.doc.characters?.[ch] : undefined) ?? this.doc.profiles[0]?.name ?? null;
      this.message = '';
    } else this.message = r.message;
    redraw();
  }

  /** The macro settings profile shown (VirindiTank's "Macro Settings"). */
  profile(): RoutineProfile | null { return this.doc?.profiles.find((p) => p.name === this.profileName) ?? null; }
  private running(): boolean { const s = this.source.status(); return s.running && s.profile === this.profileName; }

  /** A profile to edit: the shown one, or a new "Default" one (VTank always has a profile). */
  private ensureProfile(): RoutineProfile {
    let p = this.profile();
    if (p) return p;
    if (!this.doc) throw new Error('not loaded');
    p = { ...newProfile('Default'), initialState: 'Default', states: [{ name: 'Default', rules: [] }], macro: true, ruleFiring: 'once', settings: {}, vtank: emptyVtankData() };
    p.modules = { buffs: true, vitals: true, combat: true, looting: true, navigation: true, inventory: true, service: false };
    this.doc.profiles.push(p);
    this.profileName = p.name;
    return p;
  }

  /** VirindiTank saves every change at once: apply it to the run, then save the account's document (debounced). */
  changed(redraw: () => void): void {
    const p = this.profile();
    if (p && this.running()) this.source.update(p);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.saveNow(redraw); }, 400);
    redraw();
  }

  async saveNow(redraw: () => void): Promise<boolean> {
    if (!this.doc) return false;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.doc.schemaVersion = ROUTINE_SCHEMA_VERSION;
    this.doc.updatedAt = new Date(this.source.now() > 1e12 ? this.source.now() : Date.now()).toISOString();
    const issues = validateRoutineDoc(this.doc);
    if (issues.length) { this.message = `Not saved: ${issues[0].path}: ${issues[0].message}`; redraw(); return false; }
    const r = await this.source.save(this.doc);
    // The store's own check (a bridge on an older build can refuse what this one allows): name the field.
    this.message = r.ok ? '' : r.issues?.length ? `${r.message} (${r.issues[0].path}: ${r.issues[0].message})` : r.message;
    redraw();
    return r.ok;
  }

  /** An option the engine acts on and the active era can use (Cast Dispel Self needs the era's self Life dispel). */
  private shown(o: VtOption): boolean {
    if (!o.engine || !this.optionShown(o.name)) return false;
    if (o.name === 'CastDispelSelf' || o.name === 'UseDispelItems') return dispelOptionsAvailable(this.source.spellTable?.() ?? null)[o.name];
    return true;
  }

  /** A setting's value now: the running macro's, else the profile's, else VirindiTank's default. */
  value(name: string): string | number | boolean {
    const o = vtOption(name);
    const key = o?.name ?? name;
    if (this.running()) { const v = this.source.setting(key); if (v !== undefined) return v; }
    const s = this.profile()?.settings?.[key];
    return s !== undefined ? s : (o?.default ?? '');
  }
  /** The era has Summoning (unknown counts as yes: the table isn't loaded yet). */
  hasSummoning(): boolean { return this.source.hasSkill?.('Summoning') !== false; }
  hasVoid(): boolean { return this.source.hasSkill?.('Void Magic') !== false; }
  /** An option the era can't use (Summon Pets without Summoning) is not drawn. */
  optionShown(name: string): boolean { return !VT_PET_OPTIONS.has(name) || this.hasSummoning(); }
  /** Dmg type's cycle in this era: Void needs Void Magic, Fists needs Tusker Fists (2934). */
  damageCycle(): number[] {
    return VT_DAMAGE_CYCLE.filter((v) => (v !== 9 || this.hasVoid()) && (v !== 13 || this.source.hasSpell?.(2934) !== false));
  }
  /** A profile the window's macro tabs edit runs VirindiTank's macro (its tabs' data and planners). */
  private macroProfile(): RoutineProfile {
    const p = this.ensureProfile();
    p.macro = true;
    p.vtank ??= emptyVtankData();
    return p;
  }

  setValue(name: string, v: string | number | boolean, redraw: () => void): void {
    const p = this.macroProfile();
    const key = vtOption(name)?.name ?? name;
    p.settings = { ...(p.settings ?? {}), [key]: v };
    if (this.running()) this.source.setSetting(key, v);
    this.changed(redraw);
  }

  render(body: HTMLElement, w: number, h: number, redraw: () => void): void {
    body.innerHTML = '';
    const { kit } = this;
    const root = el('div', { position: 'absolute', left: '0', top: '0', width: `${w}px`, height: `${h}px` }, { vtank: 'window' });
    body.appendChild(root);
    const tabs = row(9);
    at(tabs, 4, 0);
    for (const t of VT_TABS) {
      if (!VT_TAB_READY[t.id]) continue;
      tabs.appendChild(tag(kit.textTab(t.label, this.tab === t.id, () => { this.tab = t.id; this.advanced = false; redraw(); }), { vtankTab: t.id }));
    }
    root.appendChild(tabs);
    const area = el('div', { position: 'absolute', left: '0', top: '18px', width: `${w}px`, height: `${h - 18}px` });
    root.appendChild(area);
    if (!this.doc) { area.appendChild(at(kit.text(this.message || 'Loading…', { color: kit.colors.dim }), 8, 8)); return; }
    const ch = h - 18;
    if (this.advanced) this.renderAdvanced(area, w, ch, redraw);
    else if (this.tab === 'options') this.renderOptions(area, w, ch, redraw);
    else if (this.tab === 'profiles') this.renderProfiles(area, w, ch, redraw);
    else if (this.tab === 'route') this.renderRoute(area, w, ch, redraw);
    else if (this.tab === 'meta') this.renderMeta(area, w, ch, redraw);
    else if (this.tab === 'vitals') this.renderVitals(area, w, ch, redraw);
    else if (this.tab === 'monsters') this.renderMonsters(area, w, ch, redraw);
    else if (this.tab === 'items') this.renderItems(area, w, ch, redraw);
    else if (this.tab === 'consumables') this.renderConsumables(area, w, ch, redraw);
    else if (this.tab === 'buffs') this.renderBuffs(area, w, ch, redraw);
    if (this.message) root.appendChild(tag(at(kit.text(this.message, { color: kit.colors.warn, maxWidth: w - 16 }), 8, h - 16), { vtank: 'message' }));
  }

  // ── Options ──

  private check(label: string, on: boolean, onChange: (v: boolean) => void, data: Record<string, string>): HTMLElement {
    const r = row(5);
    r.appendChild(this.kit.check(on, onChange));
    r.appendChild(this.kit.text(label, { color: this.kit.colors.text }));
    return tag(r, { ...data, on: on ? '1' : '0' });
  }
  private optionCheck(o: VtOption, redraw: () => void): HTMLElement {
    // A two-value enum drawn as a switch (Custom Pet Range is PetRangeMode 0 / 1).
    if (o.kind === 'enum') return this.check(o.label ?? o.name, Number(this.value(o.name)) === 1, (v) => this.setValue(o.name, v ? 1 : 0, redraw), { vtankOption: o.name });
    return this.check(o.label ?? o.name, this.value(o.name) === true || this.value(o.name) === 'true', (v) => this.setValue(o.name, v, redraw), { vtankOption: o.name });
  }
  private optionField(o: VtOption, width: number, redraw: () => void): HTMLElement {
    return tag(this.kit.input(String(vtDisplayValue(o.name, this.value(o.name))), width, (v) => {
      const p = this.macroProfile();
      p.settings = { ...(p.settings ?? {}), [o.name]: vtStoredValue(o.name, v) };
      if (this.running()) this.source.setSetting(o.name, vtStoredValue(o.name, v));
      this.changed(() => {});
    }), { vtankOption: o.name });
  }

  private renderOptions(area: HTMLElement, _w: number, h: number, redraw: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    // Where each control sits on VirindiTank's Options tab (Vtank_Main.PNG, its y less the tab strip's 48 px).
    for (const L of VT_OPTIONS_LAYOUT) {
      const o = vtOption(L.name);
      if (!o || !this.shown(o)) continue;
      if (L.kind === 'range') {
        area.appendChild(at(kit.text(o.label ?? o.name, { color: c.text }), L.x, L.y));
        area.appendChild(at(this.optionField(o, 40, redraw), L.x, L.y + 14));
      } else if (L.kind === 'check') area.appendChild(at(this.optionCheck(o, redraw), L.x, L.y));
      else if (L.kind === 'box') area.appendChild(at(this.optionField(o, 40, redraw), L.x, L.y));
      else {
        const r = row(6);
        r.appendChild(kit.text(o.label ?? o.name, { color: c.text }));
        r.appendChild(this.optionField(o, 40, redraw));
        area.appendChild(at(r, L.x, L.y));
      }
    }
    // Force Buff / Cancel Force Buff (left of the switches, Vtank_Main.PNG).
    const say = (r: { ok: boolean; message: string }) => { this.message = r.ok ? '' : r.message; redraw(); };
    area.appendChild(at(tag(kit.flatButton('Force Buff', () => say(this.running() ? this.source.forceBuff() : { ok: false, message: 'Turn Run Macro on to buff.' }), 110, 22), { vtank: 'force-buff' }), 97, 2));
    area.appendChild(at(tag(kit.flatButton('Cancel Force Buff', () => say(this.source.cancelForceBuff()), 110, 22), { vtank: 'cancel-force-buff' }), 97, 34));
    // Advanced Options and Run Macro, bottom right.
    area.appendChild(at(this.check('Advanced Options', false, () => { this.advanced = true; redraw(); }, { vtank: 'advanced' }), 620, Math.min(129, h - 44)));
    const st = this.source.status();
    const on = this.running() && !st.paused;
    area.appendChild(at(this.check('Run Macro', on, (v) => this.runMacro(v, redraw), { vtank: 'run-macro' }), 620, Math.min(149, h - 24)));
  }

  /** Run Macro: on starts the profile (or resumes it); off pauses it, as VirindiTank's switch does. */
  runMacro(on: boolean, redraw: () => void): void {
    const st = this.source.status();
    let r: { ok: boolean; message: string };
    if (on) r = this.running() && st.paused ? this.source.resume() : st.running && st.profile !== this.profileName ? { ok: false, message: `"${st.profile}" is running` } : this.source.run(this.ensureProfile());
    else r = this.running() ? this.source.pause() : { ok: true, message: '' };
    // The first start this session: the window is open to every player on public servers, whose own rules decide macroing.
    if (on && r.ok && !this.rulesNoted) { this.rulesNoted = true; this.source.report(VT_SERVER_RULES_NOTE); }
    this.message = r.ok ? '' : r.message;
    redraw();
  }

  /** Advanced Options: every option the engine acts on, by VirindiTank's name, grouped as its list. */
  private renderAdvanced(area: HTMLElement, w: number, h: number, redraw: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    const head = row(10);
    head.appendChild(kit.text('Advanced Options', { color: c.gold }));
    head.appendChild(tag(kit.flatButton('Close', () => { this.advanced = false; redraw(); }, 60), { vtank: 'advanced-close' }));
    area.appendChild(at(head, 8, 2));
    const box = el('div', { position: 'absolute', left: '8px', top: '24px', width: `${w - 16}px`, height: `${h - 30}px` }, { vtank: 'advanced-list' });
    const list = el('div', { display: 'flex', flexDirection: 'column', gap: '2px', paddingRight: '20px' });
    let group = '';
    for (const o of VT_OPTIONS.filter((x) => this.shown(x))) {
      if (o.group !== group) { group = o.group; list.appendChild(kit.text(group, { color: c.gold })); }
      const r = row(8);
      tag(r, { vtankAdvanced: o.name });
      const name = el('div', { width: '230px', flexShrink: '0' });
      name.appendChild(kit.text(o.name, { color: c.text }));
      r.appendChild(name);
      if (o.kind === 'bool') r.appendChild(kit.check(this.value(o.name) === true || this.value(o.name) === 'true', (v) => this.setValue(o.name, v, redraw)));
      else r.appendChild(this.optionField(o, 80, redraw));
      if (o.help) r.appendChild(kit.text(o.help, { color: c.dim, maxWidth: w - 380 }));
      list.appendChild(r);
    }
    box.appendChild(list);
    area.appendChild(box);
    kit.list(box);
  }

  // ── Profiles ──

  private renderProfiles(area: HTMLElement, w: number, _h: number, redraw: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    const doc = this.doc!;
    const p = this.profile();
    const ch = this.source.character();
    const label = (t: string, y: number) => area.appendChild(at(kit.text(t, { color: c.text }), 26, y));
    // Macro Settings: which profile; CopyTo makes a copy under a new name.
    label('Macro Settings', 6);
    area.appendChild(at(tag(kit.dropdown(p?.name ?? '[None]', (a) => kit.menu(a, doc.profiles.map((x) => ({ label: x.name, value: x.name })), (v) => {
      if (this.source.status().running) { this.message = 'Turn Run Macro off (and stop) before changing profiles.'; redraw(); return; }
      this.profileName = v; this.routeName = null; redraw();
    }), 130), { vtank: 'macro-profile' }), 146, 4));
    area.appendChild(at(tag(kit.flatButton('CopyTo', () => {
      const base = this.ensureProfile();
      let i = 2;
      while (doc.profiles.some((x) => x.name === `${base.name} ${i}`)) i++;
      const copy = { ...structuredClone(base), name: `${base.name} ${i}` };
      doc.profiles.push(copy);
      this.profileName = copy.name;
      this.changed(redraw);
    }, 40), { vtank: 'copy-profile' }), 285, 4));
    // Enable Auto-Navigation: the route the macro walks.
    const nav = this.value('EnableNav') === true;
    area.appendChild(at(this.check('Enable Auto-Navigation', nav, (v) => this.setValue('EnableNav', v, redraw), { vtankOption: 'EnableNav' }), 10, 30));
    area.appendChild(at(tag(kit.dropdown(p?.navRoute ?? '[None]', (a) => kit.menu(a, [{ label: '[None]', value: '' }, ...(p?.routes ?? []).map((r) => ({ label: r.name, value: r.name }))], (v) => {
      const q = this.ensureProfile();
      if (v) q.navRoute = v; else delete q.navRoute;
      this.changed(redraw);
    }), 130), { vtank: 'nav-profile' }), 146, 28));
    area.appendChild(at(tag(kit.flatButton('New', () => {
      const q = this.ensureProfile();
      let i = 1;
      while (q.routes.some((r) => r.name === `Route ${i}`)) i++;
      q.routes.push({ name: `Route ${i}`, mode: 'circular', points: [] });
      q.navRoute = `Route ${i}`;
      this.routeName = q.navRoute;
      this.changed(redraw);
    }, 40), { vtank: 'new-route' }), 285, 28));
    // Enable Looting: which loot profile (an imported VTClassic file, or this profile's own rules).
    const loot = this.value('EnableLooting') === true;
    area.appendChild(at(this.check('Enable Looting', loot, (v) => this.setValue('EnableLooting', v, redraw), { vtankOption: 'EnableLooting' }), 10, 54));
    const sets = Object.keys(p?.lootSets ?? {});
    area.appendChild(at(tag(kit.dropdown(p?.lootSet ?? (p?.loot.length ? '[This profile]' : '[None]'), (a) => kit.menu(a, [{ label: '[This profile]', value: '' }, ...sets.map((s) => ({ label: s, value: s }))], (v) => {
      const q = this.ensureProfile();
      if (v) q.lootSet = v; else delete q.lootSet;
      this.changed(redraw);
    }), 130), { vtank: 'loot-profile' }), 146, 52));
    // Enable Meta Actions: the profile's rules run.
    const meta = this.value('EnableMeta') === true;
    area.appendChild(at(this.check('Enable Meta Actions', meta, (v) => this.setValue('EnableMeta', v, redraw), { vtankOption: 'EnableMeta' }), 10, 78));
    // Clear profile!: back to VirindiTank's defaults. Clear nav profile!: an empty route.
    area.appendChild(at(tag(kit.flatButton('Clear profile!', () => { const q = this.ensureProfile(); q.settings = {}; if (this.running()) for (const o of VT_OPTIONS) this.source.setSetting(o.name, o.default); this.changed(redraw); }, 98), { vtank: 'clear-profile' }), 336, 4));
    area.appendChild(at(tag(kit.flatButton('Clear nav profile!', () => {
      const q = this.ensureProfile();
      const r = q.routes.find((x) => x.name === q.navRoute);
      if (r) { r.points = []; delete r.stops; this.changed(redraw); }
    }, 98), { vtank: 'clear-nav' }), 336, 28));
    // Mine only: this character starts with this profile.
    if (ch && p) {
      const mine = doc.characters?.[ch] === p.name;
      area.appendChild(at(this.check('Mine only', mine, (v) => {
        doc.characters = { ...(doc.characters ?? {}) };
        if (v) doc.characters[ch] = p.name; else delete doc.characters[ch];
        this.changed(redraw);
      }, { vtank: 'mine-only' }), 446, 6));
    }
    void w;
  }

  // ── Route ──

  private route(): Route | null {
    const p = this.profile();
    if (!p) return null;
    const name = this.routeName ?? p.navRoute ?? p.routes[0]?.name ?? null;
    return p.routes.find((r) => r.name === name) ?? null;
  }
  private ensureRoute(): Route {
    const r = this.route();
    if (r) return r;
    const p = this.ensureProfile();
    const nr: Route = { name: 'Route 1', mode: 'circular', points: [] };
    let i = 1;
    while (p.routes.some((x) => x.name === nr.name)) nr.name = `Route ${++i}`;
    p.routes.push(nr);
    p.navRoute ??= nr.name;
    this.routeName = nr.name;
    return nr;
  }

  /** Add a waypoint where the insert menu says (Add to End / Insert Above / Insert Below the selected one). */
  addWaypoint(wp: Waypoint, redraw: () => void): void {
    const r = this.ensureRoute();
    const wps = routeWaypoints(r);
    const sel = this.waypoint;
    const i = this.insertMode === 'end' || sel < 0 ? wps.length : this.insertMode === 'above' ? sel : sel + 1;
    wps.splice(i, 0, wp);
    setRouteWaypoints(r, wps);
    this.waypoint = i;
    this.changed(redraw);
  }

  private renderRoute(area: HTMLElement, w: number, h: number, redraw: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    const r = this.route();
    const p = this.profile();
    area.appendChild(at(kit.text('Navigation Waypoints', { color: c.text }), 120, 2));
    if (p && p.routes.length > 1) {
      area.appendChild(at(tag(kit.dropdown(r?.name ?? '', (a) => kit.menu(a, p.routes.map((x) => ({ label: x.name, value: x.name })), (v) => { this.routeName = v; this.waypoint = -1; redraw(); }), 120), { vtank: 'route-pick' }), 230, 0));
    }
    const listH = h - 44;
    const box = el('div', { position: 'absolute', left: '0', top: '18px', width: '370px', height: `${listH}px` }, { vtank: 'waypoints' });
    const list = el('div', { display: 'flex', flexDirection: 'column', paddingRight: '18px' });
    const here = this.source.status().running ? null : null;
    void here;
    const st = this.source.status();
    const current = this.running() && st.nav && r && st.nav.route === r.name && !st.nav.done ? st.nav.point : -1;
    if (r?.mode === 'follow') {
      // Out of sight, the macro stands still until the leader is back; the line says so.
      const lost = this.running() && st.follow && st.follow.target === r.follow && !st.follow.inSight;
      list.appendChild(tag(kit.text(r.follow ? `Following: ${r.follow}${lost ? ' (out of sight: standing still)' : ''}` : 'Follow: select a player or creature and press Add', { color: lost ? c.bad : c.text }), { vtankFollow: r.follow ?? '', ...(lost ? { lost: '1' } : {}) }));
    } else (r ? routeWaypoints(r) : []).forEach((wp, i) => {
      const line = kit.row(i === this.waypoint, () => { this.waypoint = i; redraw(); });
      tag(line, { vtankWaypoint: String(i), ...(i === current ? { current: '1' } : {}) });
      // The point the macro walks to next shows in the "good" colour (VTank marks the current waypoint).
      line.appendChild(kit.text(`${i + 1}. ${waypointText(wp)}`, { color: i === current ? c.good : c.text }));
      list.appendChild(line);
    });
    box.appendChild(list);
    area.appendChild(box);
    kit.list(box);
    // Bottom: route type, insert mode, and the waypoint arrows.
    const by = h - 22;
    const modes: Array<{ v: Route['mode']; l: string }> = [{ v: 'circular', l: 'Circular' }, { v: 'linear', l: 'Linear' }, { v: 'follow', l: 'Follow' }, { v: 'once', l: 'Once' }];
    area.appendChild(at(tag(kit.dropdown(modes.find((m) => m.v === (r?.mode ?? 'circular'))!.l, (a) => kit.menu(a, modes.map((m) => ({ label: m.l, value: m.v })), (v) => { this.ensureRoute().mode = v as Route['mode']; this.changed(redraw); }), 90), { vtank: 'route-mode' }), 4, by));
    const ins = { end: 'Add to End', above: 'Insert Above', below: 'Insert Below' } as const;
    area.appendChild(at(tag(kit.dropdown(ins[this.insertMode], (a) => kit.menu(a, (Object.keys(ins) as Array<keyof typeof ins>).map((k) => ({ label: ins[k], value: k })), (v) => { this.insertMode = v as keyof typeof ins; redraw(); }), 120), { vtank: 'insert-mode' }), 200, by));
    const move = (d: -1 | 1) => {
      const rr = this.route();
      if (!rr || this.waypoint < 0) return;
      const wps = routeWaypoints(rr);
      const j = this.waypoint + d;
      if (j < 0 || j >= wps.length) return;
      [wps[this.waypoint], wps[j]] = [wps[j], wps[this.waypoint]];
      setRouteWaypoints(rr, wps);
      this.waypoint = j;
      this.changed(redraw);
    };
    area.appendChild(at(tag(kit.icon(VT_ICON.down, 15, () => move(1)), { vtank: 'wp-down' }), 326, by + 2));
    area.appendChild(at(tag(kit.icon(VT_ICON.up, 15, () => move(-1)), { vtank: 'wp-up' }), 343, by + 2));
    area.appendChild(at(tag(kit.icon(VT_ICON.remove, 15, () => {
      const rr = this.route();
      if (!rr || this.waypoint < 0) return;
      const wps = routeWaypoints(rr);
      wps.splice(this.waypoint, 1);
      setRouteWaypoints(rr, wps);
      this.waypoint = Math.min(this.waypoint, wps.length - 1);
      this.changed(redraw);
    }), { vtank: 'wp-remove' }), 360, by + 2));
    // The curly arrow (VTank: circular routes only): the running macro walks next to the waypoint nearest you.
    // On other route types it does nothing in VTank, so it isn't drawn.
    if ((r?.mode ?? 'circular') === 'circular') area.appendChild(at(tag(kit.icon(VT_ICON.current, 15, () => {
      if (!this.running()) { this.message = 'Turn Run Macro on first.'; redraw(); return; }
      const res = this.source.setNearestWaypoint();
      this.message = res.ok ? '' : res.message;
      redraw();
    }), { vtank: 'wp-current' }), 377, by + 2));
    // Right: the add buttons.
    const bx = 380;
    const here2 = () => this.source.coords();
    const needHere = (f: (coords: string) => void) => { const h2 = here2(); if (!h2) { this.message = 'Your position is not known yet.'; redraw(); return; } f(h2); };
    area.appendChild(at(tag(kit.flatButton('Add', () => {
      // In Follow mode, Add sets the follow target to the selection (a player or a creature), as VirindiTank's does.
      if (r?.mode === 'follow') {
        const s = this.source.selection();
        if (!s || !FOLLOW_KINDS.has(s.kind)) { this.message = 'Select the player or creature to follow first.'; redraw(); return; }
        r.follow = s.name;
        this.changed(redraw);
        return;
      }
      needHere((co) => this.addWaypoint({ coords: co, step: null }, redraw));
    }, 86), { vtank: 'add-point' }), bx, 18));
    area.appendChild(at(tag(kit.flatButton('Open Vendor', () => needHere((co) => {
      const s = this.source.selection();
      if (!s) { this.message = 'Select the vendor first.'; redraw(); return; }
      this.addWaypoint({ coords: co, step: [{ kind: 'use-object', name: s.name }, { kind: 'sell-by-loot-rules', vendor: s.name }] }, redraw);
    }), 86), { vtank: 'add-vendor' }), bx + 94, 18));
    area.appendChild(at(tag(kit.flatButton('Add Portal/NPC', () => needHere((co) => {
      const s = this.source.selection();
      if (!s) { this.message = 'Select the portal or NPC first.'; redraw(); return; }
      this.addWaypoint({ coords: co, step: [{ kind: 'use-object', name: s.name }] }, redraw);
    }), 86), { vtank: 'add-portal' }), bx, 40));
    area.appendChild(at(tag(kit.flatButton('Add NPC Talk', () => needHere((co) => {
      const s = this.source.selection();
      if (!s || (s.kind !== 'npc' && s.kind !== 'vendor')) { this.message = 'Select the NPC first.'; redraw(); return; }
      this.addWaypoint({ coords: co, step: [{ kind: 'talk-to', name: s.name }] }, redraw);
    }), 86), { vtank: 'add-npc-talk' }), bx + 94, 40));
    area.appendChild(at(tag(kit.flatButton('Add Recall', () => needHere((co) => this.addWaypoint({ coords: co, step: [{ kind: 'cast', spell: this.recall, target: 'self' }] }, redraw)), 86), { vtank: 'add-recall' }), bx, 62));
    area.appendChild(at(tag(kit.dropdown(this.recall, (a) => kit.menu(a, VT_RECALLS.map((x) => ({ label: x, value: x })), (v) => { this.recall = v; redraw(); }), 210), { vtank: 'recall' }), bx + 94, 62));
    area.appendChild(at(tag(kit.flatButton('Add Pause', () => needHere((co) => this.addWaypoint({ coords: co, step: [{ kind: 'wait', seconds: Math.max(0, Number(this.pauseSeconds) || 0) }] }, redraw)), 86), { vtank: 'add-pause' }), bx, 84));
    area.appendChild(at(tag(kit.input(this.pauseSeconds, 66, (v) => { this.pauseSeconds = v; }), { vtank: 'pause-seconds' }), bx + 94, 84));
    area.appendChild(at(kit.text('seconds', { color: c.text }), bx + 166, 86));
    area.appendChild(at(tag(kit.flatButton('Add Chat', () => needHere((co) => this.addWaypoint({ coords: co, step: [{ kind: 'say', text: this.chatText }] }, redraw)), 86), { vtank: 'add-chat' }), bx, 106));
    area.appendChild(at(tag(kit.input(this.chatText, 120, (v) => { this.chatText = v; }), { vtank: 'chat-text' }), bx + 94, 106));
    void w;
  }

  // ── Vitals ──

  private renderVitals(area: HTMLElement, _w: number, _h: number, redraw: () => void): void {
    const { kit } = this;
    // Three groups of sliders (Vtank_vitals.PNG): in combat, top-off with no target, helping others;
    // 17 px rows and a 4 px gap between groups, as there.
    let group = 0;
    let row2 = 0;
    VT_VITALS_LAYOUT.forEach((name) => {
      if (!name) { group++; return; }
      const o = vtOption(name)!;
      const y = row2++ * 17 + group * 4 + 2;
      const v = Math.max(0, Math.min(100, Number(this.value(name)) || 0));
      area.appendChild(at(kit.text(o.label ?? name, { color: kit.colors.text }), 6, y));
      area.appendChild(at(tag(kit.slider(v, 0, 100, 145, (nv) => this.setValue(name, nv, redraw)), { vtankOption: name }), 94, y + 2));
      area.appendChild(at(tag(kit.text(`${v}%`, { color: kit.colors.dim }), { vtankValue: name }), 246, y));
    });
  }

  // ── the tab data (Monsters, Items, Consumables, Buffs) ──

  private data(): VtankProfileData { return this.macroProfile().vtank!; }
  private dataView(): VtankProfileData { return this.profile()?.vtank ?? emptyVtankData(); }

  /** A list box with a header, rows of names and a delete icon per row. */
  private nameList(area: HTMLElement, x: number, y: number, w: number, h: number, title: string, names: string[], onRemove: (i: number) => void, key: string, extra?: (i: number) => HTMLElement | null): void {
    const { kit } = this;
    area.appendChild(at(kit.text(title, { color: kit.colors.text }), x + 22, y));
    const box = el('div', { position: 'absolute', left: `${x}px`, top: `${y + 16}px`, width: `${w}px`, height: `${h}px` }, { vtankList: key });
    const list = el('div', { display: 'flex', flexDirection: 'column', paddingRight: '18px' });
    names.forEach((nm, i) => {
      const line = el('div', { position: 'relative', height: '18px' }, { vtankRow: `${key}#${i}` });
      line.appendChild(at(kit.text(nm, { color: kit.colors.text }), 2, 2));
      const ex = extra?.(i);
      if (ex) line.appendChild(at(ex, w - 110, 2));
      line.appendChild(at(tag(kit.icon(VT_ICON.remove, 14, () => onRemove(i)), { vtankRemove: '1' }), w - 36, 2));
      list.appendChild(line);
    });
    box.appendChild(list);
    area.appendChild(box);
    kit.list(box);
  }

  /** The selected item you carry, or a message why not. */
  private selectedItem(redraw: () => void): string | null {
    const s = this.source.selection();
    if (!s || s.kind !== 'item') { this.message = 'Select an item in your inventory first.'; redraw(); return null; }
    return s.name;
  }

  // ── Monsters ──

  private renderMonsters(area: HTMLElement, w: number, h: number, redraw: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    const rows = this.dataView().monsters;
    // The header (Vtank_monsters.PNG): attack columns in red, debuffs in white.
    // The void columns and PetDmg are drawn only where the era has Void Magic / Summoning (its SkillTable).
    const colShown = (col: string) => !VT_VOID_COLUMNS.has(col) || this.hasVoid();
    const pets = this.hasSummoning();
    VT_MONSTER_COLUMNS.forEach((col, i) => { if (colShown(col)) area.appendChild(at(tag(kit.text(col, { color: VT_ATTACK_COLUMNS.has(col) ? c.bad : c.text }), { vtankColumn: col }), 6 + i * 19, 0)); });
    const head: Array<[string, number]> = [['Name', 300], ['P', 412], ['Dmg type', 432], ['Ex. Vuln', 500], ['Weapon', 566], ['Offhand', 646], ...(pets ? [['PetDmg', 712] as [string, number]] : [])];
    for (const [t, x] of head) area.appendChild(at(kit.text(t, { color: c.text }), x, 0));
    const box = el('div', { position: 'absolute', left: '0', top: '16px', width: `${w}px`, height: `${h - 44}px` }, { vtankList: 'monsters' });
    const list = el('div', { display: 'flex', flexDirection: 'column', paddingRight: '18px' });
    const items = ['<AUTO>', ...this.dataView().items.map((x) => x.name)];
    rows.forEach((r, i) => {
      const line = el('div', { position: 'relative', height: '18px' }, { vtankMonster: String(i) });
      const edit = (f: (row: VtMonsterRow) => void) => { f(this.data().monsters[i]); this.changed(redraw); };
      VT_MONSTER_COLUMNS.forEach((col, ci) => colShown(col) && line.appendChild(at(tag(kit.check(r.on.includes(col), (v) => edit((row) => { row.on = v ? [...row.on, col].filter((x, k, a) => a.indexOf(x) === k) : row.on.filter((x) => x !== col); })), { vtankCell: col }), 4 + ci * 19, 2)));
      line.appendChild(at(kit.text(r.name === '<DEFAULT>' ? '<< DEFAULT >>' : r.name, { color: c.text, maxWidth: 108 }), 300, 2));
      const cycle = (key: string, x: number, label: string, next: () => void) => {
        const t = tag(kit.text(label, { color: c.text }), { vtankCycle: key });
        t.style.cursor = 'pointer';
        t.addEventListener('click', (e) => { e.stopPropagation(); next(); });
        line.appendChild(at(t, x, 2));
      };
      cycle('priority', 414, String(r.priority), () => edit((row) => { row.priority = row.priority >= 4 ? -1 : row.priority + 1; }));
      cycle('damage', 436, vtDamageName(r.damage), () => edit((row) => { row.damage = nextIn(this.damageCycle(), row.damage); }));
      cycle('exVuln', 504, vtDamageName(r.exVuln), () => edit((row) => { row.exVuln = nextIn(VT_EXVULN_CYCLE, row.exVuln); }));
      cycle('weapon', 570, r.weapon ?? '<AUTO>', () => edit((row) => { const j = items.indexOf(row.weapon ?? '<AUTO>'); const nx = items[(j + 1) % items.length]; row.weapon = nx === '<AUTO>' ? null : nx; }));
      cycle('offhand', 650, r.offhand ?? '<AUTO>', () => edit((row) => { const j = items.indexOf(row.offhand ?? '<AUTO>'); const nx = items[(j + 1) % items.length]; row.offhand = nx === '<AUTO>' ? null : nx; }));
      // PetDmg: which essence's element Summon Pets uses for this monster (combatPlan planPet).
      if (pets) cycle('petDamage', 716, vtPetDamageName(r.petDamage), () => edit((row) => { row.petDamage = nextIn(VT_PET_CYCLE, row.petDamage); }));
      if (i > 0) line.appendChild(at(tag(kit.icon(VT_ICON.remove, 14, () => { this.data().monsters.splice(i, 1); this.changed(redraw); }), { vtankRemove: '1' }), w - 22, 2));
      list.appendChild(line);
    });
    box.appendChild(list);
    area.appendChild(box);
    kit.list(box);
    // Under the list: a name box, Add (that name) and Add Sel (the selected monster).
    const by = h - 22;
    let typed = '';
    area.appendChild(at(tag(kit.input('', 385, (v) => { typed = v; }), { vtank: 'monster-name' }), 10, by));
    const add = (name: string) => { const d = this.data(); d.monsters.push({ ...structuredClone(VT_DEFAULT_MONSTER), name }); this.changed(redraw); };
    area.appendChild(at(tag(kit.flatButton('Add', () => { const t = typed.trim(); if (t) add(t); }, 60), { vtank: 'add-monster' }), 404, by));
    area.appendChild(at(tag(kit.flatButton('Add Sel', () => {
      const s2 = this.source.selection();
      if (!s2 || s2.kind !== 'monster') { this.message = 'Select a monster first.'; redraw(); return; }
      add(s2.name);
    }, 60), { vtank: 'add-selected-monster' }), 470, by));
  }

  // ── Items ──

  private renderItems(area: HTMLElement, w: number, h: number, redraw: () => void): void {
    const { kit } = this;
    const d = this.dataView();
    this.nameList(area, 4, 0, Math.min(430, w - 8), h - 44, this.hasSummoning() ? 'Weapons / Wands / Shields / Pets' : 'Weapons / Wands / Shields', d.items.map((x) => x.name), (i) => { this.data().items.splice(i, 1); this.changed(redraw); }, 'items',
      (i) => (d.items[i].noBuffs ? kit.text('(no buffs)', { color: kit.colors.dim }) : null));
    const by = h - 22;
    const add = (noBuffs: boolean) => { const n = this.selectedItem(redraw); if (!n) return; const dd = this.data(); if (!dd.items.some((x) => x.name === n)) dd.items.push(noBuffs ? { name: n, noBuffs: true } : { name: n }); this.changed(redraw); };
    area.appendChild(at(tag(kit.flatButton('Add', () => add(false), 140), { vtank: 'add-item' }), 14, by));
    area.appendChild(at(tag(kit.flatButton('Add (no buffs)', () => add(true), 140), { vtank: 'add-item-nobuffs' }), 174, by));
  }

  // ── Consumables ──

  private renderConsumables(area: HTMLElement, w: number, h: number, redraw: () => void): void {
    const { kit } = this;
    const d = this.dataView();
    const half = Math.floor((w - 12) / 2);
    this.nameList(area, 4, 0, half - 10, h - 44, 'Gems / Food / Kits / Potions / Charges / Grenades / Lockpicks', d.consumables, (i) => { this.data().consumables.splice(i, 1); this.changed(redraw); }, 'consumables');
    this.nameList(area, half + 8, 0, half - 10, h - 44, 'Excluded Scarab Types:', d.excludedScarabs, (i) => { this.data().excludedScarabs.splice(i, 1); this.changed(redraw); }, 'scarabs');
    const by = h - 22;
    // Add, and beside it Add All Peas (Vtank_consumables.PNG): every pea you carry, so SplitPeas keeps its component supplied.
    const peasW = Math.min(70, Math.floor((half - 10) / 3));
    area.appendChild(at(tag(kit.flatButton('Add', () => { const n = this.selectedItem(redraw); if (!n) return; const dd = this.data(); if (!dd.consumables.includes(n)) dd.consumables.push(n); this.changed(redraw); }, half - 15 - peasW), { vtank: 'add-consumable' }), 4, by));
    area.appendChild(at(tag(kit.flatButton('Add All Peas', () => {
      const add = addAllPeas(this.data().consumables, this.source.items());
      if (!add.length) { this.message = 'You carry no peas.'; redraw(); return; }
      this.data().consumables.push(...add);
      this.changed(redraw);
    }, peasW), { vtank: 'add-peas' }), half - 6 - peasW, by));

    area.appendChild(at(tag(kit.flatButton('Add Selected', () => { const n = this.selectedItem(redraw); if (!n) return; const dd = this.data(); if (!dd.excludedScarabs.includes(n)) dd.excludedScarabs.push(n); this.changed(redraw); }, half - 10), { vtank: 'add-scarab' }), half + 8, by));
  }

  // ── Buffs ──

  private renderBuffs(area: HTMLElement, w: number, h: number, redraw: () => void): void {
    const { kit } = this;
    const d = this.dataView();
    const half = Math.floor((w - 12) / 2);
    this.nameList(area, 4, 0, half - 10, h - 44, 'Extra Buff Spells (best similar will be used)', d.extraBuffs, (i) => { this.data().extraBuffs.splice(i, 1); this.changed(redraw); }, 'extra-buffs');
    this.nameList(area, half + 8, 0, half - 10, h - 44, 'Blacklisted Buff Families', d.blacklistedBuffs, (i) => { this.data().blacklistedBuffs.splice(i, 1); this.changed(redraw); }, 'blacklisted-buffs');
    const by = h - 22;
    // Add…: a spell you know, from a searchable menu.
    const pickSpell = (anchor: HTMLElement, into: 'extraBuffs' | 'blacklistedBuffs') => kit.menu(anchor, this.source.spells().map((sp) => ({ label: sp.name, value: sp.name, hint: sp.school })), (v) => {
      const dd = this.data();
      if (!dd[into].includes(v)) dd[into].push(v);
      this.changed(redraw);
    }, { search: true, width: 280 });
    let a1: HTMLElement | null = null;
    a1 = tag(kit.flatButton('Add...', () => pickSpell(a1!, 'extraBuffs'), 140), { vtank: 'add-extra-buff' });
    area.appendChild(at(a1, 14, by));
    let a2: HTMLElement | null = null;
    a2 = tag(kit.flatButton('Add...', () => pickSpell(a2!, 'blacklistedBuffs'), 140), { vtank: 'add-blacklisted-buff' });
    area.appendChild(at(a2, half + 18, by));
  }

  // ── Meta ──

  private renderMeta(area: HTMLElement, w: number, h: number, redraw: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    const p = this.profile();
    const st: RoutineStatus = this.source.status();
    const spent = new Set(this.running() ? st.spent ?? [] : []);
    const box = el('div', { position: 'absolute', left: '0', top: '2px', width: `${w}px`, height: `${h - 30}px` }, { vtank: 'meta-list' });
    const list = el('div', { display: 'flex', flexDirection: 'column', paddingRight: '18px' });
    for (const r of p ? metaRows(p) : []) {
      const line = el('div', { position: 'relative', height: '18px', cursor: 'pointer' }, { vtankRule: `${r.state}#${r.index}` });
      const ran = spent.has(`${r.state}#${r.index}`);
      const color = ran ? c.bad : r.rule.disabled ? c.dim : c.text;
      const moveIn = (d: -1 | 1) => {
        const s = p!.states.find((x) => x.name === r.state)!;
        const j = r.index + d;
        [s.rules[r.index], s.rules[j]] = [s.rules[j], s.rules[r.index]];
        this.changed(redraw);
      };
      if (!r.first) line.appendChild(at(tag(kit.icon(VT_ICON.up, 14, () => moveIn(-1)), { vtankRuleUp: '1' }), 6, 2));
      if (!r.last) line.appendChild(at(tag(kit.icon(VT_ICON.down, 14, () => moveIn(1)), { vtankRuleDown: '1' }), 26, 2));
      line.appendChild(at(tag(kit.icon(VT_ICON.remove, 14, () => {
        p!.states.find((x) => x.name === r.state)!.rules.splice(r.index, 1);
        this.changed(redraw);
      }), { vtankRuleRemove: '1' }), 46, 2));
      // One line per rule, each column clipped at the next (VTank's list never wraps).
      const cell = (text: string, x: number, width: number) => {
        const box2 = el('div', { position: 'absolute', left: `${x}px`, top: '2px', width: `${width}px`, height: '16px', overflow: 'hidden', whiteSpace: 'nowrap' });
        box2.appendChild(kit.text(text, { color }));
        line.appendChild(box2);
      };
      cell(r.state, 70, 152);
      cell(vtConditionText(ruleCondition(r.rule)), 230, 268);
      cell(vtActionText(r.rule.do), 505, Math.max(60, w - 525));
      line.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('[data-vtank-rule-up],[data-vtank-rule-down],[data-vtank-rule-remove]')) return;
        this.editRule(r.state, r.index, redraw);
      });
      list.appendChild(line);
    }
    box.appendChild(list);
    area.appendChild(box);
    kit.list(box);
    const by = h - 24;
    area.appendChild(at(kit.text('Current State:', { color: c.text }), 8, by + 2));
    const cur = this.running() ? st.state ?? '' : p?.initialState ?? 'Default';
    area.appendChild(at(tag(kit.dropdown(cur, (a) => kit.menu(a, (p?.states ?? []).map((s) => ({ label: s.name, value: s.name })), (v) => {
      if (this.running()) { const r = this.source.setState(v); this.message = r.ok ? '' : r.message; redraw(); return; }
      this.ensureProfile().initialState = v;
      this.changed(redraw);
    }), 120), { vtank: 'current-state' }), 140, by));
    area.appendChild(at(tag(kit.flatButton('Create', () => {
      const q = this.ensureProfile();
      const stName = this.running() ? st.state ?? q.initialState : q.initialState;
      const s = q.states.find((x) => x.name === stName) ?? q.states[0];
      s.rules.push({ label: `Rule ${s.rules.length + 1}`, when: [{ kind: 'not', condition: { kind: 'always' } }], do: [] });
      this.changed(redraw);
      this.editRule(s.name, s.rules.length - 1, redraw);
    }, 50), { vtank: 'create-rule' }), 468, by));
  }

  /** Edit Meta Rule (Vtguide-meta.png): condition and its state on the left, the action on the right, Close. */
  editRule(state: string, index: number, redraw: () => void): void {
    this.editing = { state, index };
    this.dialogs.open('Edit Meta Rule', 630, 458, (body, dredraw, close) => this.renderRuleEditor(body, dredraw, () => { this.editing = null; close(); redraw(); }, redraw));
  }

  get editingRule(): { state: string; index: number } | null { return this.editing; }

  private renderRuleEditor(body: HTMLElement, dredraw: () => void, close: () => void, redraw: () => void): void {
    body.innerHTML = '';
    const { kit } = this;
    const c = kit.colors;
    const p = this.profile();
    const ed = this.editing;
    const s = p?.states.find((x) => x.name === ed?.state);
    const rule = s?.rules[ed?.index ?? -1];
    if (!p || !s || !rule || !ed) { close(); return; }
    const root = el('div', { position: 'absolute', left: '0', top: '0', width: '622px', height: '430px' }, { vtank: 'rule-editor' });
    body.appendChild(root);
    const both = () => { this.changed(redraw); dredraw(); };
    const cond = ruleCondition(rule);
    // Condition type (top left) and the rule's state with New State….
    root.appendChild(at(tag(kit.dropdown(vtCondDef(cond)?.label ?? vtConditionText(cond), (a) => kit.menu(a, VT_CONDITIONS.map((d) => ({ label: d.label, value: d.id })), (v) => {
      const d = VT_CONDITIONS.find((x) => x.id === v)!;
      setRuleCondition(rule, d.make());
      both();
    }, { search: true, width: 260 }), 300), { vtank: 'rule-condition' }), 4, 4));
    root.appendChild(at(tag(kit.dropdown(s.name, (a) => kit.menu(a, p.states.map((x) => ({ label: x.name, value: x.name })), (v) => {
      if (v === s.name) return;
      s.rules.splice(ed.index, 1);
      const to = p.states.find((x) => x.name === v)!;
      to.rules.push(rule);
      this.editing = { state: v, index: to.rules.length - 1 };
      both();
    }), 150), { vtank: 'rule-state' }), 4, 24));
    root.appendChild(at(tag(kit.flatButton('New State...', () => {
      let i = 1;
      while (p.states.some((x) => x.name === `State ${i}`)) i++;
      p.states.push({ name: `State ${i}`, rules: [] });
      s.rules.splice(ed.index, 1);
      p.states.at(-1)!.rules.push(rule);
      this.editing = { state: `State ${i}`, index: 0 };
      both();
    }, 136), { vtank: 'new-state' }), 160, 22));
    // State name (renaming follows it everywhere it's named).
    root.appendChild(at(kit.text('State name', { color: c.dim }), 4, 48));
    root.appendChild(at(tag(kit.input(s.name, 150, (v) => {
      const nv = v.trim();
      if (!nv || p.states.some((x) => x !== s && x.name === nv)) return;
      renameState(p, s.name, nv);
      this.editing = { state: nv, index: ed.index };
      this.changed(redraw);
    }), { vtank: 'state-name' }), 80, 46));
    // The condition's values (left pane).
    const left = el('div', { position: 'absolute', left: '4px', top: '72px', width: '300px', height: '326px' }, { vtank: 'condition-pane' });
    root.appendChild(left);
    this.conditionPane(left, p, cond, (nc) => { setRuleCondition(rule, nc); both(); });
    // Action (top right) and its values.
    const act = vtActDef(rule.do);
    root.appendChild(at(tag(kit.dropdown(act?.label ?? vtActionText(rule.do), (a) => kit.menu(a, VT_ACTIONS.map((d) => ({ label: d.label, value: d.id })), (v) => {
      const d = VT_ACTIONS.find((x) => x.id === v)!;
      rule.do = d.id === 'all' ? (rule.do.length ? [...rule.do] : []) : d.make(p);
      if (d.id === 'all' && rule.do.length < 2) rule.do = [...rule.do, ...(rule.do.length ? [] : [{ kind: 'set-state', state: s.name } as RoutineAction]), { kind: 'say', text: '' }];
      both();
    }, { width: 240 }), 300), { vtank: 'rule-action' }), 312, 4));
    const right = el('div', { position: 'absolute', left: '312px', top: '30px', width: '306px', height: '368px' }, { vtank: 'action-pane' });
    root.appendChild(right);
    this.actionPane(right, p, rule, both);
    root.appendChild(at(tag(kit.flatButton('Close', close, 62), { vtank: 'rule-close' }), 4, 408));
  }

  private params(host: HTMLElement, p: RoutineProfile, values: Record<string, string | number>, defs: Param[], commit: (v: Record<string, string>) => void): void {
    const { kit } = this;
    const cur: Record<string, string> = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]));
    defs.forEach((d, i) => {
      host.appendChild(at(kit.text(d.label, { color: kit.colors.dim }), 0, i * 24 + 2));
      if (d.type === 'state' || d.type === 'route') {
        const names = d.type === 'state' ? p.states.map((s) => s.name) : p.routes.map((r) => r.name);
        host.appendChild(at(tag(kit.dropdown(cur[d.key] || '[None]', (a) => kit.menu(a, names.map((x) => ({ label: x, value: x })), (v) => { cur[d.key] = v; commit(cur); }), 170), { vtankParam: d.key }), 110, i * 24));
      } else {
        host.appendChild(at(tag(kit.input(cur[d.key] ?? '', 180, (v) => { cur[d.key] = v; commit(cur); }), { vtankParam: d.key }), 110, i * 24));
      }
    });
  }

  private conditionPane(host: HTMLElement, p: RoutineProfile, cond: RoutineCondition, set: (c: RoutineCondition) => void): void {
    const { kit } = this;
    const d = vtCondDef(cond);
    if (cond.kind === 'all' || cond.kind === 'any' || (d?.id === 'not' && cond.kind === 'not')) {
      // A list of conditions (Not holds one), each picked from the same menu; Add… appends one.
      const subs = cond.kind === 'not' ? [cond.condition] : cond.conditions;
      const put = (xs: RoutineCondition[]) => set(cond.kind === 'not' ? { kind: 'not', condition: xs[0] ?? { kind: 'always' } } : { kind: cond.kind, conditions: xs });
      subs.forEach((sc, i) => {
        const line = row(4);
        tag(line, { vtankSubCondition: String(i) });
        line.appendChild(kit.dropdown(vtConditionText(sc), (a) => kit.menu(a, VT_CONDITIONS.filter((x) => x.id !== 'all' && x.id !== 'any' && x.id !== 'not').map((x) => ({ label: x.label, value: x.id })), (v) => {
          const next = [...subs]; next[i] = VT_CONDITIONS.find((x) => x.id === v)!.make(); put(next);
        }, { search: true, width: 260 }), 240));
        if (cond.kind !== 'not') line.appendChild(kit.icon(VT_ICON.remove, 14, () => { const next = [...subs]; next.splice(i, 1); put(next); }));
        host.appendChild(at(line, 0, i * 22));
        const sd = vtCondDef(sc);
        if (sd?.params && sd.get && sd.set) {
          // A sub-condition's values: one compact line under it.
          const vals = row(4);
          for (const prm of sd.params) vals.appendChild(tag(kit.input(String(sd.get(sc)[prm.key] ?? ''), 70, (v) => { const cur = Object.fromEntries(Object.entries(sd.get!(sc)).map(([k, x]) => [k, String(x)])); cur[prm.key] = v; const next = [...subs]; next[i] = sd.set!(cur); put(next); }), { vtankParam: prm.key }));
          host.appendChild(at(vals, 16, i * 22 + 18));
        }
      });
      if (cond.kind !== 'not') host.appendChild(at(tag(kit.flatButton('Add...', () => put([...subs, { kind: 'always' }]), 100), { vtank: 'add-condition' }), 0, Math.max(0, subs.length) * 44 + 4));
      return;
    }
    if (d?.params && d.get && d.set) this.params(host, p, d.get(cond), d.params, (v) => set(d.set!(v)));
  }

  private actionPane(host: HTMLElement, p: RoutineProfile, rule: RoutineRule, both: () => void): void {
    const { kit } = this;
    const d = vtActDef(rule.do);
    if (d?.id === 'all') {
      rule.do.forEach((a, i) => {
        const line = row(4);
        tag(line, { vtankSubAction: String(i) });
        line.appendChild(kit.dropdown(vtActionText([a]), (anchor) => kit.menu(anchor, VT_ACTIONS.filter((x) => x.id !== 'all' && x.id !== 'none').map((x) => ({ label: x.label, value: x.id })), (v) => {
          const made = VT_ACTIONS.find((x) => x.id === v)!.make(p);
          rule.do.splice(i, 1, ...made);
          both();
        }, { width: 240 }), 250));
        line.appendChild(kit.icon(VT_ICON.remove, 14, () => { rule.do.splice(i, 1); both(); }));
        host.appendChild(at(line, 0, i * 44));
        const sd = vtActDef([a]);
        if (sd?.params && sd.get && sd.set) {
          const vals = row(4);
          for (const prm of sd.params) vals.appendChild(tag(kit.input(String(sd.get([a])[prm.key] ?? ''), 90, (v) => {
            const cur = Object.fromEntries(Object.entries(sd.get!([rule.do[i]])).map(([k, x]) => [k, String(x)]));
            cur[prm.key] = v;
            rule.do.splice(i, 1, ...sd.set!(cur, p));
            this.changed(() => {});
          }), { vtankParam: prm.key }));
          host.appendChild(at(vals, 16, i * 44 + 20));
        }
      });
      host.appendChild(at(tag(kit.flatButton('Add...', () => { rule.do.push({ kind: 'say', text: '' }); both(); }, 100), { vtank: 'add-action' }), 0, rule.do.length * 44 + 4));
      return;
    }
    if (d?.params && d.get && d.set) this.params(host, p, d.get(rule.do), d.params, (v) => { rule.do = d.set!(v, p); this.changed(() => {}); });
  }

  menuItems(items: string[]): MenuItem[] { return items.map((x) => ({ label: x, value: x })); }

  /**
   * VirindiTank's /vt commands (Virindi_Tank_Commands on its wiki), typed in
   * chat or run by a meta's Chat Command: the profile, option and action
   * commands a player uses. Each answer is a line for chat.
   */
  async command(line: string): Promise<string[]> {
    if (!this.doc) await this.load(() => {});
    const doc = this.doc;
    if (!doc) return [this.message || 'Your routines have not loaded.'];
    const args = line.trim().replace(/^\/(vt|vtank)\s*/i, '').split(/\s+/).filter(Boolean);
    const [cmd = '', ...rest] = args;
    const tail = line.trim().replace(/^\/(vt|vtank)\s+\S+\s*/i, '');
    const done = (r: { ok: boolean; message: string }) => [r.message];
    const saved = async (text: string) => { this.changed(() => {}); await this.saveNow(() => {}); return [text]; };
    const byName = (n: string) => doc.profiles.find((p) => p.name.toLowerCase() === n.toLowerCase());
    switch (cmd.toLowerCase()) {
      case 'start': this.runMacro(true, () => {}); return [this.message || 'macro on'];
      case 'stop': this.runMacro(false, () => {}); return [this.message || 'macro off'];
      case 'forcebuff': return done(this.source.forceBuff());
      case 'cancelforcebuff': return done(this.source.cancelForceBuff());
      case 'setmetastate': return done(this.source.setState(tail));
      case 'fakedeath': return done(this.source.fakeDeath());
      case 'reverseroute': return done(this.source.reverseRoute());
      case 'mexec': try { return [this.source.mexec(tail)]; } catch (e) { return [`expression failed: ${(e as Error).message}`]; }
      case 'echo': return [tail];
      case 'jump': {
        const [h, shift, ms] = rest;
        return done(this.source.jump({ ...(h !== undefined ? { heading: Number(h) } : {}), ...(shift !== undefined ? { walk: /^true$/i.test(shift) } : {}), ...(ms !== undefined ? { holdMs: Number(ms) } : {}) }));
      }
      case 'opt': {
        const [sub = 'list', name = '', ...v] = rest;
        const o = vtOption(name);
        if (sub.toLowerCase() === 'list') return [VT_OPTIONS.filter((x) => this.shown(x)).map((x) => `${x.name}=${String(this.value(x.name))}`).join(', ')];
        if (!o) return [`no option "${name}"`];
        if (sub.toLowerCase() === 'get') return [`${o.name} = ${String(vtToVTank(o.name, this.value(o.name)))}`];
        if (sub.toLowerCase() === 'set' || sub.toLowerCase() === 'setinall') {
          // VTank's own units here (ranges ÷ 240), as /vt opt set takes them.
          const val = vtFromVTank(o.name, v.join(' '));
          if (sub.toLowerCase() === 'setinall') for (const p of doc.profiles) p.settings = { ...(p.settings ?? {}), [o.name]: val };
          this.setValue(o.name, val, () => {});
          await this.saveNow(() => {});
          return [`${o.name} = ${String(vtToVTank(o.name, val))}`];
        }
        return [`/vt opt list | get <option> | set <option> <value> | setinall <option> <value>`];
      }
      case 'settings': {
        const [sub = '', ...nm] = rest;
        const name = nm.join(' ');
        if (/^load(char)?$/i.test(sub)) {
          const p = byName(name);
          if (!p) return [`no settings profile "${name}"`];
          if (this.source.status().running) return ['turn the macro off (/vt stop) and stop it before loading a profile'];
          this.profileName = p.name;
          if (/char/i.test(sub)) { const ch = this.source.character(); if (ch) doc.characters = { ...(doc.characters ?? {}), [ch]: p.name }; }
          return saved(`settings "${p.name}" loaded`);
        }
        if (/^save(char)?$/i.test(sub) && name) {
          const base = this.ensureProfile();
          const copy = { ...structuredClone(base), name };
          doc.profiles = [...doc.profiles.filter((p) => p.name !== name), copy];
          this.profileName = name;
          if (/char/i.test(sub)) { const ch = this.source.character(); if (ch) doc.characters = { ...(doc.characters ?? {}), [ch]: name }; }
          return saved(`settings saved as "${name}"`);
        }
        return ['/vt settings load|save|loadchar|savechar <name>'];
      }
      case 'nav': {
        const [sub = '', ...nm] = rest;
        const name = nm.join(' ');
        const p = this.ensureProfile();
        if (/^load$/i.test(sub)) {
          const r = p.routes.find((x) => x.name.toLowerCase() === name.toLowerCase());
          if (!r) return [`no route "${name}" in "${p.name}"`];
          p.navRoute = r.name;
          this.routeName = r.name;
          if (this.running()) this.source.update(p);
          return saved(`nav "${r.name}" loaded`);
        }
        if (/^save$/i.test(sub) && name) {
          const r = this.route();
          p.routes = [...p.routes.filter((x) => x.name !== name), { ...(r ? structuredClone(r) : { mode: 'circular' as const, points: [] }), name }];
          p.navRoute = name;
          this.routeName = name;
          return saved(`nav saved as "${name}"`);
        }
        return ['/vt nav load|save <name>'];
      }
      case 'loot': {
        const [sub = '', ...nm] = rest;
        const name = nm.join(' ').replace(/\.utl$/i, '');
        const p = this.ensureProfile();
        if (/^load$/i.test(sub)) {
          if (!p.lootSets?.[name]) return [`no loot profile "${name}" (import its .utl first)`];
          p.lootSet = name;
          return saved(`loot "${name}" loaded`);
        }
        return ['/vt loot load <name>'];
      }
      case 'meta': {
        const [sub = '', ...nm] = rest;
        const name = nm.join(' ').replace(/\.met$/i, '');
        const p = this.ensureProfile();
        // Meta profiles are a profile's states: load copies another profile's, save makes a profile of these.
        if (/^load$/i.test(sub)) {
          const from = byName(name);
          if (!from) return [`no meta "${name}"`];
          p.states = structuredClone(from.states);
          p.initialState = from.initialState;
          p.ruleFiring = from.ruleFiring;
          for (const r of from.routes) if (!p.routes.some((x) => x.name === r.name)) p.routes.push(structuredClone(r));
          if (this.running()) this.source.update(p);
          return saved(`meta "${from.name}" loaded`);
        }
        if (/^save$/i.test(sub) && name) {
          const existing = byName(name);
          const copy: RoutineProfile = existing ?? { ...newProfile(name), states: [], initialState: p.initialState };
          copy.states = structuredClone(p.states);
          copy.initialState = p.initialState;
          if (!existing) doc.profiles.push(copy);
          return saved(`meta saved as "${name}"`);
        }
        return ['/vt meta load|save <name>'];
      }
      case 'addnavpt': case 'addnavcheckpoint': {
        const coords = cmd.toLowerCase() === 'addnavpt' && tail ? tail : this.source.coords();
        if (!coords) return ['your position is not known yet'];
        const r = this.ensureRoute();
        setRouteWaypoints(r, [...routeWaypoints(r), { coords, step: null }]);
        return saved(`point ${r.points.length} added to "${r.name}"`);
      }
      case 'testmonster': {
        const sel = this.source.selection();
        if (!sel || sel.kind !== 'monster') return ['select a monster first'];
        const row = matchMonsterRow(this.dataView().monsters, { guid: 0, name: sel.name, dist: 0, relBearing: 0 }, { settings: this.profile()?.settings ?? {} });
        return [`${sel.name}: row ${row.name === '<DEFAULT>' ? '<< DEFAULT >>' : row.name}, priority ${row.priority}, ${row.on.join(' ') || 'no columns'}`];
      }
      case 'listmonstervariables': return ['true, false, name, typeid, species, maxhp, range, hasshield, metastate, setting_<option>'];
      default: return [`unknown command /vt ${cmd} (start, stop, forcebuff, cancelforcebuff, setmetastate, opt, settings, nav, loot, meta, addnavpt, addnavcheckpoint, reverseroute, mexec, echo, jump, fakedeath, testmonster)`];
    }
  }
}

/** Rename a state everywhere it is named (its rules' Set / Call / Watchdog targets and where the profile starts). */
export function renameState(p: RoutineProfile, from: string, to: string): void {
  for (const st of p.states) {
    if (st.name === from) st.name = to;
    for (const r of st.rules) for (const a of r.do) {
      if ((a.kind === 'set-state' || a.kind === 'set-watchdog') && a.state === from) a.state = to;
      if (a.kind === 'call-state') { if (a.state === from) a.state = to; if (a.returnTo === from) a.returnTo = to; }
    }
  }
  if (p.initialState === from) p.initialState = to;
}
