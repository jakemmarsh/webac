/**
 * AGENT.automation-panel / AGENT.automation-ui-mocks — the first-party
 * Decal/VirindiTank replacement's player surface, laid out as the mocks in
 * docs/mockups/automation (docs/automation-and-plugins.md §7):
 *
 * - The panel (panels-window slot): Automation / Stats tabs; a Profile
 *   dropdown; a status box (dot, "Running: Hunt", what it is doing); Run or
 *   Pause|Resume, Stop, Edit…; module rows (switch, name, one-line summary,
 *   › to that module's settings). Stats: this session's numbers.
 * - The editor (a floating window): profile dropdown, Import from
 *   VirindiTank…, Export, Save. Routine: a States column (running dot, rule
 *   counts, + New state, where it starts, shared settings) and the chosen
 *   state's rules as sentences — When [subject ▾] … and … Do [action ▾] …
 *   then … — the subject picked from a categorized, searchable menu, a ⋯
 *   menu per rule, "acting now" on the live rule, and a live strip (state
 *   and time in it, the acting rule, the last change, History, Step one
 *   rule). Loot: the ordered rules with action badges, the chosen rule's
 *   requirements (subject / operator / value), and Try it on an item you
 *   carry. Buffs: sets and their spells with time left. Routes: points,
 *   "Add where I stand".
 *
 * Retail had no automation UI (GAP.47), so nothing here has a LayoutDesc of
 * its own: it is composed from retail parts GameUI supplies through
 * AutomationKit (the options page's tabs, the EoL blue and maroon buttons,
 * UIElement_Menu fields and popups, list rows, edit fields, bullets, the
 * retail scrollbar, the dialog plate, AC-font text). The mock's Combat and
 * Service pages are not drawn until the routine document has data for them
 * (no dead-end UI). Everything acts through AutomationSource.
 */
import {
  ALL_MODULES_OFF, PropertyDataId, PropertyFloat, PropertyInt, PropertyString, ROUTINE_SCHEMA_VERSION, SkillId, emptyRoutineDoc, explainProfile, importVTankFiles, validateRoutineDoc, type VtNames,
  type BuffSet, type LootAction, type LootMatch, type LootRule, type Route, type RoutineAction, type RoutineCondition,
  type RoutineDoc, type RoutineProfile, type RoutineRule, type RoutineState,
} from '@ac/shared';
import type { RoutineStats, RoutineStatus } from '../../agent/RoutineEngine.js';

export interface MenuItem { label: string; value: string; hint?: string; group?: string }

/** Retail parts the panel is drawn from (GameUI implements it; tests fake it). */
export interface AutomationKit {
  text(text: string, opts?: { color?: string; maxWidth?: number }): HTMLElement;
  /** The EoL blue 3-slice button (0x21000040:0x10000618), or the maroon one (0x100002cd) for 'red'. In flow, 32 px tall. */
  button(label: string, onClick: () => void, opts?: { variant?: 'blue' | 'red'; width?: number }): HTMLElement;
  /** An options-page tab (0x2100004d:0x1000043a), open or closed. */
  tab(label: string, on: boolean, onClick: () => void): HTMLElement;
  /** A bullet switch (0x06004d17 on / 0x06004d15 off). */
  check(on: boolean, onChange: (on: boolean) => void): HTMLElement;
  /** A UIElement_Menu field showing `text`; a click hands the field to onClick (to open a menu under it). */
  field(text: string, onClick: (anchor: HTMLElement) => void, width?: number): HTMLElement;
  /** A menu under `anchor`; with groups, a category column; with search, a filter field. */
  menu(anchor: HTMLElement, items: MenuItem[], onPick: (value: string) => void, opts?: { search?: boolean; groups?: string[]; width?: number }): void;
  input(value: string, width: number, onChange: (value: string) => void): HTMLElement;
  /** A list row (selected or not), a flex container. */
  row(selected: boolean, onClick?: () => void): HTMLElement;
  /** A recessed box (the panel body scrim). */
  box(): HTMLElement;
  header(text: string): HTMLElement;
  dot(lit: boolean): HTMLElement;
  separator(): HTMLElement;
  scroll(host: HTMLElement): void;
  plate(w: number, h: number): HTMLDivElement;
  colors: { text: string; dim: string; gold: string; good: string; warn: string; bad: string };
}

type Result = { ok: boolean; message: string };
type Loaded = { ok: true; doc: unknown; account?: string; server?: string } | { ok: false; message: string; issues?: Array<{ path: string; message: string }> };

/** What the panel drives. */
export interface AutomationSource {
  load(): Promise<Loaded>;
  save(doc: RoutineDoc): Promise<Loaded>;
  status(): RoutineStatus;
  stats(): RoutineStats;
  current(): RoutineProfile | null;
  run(profile: RoutineProfile): Result;
  pause(): Result;
  resume(): Result;
  stop(): Result;
  setModule(module: ModuleKey, on: boolean): Result;
  resetStats(): void;
  /** One step of the paused routine. */
  step(): Result;
  /** The run's log, oldest first. */
  history(): string[];
  report(text: string): void;
  character(): string | null;
  coords(): string | null;
  /** What you carry (for loot rules' Try it). */
  items(): Array<{ name: string; type?: string; value?: number; burden?: number }>;
  /** Spells you know (for buff sets). */
  spells(): Array<{ name: string; school: string }>;
  /** Your active enchantments, seconds left. */
  buffs(): Array<{ name: string; remaining: number }>;
  now(): number;
}

export type ModuleKey = keyof RoutineProfile['modules'];

/** The panel's modules (Service is not built yet, so it isn't offered: no dead-end UI). */
export const MODULES: Array<{ key: ModuleKey; name: string; tab: EditorTab }> = [
  { key: 'buffs', name: 'Buffs', tab: 'buffs' }, { key: 'vitals', name: 'Vitals', tab: 'routine' }, { key: 'combat', name: 'Combat', tab: 'combat' },
  { key: 'looting', name: 'Looting', tab: 'loot' }, { key: 'navigation', name: 'Navigation', tab: 'routes' }, { key: 'inventory', name: 'Inventory', tab: 'loot' },
];

/** "/automation" (or "@automation"; "/automation panel" for the docked panel): handled before the retail command table. */
export function isAutomationCommand(line: string): boolean {
  return /^[/@]automation(\s+panel)?\s*$/i.test(line.trim());
}

/** One-line summary of what a module does in this profile. */
export function moduleSummary(p: RoutineProfile, key: ModuleKey): string {
  const actions = p.states.flatMap((s) => s.rules.filter((r) => !r.disabled).flatMap((r) => r.do));
  const count = (kinds: string[]) => actions.filter((a) => kinds.includes(a.kind)).length;
  switch (key) {
    case 'buffs': return p.buffSets.length ? p.buffSets.map((b) => `${b.name} (${b.spells.length})`).join(', ') : 'No buff sets';
    case 'vitals': {
      const lows = p.states.flatMap((s) => s.rules).filter((r) => !r.disabled).flatMap((r) => r.when).filter((c): c is Extract<RoutineCondition, { kind: 'vital-below' }> => c.kind === 'vital-below');
      return lows.length ? lows.map((c) => `${c.vital} under ${c.percent}%`).join(' · ') : 'No vital rules';
    }
    case 'combat': {
      const atk = actions.filter((a): a is Extract<RoutineAction, { kind: 'attack-nearest' }> => a.kind === 'attack-nearest');
      return atk.length ? `Fight ${atk[0].names?.length ? atk[0].names.join('/') : 'monsters'}${atk[0].meters ? ` within ${atk[0].meters} m` : ''}` : 'No fighting rules';
    }
    case 'looting': return p.loot.length ? `${p.loot.length} loot rule${p.loot.length > 1 ? 's' : ''}${count(['loot-nearby']) ? '' : ' (no rule loots)'}` : 'No loot rules';
    case 'navigation': return p.routes.length ? p.routes.map((r) => `${r.name} (${r.mode}, ${r.points.length} points)`).join(', ') : 'No routes';
    case 'inventory': return count(['sell-by-loot-rules']) ? 'Sells what the loot rules mark "sell"' : 'No selling rules';
    case 'service': return 'Not built yet';
  }
}

// ── sentences ──

type Part = string | { key: string; type: 'number' | 'text' | 'names' | 'plan' | 'state' | 'buffSet' | 'route' | 'target' | 'vitalOp' | 'readonly'; width?: number };

interface CondDef { id: string; label: string; group: string; hint?: string; make: () => RoutineCondition; is: (c: RoutineCondition) => boolean; parts: Part[] }
interface ActDef { id: string; label: string; group: string; hint?: string; make: (p: RoutineProfile) => RoutineAction; is: (a: RoutineAction) => boolean; parts: Part[] }

export const CONDITION_GROUPS = ['Character', 'Vitals', 'Buffs', 'Inventory', 'Nearby', 'Location', 'Routine', 'Chat'];
export const ACTION_GROUPS = ['Routine', 'Combat', 'Loot', 'Magic', 'Items', 'Movement', 'Chat', 'Character'];

const vital = (v: 'health' | 'stamina' | 'mana'): CondDef => ({
  id: `vital-${v}`, label: v[0].toUpperCase() + v.slice(1), group: 'Vitals', hint: 'percent',
  make: () => ({ kind: 'vital-below', vital: v, percent: 50 }),
  is: (c) => (c.kind === 'vital-below' || c.kind === 'vital-above') && c.vital === v,
  parts: [{ key: 'op', type: 'vitalOp' }, { key: 'percent', type: 'number', width: 40 }, '%'],
});

export const CONDITIONS: CondDef[] = [
  { id: 'xp', label: 'Unassigned XP', group: 'Character', hint: 'amount', make: () => ({ kind: 'unassigned-xp-above', xp: 5000 }), is: (c) => c.kind === 'unassigned-xp-above', parts: ['above', { key: 'xp', type: 'number', width: 60 }] },
  vital('health'), vital('stamina'), vital('mana'),
  { id: 'buff', label: 'Buff not on', group: 'Buffs', hint: 'spell', make: () => ({ kind: 'buff-missing', spell: '' }), is: (c) => c.kind === 'buff-missing', parts: [{ key: 'spell', type: 'text', width: 150 }] },
  { id: 'slots', label: 'Free pack slots', group: 'Inventory', hint: 'number', make: () => ({ kind: 'free-slots-below', slots: 5 }), is: (c) => c.kind === 'free-slots-below', parts: ['below', { key: 'slots', type: 'number', width: 40 }] },
  { id: 'count', label: 'Item count', group: 'Inventory', hint: 'by name', make: () => ({ kind: 'item-count-below', item: '', count: 1 }), is: (c) => c.kind === 'item-count-below', parts: ['of', { key: 'item', type: 'text', width: 120 }, 'below', { key: 'count', type: 'number', width: 40 }] },
  { id: 'burden', label: 'Burden', group: 'Inventory', hint: 'percent', make: () => ({ kind: 'burden-above', percent: 100 }), is: (c) => c.kind === 'burden-above', parts: ['above', { key: 'percent', type: 'number', width: 40 }, '%'] },
  { id: 'mon', label: 'Monsters within', group: 'Nearby', hint: 'distance', make: () => ({ kind: 'monster-within', meters: 30 }), is: (c) => c.kind === 'monster-within', parts: [{ key: 'meters', type: 'number', width: 40 }, 'm, named', { key: 'names', type: 'names', width: 110 }] },
  { id: 'nomon', label: 'No monsters within', group: 'Nearby', hint: 'distance', make: () => ({ kind: 'no-monster-within', meters: 30 }), is: (c) => c.kind === 'no-monster-within', parts: [{ key: 'meters', type: 'number', width: 40 }, 'm'] },
  { id: 'near', label: 'Near', group: 'Location', hint: 'map coordinates', make: () => ({ kind: 'near', coords: '', meters: 10 }), is: (c) => c.kind === 'near', parts: [{ key: 'coords', type: 'text', width: 120 }, 'within', { key: 'meters', type: 'number', width: 40 }, 'm'] },
  { id: 'always', label: 'Always', group: 'Routine', make: () => ({ kind: 'always' }), is: (c) => c.kind === 'always', parts: [] },
  { id: 'time', label: 'Time in this state', group: 'Routine', hint: 'seconds', make: () => ({ kind: 'seconds-in-state', seconds: 60 }), is: (c) => c.kind === 'seconds-in-state', parts: ['at least', { key: 'seconds', type: 'number', width: 40 }, 's'] },
  { id: 'chat', label: 'Chat says', group: 'Chat', hint: 'pattern', make: () => ({ kind: 'chat-matches', pattern: '' }), is: (c) => c.kind === 'chat-matches', parts: [{ key: 'pattern', type: 'text', width: 150 }] },
  { id: 'died', label: 'You died', group: 'Character', make: () => ({ kind: 'died' }), is: (c) => c.kind === 'died', parts: [] },
  { id: 'spell-time', label: 'Spell time left', group: 'Buffs', hint: 'seconds', make: () => ({ kind: 'spell-time-at-least', spell: '', seconds: 60 }), is: (c) => c.kind === 'spell-time-at-least', parts: [{ key: 'spell', type: 'text', width: 140 }, 'at least', { key: 'seconds', type: 'number', width: 50 }, 's'] },
  { id: 'need-buff', label: 'Need to buff', group: 'Buffs', make: () => ({ kind: 'need-buff' }), is: (c) => c.kind === 'need-buff', parts: [] },
  { id: 'vendor-open', label: 'Vendor window open', group: 'Inventory', make: () => ({ kind: 'vendor-open' }), is: (c) => c.kind === 'vendor-open', parts: [] },
  { id: 'vendor-closed', label: 'No vendor window', group: 'Inventory', make: () => ({ kind: 'vendor-closed' }), is: (c) => c.kind === 'vendor-closed', parts: [] },
  { id: 'mon-count', label: 'Monster count', group: 'Nearby', hint: 'pattern, count', make: () => ({ kind: 'monster-count', pattern: '', count: 2, meters: 30 }), is: (c) => c.kind === 'monster-count', parts: ['at least', { key: 'count', type: 'number', width: 36 }, 'matching', { key: 'pattern', type: 'text', width: 110 }, 'within', { key: 'meters', type: 'number', width: 40 }, 'm'] },
  { id: 'landblock', label: 'In landblock', group: 'Location', hint: 'number', make: () => ({ kind: 'landblock', landblock: 0 }), is: (c) => c.kind === 'landblock', parts: [{ key: 'landblock', type: 'number', width: 100 }] },
  { id: 'landcell', label: 'In cell', group: 'Location', hint: 'number', make: () => ({ kind: 'landcell', cell: 0 }), is: (c) => c.kind === 'landcell', parts: [{ key: 'cell', type: 'number', width: 100 }] },
  { id: 'portal-in', label: 'Entered portal space', group: 'Location', make: () => ({ kind: 'portal-entered' }), is: (c) => c.kind === 'portal-entered', parts: [] },
  { id: 'portal-out', label: 'Came out of a portal', group: 'Location', make: () => ({ kind: 'portal-exited' }), is: (c) => c.kind === 'portal-exited', parts: [] },
  { id: 'route-done', label: 'Route finished', group: 'Routine', make: () => ({ kind: 'route-done' }), is: (c) => c.kind === 'route-done', parts: [] },
  { id: 'expr', label: 'Expression', group: 'Routine', hint: 'VirindiTank syntax', make: () => ({ kind: 'expression', expr: '' }), is: (c) => c.kind === 'expression', parts: [{ key: 'expr', type: 'text', width: 240 }] },
  { id: 'unsupported', label: "Can't run", group: '', make: () => ({ kind: 'unsupported', what: '' }), is: (c) => c.kind === 'unsupported', parts: [{ key: 'what', type: 'readonly' }] },
];

export const ACTIONS: ActDef[] = [
  { id: 'state', label: 'Go to state', group: 'Routine', make: (p) => ({ kind: 'set-state', state: p.states[0]?.name ?? '' }), is: (a) => a.kind === 'set-state', parts: [{ key: 'state', type: 'state' }] },
  { id: 'wait', label: 'Wait', group: 'Routine', hint: 'seconds', make: () => ({ kind: 'wait', seconds: 5 }), is: (a) => a.kind === 'wait', parts: [{ key: 'seconds', type: 'number', width: 40 }, 's'] },
  { id: 'stop', label: 'Stop the routine', group: 'Routine', make: () => ({ kind: 'stop' }), is: (a) => a.kind === 'stop', parts: [] },
  { id: 'attack', label: 'Attack nearest', group: 'Combat', make: () => ({ kind: 'attack-nearest', meters: 30 }), is: (a) => a.kind === 'attack-nearest', parts: ['within', { key: 'meters', type: 'number', width: 40 }, 'm, named', { key: 'names', type: 'names', width: 110 }] },
  { id: 'loot', label: 'Loot my kills', group: 'Loot', hint: 'by the loot rules', make: () => ({ kind: 'loot-nearby', meters: 20 }), is: (a) => a.kind === 'loot-nearby', parts: ['within', { key: 'meters', type: 'number', width: 40 }, 'm'] },
  { id: 'sell', label: 'Sell loot to', group: 'Loot', hint: 'vendor name', make: () => ({ kind: 'sell-by-loot-rules', vendor: '' }), is: (a) => a.kind === 'sell-by-loot-rules', parts: [{ key: 'vendor', type: 'text', width: 150 }] },
  { id: 'cast', label: 'Cast', group: 'Magic', make: () => ({ kind: 'cast', spell: '' }), is: (a) => a.kind === 'cast', parts: [{ key: 'spell', type: 'text', width: 140 }, 'on', { key: 'target', type: 'target' }] },
  { id: 'buffs', label: 'Cast buff set', group: 'Magic', make: (p) => ({ kind: 'cast-buffs', set: p.buffSets[0]?.name ?? '' }), is: (a) => a.kind === 'cast-buffs', parts: [{ key: 'set', type: 'buffSet' }] },
  { id: 'use-item', label: 'Use item', group: 'Items', make: () => ({ kind: 'use-item', item: '' }), is: (a) => a.kind === 'use-item', parts: [{ key: 'item', type: 'text', width: 130 }, 'on', { key: 'on', type: 'target' }] },
  { id: 'route', label: 'Follow route', group: 'Movement', make: (p) => ({ kind: 'follow-route', route: p.routes[0]?.name ?? '' }), is: (a) => a.kind === 'follow-route', parts: [{ key: 'route', type: 'route' }] },
  { id: 'walk', label: 'Walk to', group: 'Movement', hint: 'map coordinates', make: () => ({ kind: 'walk-to', coords: '' }), is: (a) => a.kind === 'walk-to', parts: [{ key: 'coords', type: 'text', width: 120 }] },
  { id: 'use', label: 'Use', group: 'Movement', hint: 'door, NPC, portal…', make: () => ({ kind: 'use-object', name: '' }), is: (a) => a.kind === 'use-object', parts: [{ key: 'name', type: 'text', width: 140 }] },
  { id: 'say', label: 'Say', group: 'Chat', make: () => ({ kind: 'say', text: '' }), is: (a) => a.kind === 'say', parts: [{ key: 'text', type: 'text', width: 200 }] },
  { id: 'train', label: 'Spend XP on', group: 'Character', hint: 'Strength 100, …', make: () => ({ kind: 'train', plan: [{ stat: 'Strength', upTo: 100 }] }), is: (a) => a.kind === 'train', parts: [{ key: 'plan', type: 'plan', width: 220 }] },
  { id: 'call', label: 'Call state', group: 'Routine', hint: 'and come back', make: (p) => ({ kind: 'call-state', state: p.states[0]?.name ?? '', returnTo: p.states[0]?.name ?? '' }), is: (a) => a.kind === 'call-state', parts: [{ key: 'state', type: 'state' }, 'then return to', { key: 'returnTo', type: 'state' }] },
  { id: 'return', label: 'Return', group: 'Routine', hint: 'to the calling state', make: () => ({ kind: 'return' }), is: (a) => a.kind === 'return', parts: [] },
  { id: 'load-route', label: 'Load route', group: 'Movement', hint: 'the macro walks it', make: (p) => ({ kind: 'load-route', route: p.routes[0]?.name ?? '' }), is: (a) => a.kind === 'load-route', parts: [{ key: 'route', type: 'route' }] },
  { id: 'setting', label: 'Set setting', group: 'Routine', hint: 'EnableCombat, …', make: () => ({ kind: 'set-setting', name: 'EnableCombat', value: true }), is: (a) => a.kind === 'set-setting', parts: [{ key: 'name', type: 'text', width: 120 }, 'to', { key: 'value', type: 'text', width: 70 }] },
  { id: 'watchdog', label: 'Watchdog', group: 'Routine', hint: 'if you stop moving', make: (p) => ({ kind: 'set-watchdog', state: p.states[0]?.name ?? '', meters: 5, seconds: 60 }), is: (a) => a.kind === 'set-watchdog', parts: ['go to', { key: 'state', type: 'state' }, 'if not', { key: 'meters', type: 'number', width: 36 }, 'm in', { key: 'seconds', type: 'number', width: 44 }, 's'] },
  { id: 'clear-watchdog', label: 'Clear watchdog', group: 'Routine', make: () => ({ kind: 'clear-watchdog' }), is: (a) => a.kind === 'clear-watchdog', parts: [] },
  { id: 'expr', label: 'Expression', group: 'Routine', hint: 'VirindiTank syntax', make: () => ({ kind: 'expression', expr: '' }), is: (a) => a.kind === 'expression', parts: [{ key: 'expr', type: 'text', width: 240 }] },
  { id: 'unsupported', label: "Can't run", group: '', make: () => ({ kind: 'unsupported', what: '' }), is: (a) => a.kind === 'unsupported', parts: [{ key: 'what', type: 'readonly' }] },
];

export const condDef = (c: RoutineCondition): CondDef | undefined => CONDITIONS.find((d) => d.is(c));
export const actDef = (a: RoutineAction): ActDef | undefined => ACTIONS.find((d) => d.is(a));

/** "Strength 100, Heavy Weapons 150" ⇄ a train plan. */
export function planText(plan: Array<{ stat: string; upTo: number }>): string {
  return plan.map((e) => `${e.stat} ${e.upTo}`).join(', ');
}
export function parsePlan(text: string): Array<{ stat: string; upTo: number }> {
  return text.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^(.*?)\s+(\d+)$/.exec(s);
    return m ? { stat: m[1].trim(), upTo: Number(m[2]) } : { stat: s, upTo: 0 };
  });
}

export function newProfile(name: string): RoutineProfile {
  return {
    name, modules: { ...ALL_MODULES_OFF, combat: true, looting: true, vitals: true, navigation: true },
    initialState: 'Hunt', states: [{ name: 'Hunt', rules: [] }], loot: [], buffSets: [], routes: [],
  };
}

const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
const fmtSpan = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} m ${s % 60} s` : `${s} s`;
};

export function statsRows(st: RoutineStats, now: number): Array<[string, string]> {
  if (st.startedAt === null) return [];
  const ms = now - st.startedAt;
  const hours = ms / 3_600_000;
  const total = Object.values(st.stateTime).reduce((a, b) => a + b, 0);
  const share = total ? Object.entries(st.stateTime).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round((v / total) * 100)}%`).join(' · ') : '—';
  return [
    ['XP per hour', hours > 0.01 ? Math.round(st.xpGained / hours).toLocaleString('en-US') : '—'],
    ['XP gained', st.xpGained.toLocaleString('en-US')],
    ['Kills', String(st.kills)],
    ['Deaths', String(st.deaths)],
    ['Loot', `${st.kept} kept · ${st.left} left · ${st.sold} sold`],
    ['Rebuffs', String(st.rebuffs)],
    ['Time in each state', share],
  ];
}

export function hudStripText(status: RoutineStatus, st: RoutineStats, now: number): { state: string; sub: string; color: 'good' | 'warn' } | null {
  if (!status.running) return null;
  const ms = st.startedAt === null ? 0 : now - st.startedAt;
  const perHour = ms > 36_000 ? Math.round(st.xpGained / (ms / 3_600_000)) : 0;
  return {
    state: `${status.paused ? 'Paused' : 'Running'} · ${status.state ?? ''}`,
    sub: `${perHour >= 1000 ? `${Math.round(perHour / 1000)}k` : perHour} XP/h · ${fmtDuration(ms)}`,
    color: status.paused ? 'warn' : 'good',
  };
}

const el = (tag: string, style: Partial<CSSStyleDeclaration> = {}, data: Record<string, string> = {}): HTMLElement => {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  for (const [k, v] of Object.entries(data)) e.dataset[k] = v;
  return e;
};
const flexRow = (gap = 6, wrap = false): HTMLElement => el('div', { display: 'flex', alignItems: 'center', gap: `${gap}px`, flexWrap: wrap ? 'wrap' : 'nowrap', position: 'relative' });
const col = (gap = 6): HTMLElement => el('div', { display: 'flex', flexDirection: 'column', gap: `${gap}px`, position: 'relative' });
const tag = (e: HTMLElement, data: Record<string, string>): HTMLElement => { for (const [k, v] of Object.entries(data)) e.dataset[k] = v; return e; };
/** Text that takes the row's spare width (in a box: growing the bitmap text itself would stretch it). */
const grow = (e: HTMLElement): HTMLElement => { const w = el('div', { flexGrow: '1', minWidth: '0' }); w.appendChild(e); return w; };

// ── the panel ──

export class AutomationPanel {
  private tab: 'automation' | 'stats' = 'automation';
  private doc: RoutineDoc | null = null;
  private selected: string | null = null;
  private message = '';
  private loading = false;
  editor: RoutineEditor | null = null;

  constructor(private readonly kit: AutomationKit, readonly source: AutomationSource, private readonly openEditor: (editor: RoutineEditor) => void) {}

  async load(redraw: () => void): Promise<void> {
    this.loading = true;
    this.message = 'Loading your routines…';
    redraw();
    const r = await this.source.load();
    this.loading = false;
    if (r.ok) {
      this.doc = r.doc as RoutineDoc;
      const running = this.source.status().profile;
      const ch = this.source.character();
      const assigned = ch ? this.doc.characters?.[ch] : undefined;
      this.selected = running ?? (this.doc.profiles.some((p) => p.name === this.selected) ? this.selected : assigned ?? this.doc.profiles[0]?.name ?? null);
      this.message = this.doc.profiles.length ? '' : 'No routines yet: Edit… makes one.';
    } else this.message = r.message;
    redraw();
  }

  get document(): RoutineDoc | null { return this.doc; }
  get onStatsTab(): boolean { return this.tab === 'stats'; }

  private profile(): RoutineProfile | null {
    const running = this.source.current();
    if (running && running.name === this.selected) return running;
    return this.doc?.profiles.find((p) => p.name === this.selected) ?? null;
  }

  /** Open the editor (optionally on a tab). */
  edit(tab: EditorTab = 'routine', redraw: () => void = () => {}): void {
    if (!this.doc) { this.message = this.message || 'Your routines have not loaded.'; redraw(); return; }
    this.editor = new RoutineEditor(this.kit, this.source, structuredClone(this.doc), this.selected, (saved) => {
      this.doc = saved;
      if (!saved.profiles.some((p) => p.name === this.selected)) this.selected = saved.profiles[0]?.name ?? null;
      redraw();
    }, tab);
    this.openEditor(this.editor);
  }

  render(body: HTMLElement, w: number, h: number, redraw: () => void): void {
    body.innerHTML = '';
    const { kit } = this;
    const root = el('div', { position: 'absolute', left: '0', top: '0', width: `${w}px`, height: `${h}px` }, { automation: 'panel' });
    body.appendChild(root);
    const tabs = flexRow(2);
    Object.assign(tabs.style, { position: 'absolute', left: '2px', top: '0' });
    for (const [id, label] of [['automation', 'Automation'], ['stats', 'Stats']] as const) {
      tabs.appendChild(tag(kit.tab(label, this.tab === id, () => { this.tab = id; redraw(); }), { automationTab: id }));
    }
    root.appendChild(tabs);
    const content = el('div', { position: 'absolute', left: '0', top: '30px', width: `${w}px`, height: `${h - 30}px` });
    root.appendChild(content);
    const inner = col(7);
    inner.style.padding = '2px 6px 8px 4px';
    content.appendChild(inner);
    if (this.tab === 'stats') this.renderStats(inner, w, redraw);
    else this.renderMain(inner, w, redraw);
    kit.scroll(content);
  }

  private renderMain(inner: HTMLElement, w: number, redraw: () => void): void {
    const { kit, source } = this;
    const c = kit.colors;
    const status = source.status();
    const prof = this.profile();
    const act = (r: Result) => { this.message = r.ok ? '' : r.message; redraw(); };
    // Profile.
    const pr = flexRow(8);
    pr.appendChild(kit.header('Profile'));
    const names = this.doc?.profiles.map((p) => p.name) ?? [];
    if (names.length) {
      pr.appendChild(tag(kit.field(this.selected ?? names[0], (a) => {
        if (status.running) { act({ ok: false, message: 'Stop the routine to change profiles.' }); return; }
        kit.menu(a, names.map((n) => ({ label: n, value: n })), (v) => { this.selected = v; this.message = ''; redraw(); });
      }, w - 76), { automation: 'profile' }));
    } else pr.appendChild(kit.text(this.loading ? '…' : 'none', { color: c.dim }));
    inner.appendChild(pr);
    // Status box.
    const box = kit.box();
    tag(box, { automation: 'status' });
    const sb = flexRow(8);
    sb.style.padding = '5px 7px';
    sb.appendChild(kit.dot(status.running && !status.paused));
    const lines = col(1);
    lines.appendChild(kit.text(status.running ? `${status.paused ? 'Paused' : 'Running'}: ${status.state}` : 'Stopped', { color: status.running ? (status.paused ? c.warn : c.good) : c.text }));
    const sub = status.running
      ? (status.paused ? 'Nothing will act until you resume' : status.acting ? `Acting: ${status.acting}` : 'Watching for a rule to fire')
      : prof ? `Starts in ${prof.initialState}` : '';
    if (sub) lines.appendChild(kit.text(sub, { color: c.dim, maxWidth: w - 50 }));
    sb.appendChild(lines);
    box.appendChild(sb);
    inner.appendChild(box);
    // Buttons.
    const btns = flexRow(4);
    if (!status.running) {
      btns.appendChild(tag(kit.button('Run', () => { const p = this.profile(); if (!p) { act({ ok: false, message: 'Pick or make a routine first.' }); return; } act(source.run(p)); }, { width: 84 }), { automation: 'run' }));
    } else {
      btns.appendChild(tag(kit.button(status.paused ? 'Resume' : 'Pause', () => act(status.paused ? source.resume() : source.pause()), { width: 84 }), { automation: status.paused ? 'resume' : 'pause' }));
      btns.appendChild(tag(kit.button('Stop', () => act(source.stop()), { variant: 'red', width: 84 }), { automation: 'stop' }));
    }
    btns.appendChild(tag(kit.button('Edit…', () => this.edit('routine', redraw), { width: 84 }), { automation: 'edit' }));
    inner.appendChild(btns);
    if (this.message) inner.appendChild(tag(kit.text(this.message, { color: c.warn, maxWidth: w - 12 }), { automation: 'message' }));
    if (!prof) return;
    inner.appendChild(kit.header('Modules'));
    const list = col(0);
    for (const m of MODULES) {
      const on = prof.modules[m.key];
      const r = flexRow(8);
      tag(r, { automationModule: m.key, on: on ? '1' : '0' });
      Object.assign(r.style, { minHeight: '30px' });
      r.appendChild(tag(kit.check(on, (v) => {
        if (status.running) { act(source.setModule(m.key, v)); return; }
        const d = this.doc;
        const sp = d?.profiles.find((x) => x.name === prof.name);
        if (!d || !sp) return;
        sp.modules[m.key] = v;
        void source.save(d).then((s) => { this.message = s.ok ? '' : s.message; if (s.ok) this.doc = s.doc as RoutineDoc; redraw(); });
        redraw();
      }), { moduleSwitch: m.key }));
      const t = col(0);
      t.style.flexGrow = '1';
      t.appendChild(kit.text(m.name, { color: on ? c.text : c.dim }));
      t.appendChild(kit.text(moduleSummary(prof, m.key), { color: c.dim, maxWidth: w - 80 }));
      r.appendChild(t);
      r.appendChild(tag(kit.button('›', () => this.edit(m.tab, redraw), { width: 32 }), { moduleSettings: m.key }));
      list.appendChild(r);
    }
    inner.appendChild(list);
  }

  private renderStats(inner: HTMLElement, w: number, redraw: () => void): void {
    const { kit, source } = this;
    const c = kit.colors;
    const st = source.stats();
    inner.appendChild(kit.header(st.startedAt === null ? 'This session · not started' : `This session · ${fmtDuration(source.now() - st.startedAt)}`));
    const rows = statsRows(st, source.now());
    for (const [k, v] of rows) {
      const r = flexRow(10);
      tag(r, { automationStat: k });
      r.style.justifyContent = 'space-between';
      r.appendChild(kit.text(k, { color: c.dim }));
      r.appendChild(kit.text(v, { color: c.text, maxWidth: w - 120 }));
      inner.appendChild(r);
      inner.appendChild(kit.separator());
    }
    const btns = flexRow(4);
    btns.appendChild(tag(kit.button('Reset', () => { source.resetStats(); redraw(); }, { width: 100 }), { automation: 'reset-stats' }));
    btns.appendChild(tag(kit.button('Report to chat', () => { for (const [k, v] of rows) source.report(`${k}: ${v}`); }, { width: 150 }), { automation: 'report-stats' }));
    inner.appendChild(btns);
  }
}

// ── the editor ──

export type EditorTab = 'routine' | 'combat' | 'buffs' | 'loot' | 'routes';
const LOOT_ACTIONS: Array<{ value: LootAction; label: string }> = [
  { value: 'keep', label: 'Keep' }, { value: 'keep-up-to', label: 'Keep up to' }, { value: 'sell', label: 'Sell' }, { value: 'salvage', label: 'Salvage' }, { value: 'read', label: 'Read' }, { value: 'ignore', label: 'Leave' },
];
const LOOT_REQS: Array<{ key: keyof LootMatch; label: string; op: string; type: 'text' | 'number' | 'types' }> = [
  { key: 'name', label: 'Name', op: 'matches', type: 'text' },
  { key: 'types', label: 'Item type', op: 'is', type: 'types' },
  { key: 'valueAtLeast', label: 'Value', op: 'at least', type: 'number' },
  { key: 'valueAtMost', label: 'Value', op: 'at most', type: 'number' },
  { key: 'burdenAtMost', label: 'Burden', op: 'at most', type: 'number' },
  { key: 'appraisal', label: 'Appraisal says', op: 'matches', type: 'text' },
  { key: 'minDamageAtLeast', label: 'Minimum damage', op: 'at least', type: 'number' },
  { key: 'spellCountAtLeast', label: 'Spells on it', op: 'at least', type: 'number' },
  { key: 'totalRatingsAtLeast', label: 'Total ratings', op: 'at least', type: 'number' },
  { key: 'freeSlotsAtLeast', label: 'Your free pack slots', op: 'at least', type: 'number' },
  { key: 'characterLevelAtLeast', label: 'Your level', op: 'at least', type: 'number' },
  { key: 'characterLevelAtMost', label: 'Your level', op: 'at most', type: 'number' },
];

const words = (s: string | undefined, fallback: string) => (s ? s.replace(/([a-z])([A-Z0-9])/g, '$1 $2') : fallback);
const PROP_ENUMS = { int: PropertyInt, float: PropertyFloat, string: PropertyString, did: PropertyDataId, bool: null } as const;
const PROP_OPS: Record<string, string> = { le: 'at most', ge: 'at least', eq: 'is', ne: 'is not', flag: 'has flags', match: 'matches' };

/** Imported requirements the form has no field for (item properties, spells, your skills), as sentences. */
export function lootExtraLines(m: LootMatch): Array<{ key: 'props' | 'spells' | 'characterSkills' | 'palettes' | 'colours'; index: number; text: string }> {
  const out: Array<{ key: 'props' | 'spells' | 'characterSkills' | 'palettes' | 'colours'; index: number; text: string }> = [];
  (m.props ?? []).forEach((t, i) => {
    const e = PROP_ENUMS[t.kind] as Record<number, string> | null;
    out.push({ key: 'props', index: i, text: `${words(e?.[t.key], `${t.kind} property ${t.key}`)} ${PROP_OPS[t.op] ?? t.op} ${t.op === 'match' ? `/${t.value}/` : t.kind === 'did' ? `0x${(Number(t.value) & 0xffffff).toString(16).toUpperCase()}` : t.value}` });
  });
  (m.colours ?? []).forEach((x, i) => out.push({ key: 'colours', index: i, text: `Colour near ${x.rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}${x.group ? ` on ${x.group}` : x.slots ? ` in slot ${x.slots.join(', ')}` : ''}` }));
  (m.palettes ?? []).forEach((x, i) => out.push({ key: 'palettes', index: i, text: `Colour slot ${x.slot} is palette 0x${(x.palette & 0xffffff).toString(16).toUpperCase()}` }));
  if (m.spells) out.push({ key: 'spells', index: 0, text: `${m.spells.count}+ spells matching /${m.spells.match}/${m.spells.notMatch ? ` but not /${m.spells.notMatch}/` : ''}` });
  (m.characterSkills ?? []).forEach((s, i) => {
    const name = words(SkillId[s.skill], `skill ${s.skill}`);
    const parts = [s.atLeast !== undefined && `at least ${s.atLeast}`, (s.baseMin !== undefined || s.baseMax !== undefined) && `base ${s.baseMin ?? 0}–${s.baseMax ?? '∞'}`].filter(Boolean);
    out.push({ key: 'characterSkills', index: i, text: `Your ${name} ${parts.join(', ')}` });
  });
  return out;
}
const ITEM_TYPES = ['Melee Weapon', 'Missile Weapon', 'Caster', 'Armor', 'Clothing', 'Jewelry', 'Gem', 'Food', 'Money', 'Spell Components', 'Mana Stone', 'Key', 'Container', 'Misc'];

export class RoutineEditor {
  private profileName: string | null;
  private stateName: string | null = null;
  private lootIndex = 0;
  private buffIndex = 0;
  private routeIndex = 0;
  private issues: Array<{ path: string; message: string }> = [];
  private note = '';
  private showHistory = false;
  private tryResult = '';
  private renaming = false;
  dirty = false;

  constructor(
    private readonly kit: AutomationKit,
    private readonly source: AutomationSource,
    readonly doc: RoutineDoc,
    profileName: string | null,
    private readonly onSaved: (doc: RoutineDoc) => void,
    private tab: EditorTab = 'routine',
  ) {
    this.profileName = profileName ?? doc.profiles[0]?.name ?? null;
  }

  private profile(): RoutineProfile | null { return this.doc.profiles.find((p) => p.name === this.profileName) ?? null; }

  async save(redraw: () => void): Promise<boolean> {
    this.doc.schemaVersion = ROUTINE_SCHEMA_VERSION;
    const local = validateRoutineDoc(this.doc);
    if (local.length) { this.issues = local; this.note = `Not saved: ${local.length} problem${local.length > 1 ? 's' : ''}`; redraw(); return false; }
    this.note = 'Saving…';
    redraw();
    const r = await this.source.save(this.doc);
    if (r.ok) { this.issues = []; this.dirty = false; this.note = 'Saved to your account'; this.onSaved(r.doc as RoutineDoc); }
    else { this.issues = r.issues ?? []; this.note = r.message; }
    redraw();
    return r.ok;
  }

  /**
   * VirindiTank files (.met / .nav / .utl / .usd, and metaf's .af) into the current profile (or a new
   * one). `names` names a .usd's object and spell ids from the client (vtankUsd.ts).
   */
  importFiles(files: Array<{ name: string; text: string }>, redraw: () => void, names: VtNames = {}): void {
    const base = this.profile();
    const name = base?.name ?? files.find((f) => /\.(met|af|usd)$/i.test(f.name))?.name.replace(/\.(met|af|usd)$/i, '') ?? 'Imported';
    const r = importVTankFiles(files, base, name, names);
    this.doc.profiles = [...this.doc.profiles.filter((p) => p !== base), r.value];
    this.profileName = r.value.name;
    this.stateName = null;
    this.dirty = true;
    this.issues = r.problems.map((p) => ({ path: 'import', message: p }));
    this.note = `Imported ${files.map((f) => f.name).join(', ')}: ${r.problems.length ? `${r.problems.length} things couldn't be carried over exactly (switched off)` : 'everything carried over'}. Save to keep it.`;
    redraw();
  }

  render(body: HTMLElement, w: number, h: number, redraw: () => void, close: () => void, pickFiles?: () => void, exportDoc?: () => void): void {
    body.innerHTML = '';
    const { kit } = this;
    const c = kit.colors;
    const touch = () => { this.dirty = true; this.note = ''; redraw(); };
    /** Looking at something else (a rule, a set, a route) is not an edit. */
    const view = () => { this.note = ''; redraw(); };
    const root = el('div', { position: 'absolute', left: '0', top: '0', width: `${w}px`, height: `${h}px` }, { automation: 'editor' });
    body.appendChild(root);
    // Header.
    const head = flexRow(6);
    Object.assign(head.style, { position: 'absolute', left: '0', top: '0', width: `${w}px`, height: '34px' });
    head.appendChild(kit.header('Automation'));
    head.appendChild(kit.text('·', { color: c.dim }));
    const names = this.doc.profiles.map((p) => p.name);
    head.appendChild(tag(kit.field(`Profile: ${this.profileName ?? '—'}`, (a) => {
      kit.menu(a, [...names.map((n) => ({ label: n, value: `p:${n}` })), { label: 'New routine…', value: 'new' }], (v) => {
        if (v === 'new') {
          let n = 1;
          while (this.doc.profiles.some((p) => p.name === `New routine ${n}`)) n++;
          this.doc.profiles.push(newProfile(`New routine ${n}`));
          this.profileName = `New routine ${n}`;
          this.stateName = null;
          touch();
          return;
        }
        this.profileName = v.slice(2); this.stateName = null; redraw();
      });
    }, 250), { automation: 'editor-profile' }));
    head.appendChild(el('div', { flexGrow: '1' }));
    if (pickFiles) head.appendChild(tag(kit.button('Import from VirindiTank…', pickFiles), { automation: 'import' }));
    if (exportDoc) head.appendChild(tag(kit.button('Export', exportDoc), { automation: 'export' }));
    head.appendChild(tag(kit.button(this.dirty ? 'Save*' : 'Save', () => { void this.save(redraw); }), { automation: 'save' }));
    head.appendChild(tag(kit.button('Close', close, { variant: 'red' }), { automation: 'close-editor' }));
    root.appendChild(head);
    // Tabs.
    const tabs = flexRow(2);
    Object.assign(tabs.style, { position: 'absolute', left: '4px', top: '40px' });
    for (const [id, label] of [['routine', 'Routine'], ['combat', 'Combat'], ['buffs', 'Buffs'], ['loot', 'Loot'], ['routes', 'Routes']] as const) {
      tabs.appendChild(tag(kit.tab(label, this.tab === id, () => { this.tab = id; redraw(); }), { automationEditorTab: id }));
    }
    root.appendChild(tabs);
    const footH = this.issues.length || this.note ? Math.min(84, 20 + Math.min(this.issues.length, 4) * 16) : 0;
    const area = el('div', { position: 'absolute', left: '0', top: '70px', width: `${w}px`, height: `${h - 70 - footH}px` });
    root.appendChild(area);
    const p = this.profile();
    if (!p) area.appendChild(kit.text('No routine yet: pick New routine… in the Profile menu, or Import from VirindiTank….', { color: c.dim }));
    else if (this.tab === 'routine') this.renderRoutine(area, p, w, h - 70 - footH, touch, redraw);
    else if (this.tab === 'loot') this.renderLoot(area, p, w, h - 70 - footH, touch, view);
    else if (this.tab === 'combat') this.renderCombat(area, p, w, touch);
    else if (this.tab === 'buffs') this.renderBuffs(area, p, w, h - 70 - footH, touch, view);
    else this.renderRoutes(area, p, w, h - 70 - footH, touch, view);
    if (footH) {
      const foot = el('div', { position: 'absolute', left: '0', bottom: '0', width: `${w}px`, height: `${footH}px`, overflow: 'hidden' }, { automation: 'issues' });
      if (this.note) foot.appendChild(kit.text(this.note, { color: this.issues.length ? c.warn : c.good, maxWidth: w - 8 }));
      for (const i of this.issues.slice(0, 4)) foot.appendChild(kit.text(`${i.path || '(document)'}: ${i.message}`, { color: c.bad, maxWidth: w - 8 }));
      root.appendChild(foot);
    }
  }

  /** A left column + right pane, each scrolling. */
  private split(area: HTMLElement, w: number, h: number, leftW: number): { left: HTMLElement; right: HTMLElement; rightBox: HTMLElement } {
    const leftBox = el('div', { position: 'absolute', left: '0', top: '0', width: `${leftW}px`, height: `${h}px` });
    const rightBox = el('div', { position: 'absolute', left: `${leftW + 12}px`, top: '0', width: `${w - leftW - 12}px`, height: `${h}px` });
    area.appendChild(leftBox);
    area.appendChild(rightBox);
    const left = col(6);
    left.style.paddingRight = '4px';
    leftBox.appendChild(left);
    const right = col(6);
    right.style.paddingRight = '4px';
    rightBox.appendChild(right);
    return { left, right, rightBox };
  }

  // ── Routine ──

  private renderRoutine(area: HTMLElement, p: RoutineProfile, w: number, h: number, touch: () => void, redraw: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    if (!p.states.some((s) => s.name === this.stateName)) this.stateName = p.states.find((s) => s.name === p.initialState)?.name ?? p.states[0]?.name ?? null;
    const status = this.source.status();
    const runningHere = status.running && status.profile === p.name;
    const liveH = 40;
    const { left, right, rightBox } = this.split(area, w, h - liveH - 6, 200);
    // States column.
    left.appendChild(kit.header('States'));
    const sbox = kit.box();
    const sl = col(1);
    sl.style.padding = '3px';
    for (const s of p.states) {
      const r = kit.row(s.name === this.stateName, () => { this.stateName = s.name; this.renaming = false; redraw(); });
      tag(r, { automationState: s.name });
      r.appendChild(kit.dot(runningHere && status.state === s.name));
      r.appendChild(grow(kit.text(s.name, { color: c.text })));
      if (s.rules.length) r.appendChild(kit.text(String(s.rules.length), { color: c.dim }));
      sl.appendChild(r);
    }
    sbox.appendChild(sl);
    left.appendChild(sbox);
    left.appendChild(tag(kit.button('+ New state', () => {
      let n = 1;
      while (p.states.some((s) => s.name === `State ${n}`)) n++;
      p.states.push({ name: `State ${n}`, rules: [] });
      this.stateName = `State ${n}`;
      touch();
    }), { automation: 'add-state' }));
    left.appendChild(kit.text(`Starts in ${p.initialState}. The lit dot is the state running now.`, { color: c.dim, maxWidth: 196 }));
    const ch = this.source.character();
    if (ch) {
      const mine = this.doc.characters?.[ch] === p.name;
      const r = flexRow(6);
      r.appendChild(tag(kit.check(mine, (v) => {
        this.doc.characters = { ...(this.doc.characters ?? {}) };
        if (v) this.doc.characters[ch] = p.name; else delete this.doc.characters[ch];
        touch();
      }), { automation: 'character-default' }));
      r.appendChild(kit.text(`${ch} starts with this`, { color: c.dim, maxWidth: 170 }));
      left.appendChild(r);
    }
    left.appendChild(kit.header('Shared settings'));
    const shared = kit.box();
    const sh = col(3);
    sh.style.padding = '6px';
    for (const [label, value, t] of [
      ['Loot', p.loot.length ? `${p.loot.length} rules` : 'none', 'loot'],
      ['Buff sets', p.buffSets.map((b) => b.name).join(', ') || 'none', 'buffs'],
      ['Routes', p.routes.map((r) => r.name).join(', ') || 'none', 'routes'],
    ] as const) {
      const r = kit.row(false, () => { this.tab = t; redraw(); });
      r.appendChild(kit.text(label, { color: c.dim }));
      r.appendChild(kit.text(value, { color: c.text, maxWidth: 120 }));
      sh.appendChild(r);
    }
    shared.appendChild(sh);
    left.appendChild(shared);
    // The state's rules.
    const s = p.states.find((x) => x.name === this.stateName);
    if (s) {
      const hd = flexRow(8, true);
      hd.appendChild(kit.header('State'));
      if (this.renaming) {
        hd.appendChild(tag(kit.input(s.name, 160, (v) => this.renameState(p, s, v.trim())), { automation: 'state-name' }));
        hd.appendChild(kit.button('Done', () => { this.renaming = false; redraw(); }));
      } else {
        hd.appendChild(kit.text(s.name, { color: c.text }));
        hd.appendChild(tag(kit.button('Rename', () => { this.renaming = true; redraw(); }), { automation: 'rename-state' }));
      }
      hd.appendChild(el('div', { flexGrow: '1' }));
      if (p.initialState !== s.name) hd.appendChild(tag(kit.button('Start here', () => { p.initialState = s.name; touch(); }), { automation: 'start-here' }));
      if (p.states.length > 1) hd.appendChild(tag(kit.button('Delete', () => {
        p.states = p.states.filter((x) => x !== s);
        if (p.initialState === s.name) p.initialState = p.states[0].name;
        this.stateName = p.states[0].name;
        touch();
      }, { variant: 'red' }), { automation: 'delete-state' }));
      hd.appendChild(tag(kit.button('+ Add rule', () => { s.rules.push({ when: [{ kind: 'always' }], do: [{ kind: 'wait', seconds: 5 }] }); touch(); }), { automation: 'add-rule' }));
      right.appendChild(hd);
      right.appendChild(kit.text('Rules are checked top to bottom, twice a second. The first whose conditions all hold acts.', { color: c.dim, maxWidth: w - 230 }));
      if (!s.rules.length) {
        const empty = kit.box();
        empty.appendChild(kit.text('No rules yet. Add one.', { color: c.dim }));
        empty.style.padding = '18px';
        right.appendChild(empty);
      }
      s.rules.forEach((r, i) => right.appendChild(this.ruleBox(p, s, r, i, w - 230, touch, runningHere && status.state === s.name && !!status.acting && status.acting === (r.label ?? `rule ${i + 1}`))));
    }
    kit.scroll(rightBox);
    // Live strip.
    const live = kit.box();
    Object.assign(live.style, { position: 'absolute', left: '0', top: `${h - liveH}px`, width: `${w}px`, height: `${liveH}px` });
    tag(live, { automation: 'live' });
    const lr = flexRow(14);
    Object.assign(lr.style, { padding: '4px 8px', height: '100%', boxSizing: 'border-box' });
    lr.appendChild(kit.dot(runningHere && !status.paused));
    lr.appendChild(kit.text(runningHere ? (status.paused ? 'Paused' : 'Live') : 'Not running', { color: c.text }));
    if (runningHere) {
      lr.appendChild(kit.text(`In ${status.state}${status.stateSince !== undefined ? ` for ${fmtSpan(this.source.now() - status.stateSince)}` : ''}`, { color: c.dim }));
      if (status.acting) lr.appendChild(kit.text(`${status.acting} acting`, { color: c.dim }));
      if (status.lastChange) lr.appendChild(kit.text(`Last change: ${status.lastChange.from} → ${status.lastChange.to}${status.lastChange.rule ? ` (${status.lastChange.rule})` : ''}`, { color: c.dim, maxWidth: 360 }));
    }
    lr.appendChild(el('div', { flexGrow: '1' }));
    lr.appendChild(tag(kit.button('History', () => { this.showHistory = !this.showHistory; redraw(); }), { automation: 'history' }));
    if (runningHere && status.paused) lr.appendChild(tag(kit.button('Step one rule', () => { const r = this.source.step(); this.note = r.message; redraw(); }), { automation: 'step' }));
    live.appendChild(lr);
    area.appendChild(live);
    if (this.showHistory) {
      const hb = kit.box();
      Object.assign(hb.style, { position: 'absolute', right: '0', top: `${Math.max(0, h - liveH - 226)}px`, width: '420px', height: '220px', zIndex: '3' });
      tag(hb, { automation: 'history-list' });
      const hl = col(1);
      hl.style.padding = '6px';
      const log = this.source.history();
      for (const line of (log.length ? log : ['Nothing yet.']).slice(-60)) hl.appendChild(kit.text(line, { color: c.dim, maxWidth: 390 }));
      hb.appendChild(hl);
      area.appendChild(hb);
      kit.scroll(hb);
    }
  }

  private renameState(p: RoutineProfile, s: RoutineState, v: string): void {
    if (!v || p.states.some((x) => x !== s && x.name === v)) return;
    for (const st of p.states) for (const r of st.rules) for (const a of r.do) if (a.kind === 'set-state' && a.state === s.name) a.state = v;
    if (p.initialState === s.name) p.initialState = v;
    s.name = v;
    this.stateName = v;
    this.dirty = true;
  }

  private ruleBox(p: RoutineProfile, s: RoutineState, r: RoutineRule, i: number, w: number, touch: () => void, acting: boolean): HTMLElement {
    const { kit } = this;
    const c = kit.colors;
    const box = kit.box();
    tag(box, { automationRule: String(i) });
    const line = flexRow(5, true);
    line.style.padding = '6px 8px';
    line.appendChild(kit.text(`${i + 1}`, { color: c.dim }));
    line.appendChild(tag(kit.check(!r.disabled, (v) => { if (v) delete r.disabled; else r.disabled = true; touch(); }), { ruleOn: String(i) }));
    line.appendChild(kit.text('When', { color: c.gold }));
    r.when.forEach((cond, ci) => {
      if (ci > 0) line.appendChild(kit.text('and', { color: c.gold }));
      this.conditionSentence(line, p, cond, (n) => { r.when[ci] = n; touch(); });
    });
    line.appendChild(kit.text('Do', { color: c.gold }));
    r.do.forEach((a, ai) => {
      if (ai > 0) line.appendChild(kit.text('then', { color: c.gold }));
      this.actionSentence(line, p, a, (n) => { r.do[ai] = n; touch(); });
    });
    line.appendChild(el('div', { flexGrow: '1' }));
    if (acting) line.appendChild(tag(kit.text('acting now', { color: c.good }), { acting: '1' }));
    let moreBtn: HTMLElement | null = null;
    moreBtn = tag(kit.button('...', () => {
      const a = moreBtn!;
      const items: MenuItem[] = [
        { label: 'Add a condition (and)', value: 'add-cond' },
        { label: 'Add an action (then)', value: 'add-act' },
        ...(r.when.length > 1 ? [{ label: 'Remove the last condition', value: 'rm-cond' }] : []),
        ...(r.do.length > 1 ? [{ label: 'Remove the last action', value: 'rm-act' }] : []),
        ...(i > 0 ? [{ label: 'Move up', value: 'up' }] : []),
        ...(i < s.rules.length - 1 ? [{ label: 'Move down', value: 'down' }] : []),
        { label: 'Duplicate', value: 'dup' },
        { label: r.disabled ? 'Turn on' : 'Turn off', value: 'toggle' },
        { label: 'Delete', value: 'delete' },
      ];
      kit.menu(a, items, (v) => {
        if (v === 'add-cond') r.when.push({ kind: 'always' });
        else if (v === 'add-act') r.do.push({ kind: 'wait', seconds: 5 });
        else if (v === 'rm-cond') r.when.pop();
        else if (v === 'rm-act') r.do.pop();
        else if (v === 'up') s.rules.splice(i - 1, 0, ...s.rules.splice(i, 1));
        else if (v === 'down') s.rules.splice(i + 1, 0, ...s.rules.splice(i, 1));
        else if (v === 'dup') s.rules.splice(i + 1, 0, structuredClone(r));
        else if (v === 'toggle') { if (r.disabled) delete r.disabled; else r.disabled = true; }
        else if (v === 'delete') s.rules.splice(i, 1);
        touch();
      }, { width: 200 });
    }, { width: 32 }), { ruleMenu: String(i) });
    line.appendChild(moreBtn);
    box.appendChild(line);
    if (r.note) {
      const n = kit.text(r.note, { color: c.warn, maxWidth: w - 20 });
      n.style.padding = '0 8px 6px';
      box.appendChild(n);
    }
    if (acting) box.style.outline = `1px solid ${c.good}`;
    return box;
  }

  private conditionSentence(host: HTMLElement, p: RoutineProfile, cond: RoutineCondition, set: (c: RoutineCondition) => void): void {
    const { kit } = this;
    if (cond.kind === 'not') {
      host.appendChild(kit.text('not', { color: kit.colors.gold }));
      this.conditionSentence(host, p, cond.condition, (n) => set({ kind: 'not', condition: n }));
      return;
    }
    if (cond.kind === 'any' || cond.kind === 'all') {
      // VirindiTank's Any / All (imported or made in the VirindiTank window): each branch edits in place.
      host.appendChild(tag(kit.text(cond.kind === 'any' ? 'any of (' : 'all of (', { color: kit.colors.gold }), { automationConditionKind: cond.kind }));
      cond.conditions.forEach((x, i) => {
        if (i) host.appendChild(kit.text(cond.kind === 'any' ? 'or' : 'and', { color: kit.colors.gold }));
        this.conditionSentence(host, p, x, (n) => { const next = [...cond.conditions]; next[i] = n; set({ kind: cond.kind, conditions: next }); });
      });
      host.appendChild(kit.text(')', { color: kit.colors.gold }));
      return;
    }
    const def = condDef(cond);
    const pick = (a: HTMLElement) => kit.menu(a, [
      ...CONDITIONS.filter((d) => d.group).map((d) => ({ label: d.label, value: d.id, hint: d.hint, group: d.group })),
      { label: 'Not …', value: 'not', hint: 'the opposite', group: 'Routine' },
    ], (v) => {
      if (v === 'not') { set({ kind: 'not', condition: cond }); return; }
      const d = CONDITIONS.find((x) => x.id === v);
      if (d) set(d.make());
    }, { search: true, groups: CONDITION_GROUPS, width: 250 });
    host.appendChild(tag(kit.field(def?.label ?? cond.kind, pick, Math.max(90, (def?.label.length ?? 8) * 7 + 30)), { automationConditionKind: cond.kind }));
    for (const part of def?.parts ?? []) this.part(host, p, cond as unknown as Record<string, unknown>, part, () => set({ ...cond }));
  }

  private actionSentence(host: HTMLElement, p: RoutineProfile, a: RoutineAction, set: (a: RoutineAction) => void): void {
    const { kit } = this;
    const def = actDef(a);
    const pick = (anchor: HTMLElement) => kit.menu(anchor, ACTIONS.filter((d) => d.group).map((d) => ({ label: d.label, value: d.id, hint: d.hint, group: d.group })), (v) => {
      const d = ACTIONS.find((x) => x.id === v);
      if (d) set(d.make(p));
    }, { search: true, groups: ACTION_GROUPS, width: 250 });
    host.appendChild(tag(kit.field(def?.label ?? a.kind, pick, Math.max(90, (def?.label.length ?? 8) * 7 + 30)), { automationActionKind: a.kind }));
    for (const part of def?.parts ?? []) this.part(host, p, a as unknown as Record<string, unknown>, part, () => set({ ...a }));
  }

  /** A sentence's word, value field or choice. Typed values change the object in place (no redraw while typing). */
  private part(host: HTMLElement, p: RoutineProfile, obj: Record<string, unknown>, part: Part, changed: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    if (typeof part === 'string') { host.appendChild(kit.text(part, { color: c.dim })); return; }
    const inPlace = (v: unknown) => { if (v === undefined || v === '') delete obj[part.key]; else obj[part.key] = v; this.dirty = true; };
    const wrap = (e: HTMLElement) => { e.dataset.automationField = part.key; host.appendChild(e); };
    const choose = (current: string, options: string[], width = 110) => wrap(kit.field(current || '—', (a) => kit.menu(a, options.map((o) => ({ label: o, value: o })), (v) => { obj[part.key] = v; changed(); }), width));
    switch (part.type) {
      case 'number': wrap(kit.input(obj[part.key] === undefined ? '' : String(obj[part.key]), part.width ?? 48, (v) => inPlace(v.trim() === '' ? undefined : Number(v)))); return;
      case 'text': wrap(kit.input(String(obj[part.key] ?? ''), part.width ?? 130, (v) => inPlace(v))); return;
      case 'names': wrap(kit.input(((obj[part.key] as string[] | undefined) ?? []).join(', '), part.width ?? 110, (v) => {
        const list = v.split(',').map((x) => x.trim()).filter(Boolean);
        inPlace(list.length ? list : undefined);
      })); return;
      case 'plan': wrap(kit.input(planText((obj[part.key] as Array<{ stat: string; upTo: number }>) ?? []), part.width ?? 200, (v) => inPlace(parsePlan(v)))); return;
      case 'target': choose(String(obj[part.key] ?? 'self'), ['self', 'target'], 80); return;
      case 'state': choose(String(obj[part.key] ?? ''), p.states.map((s) => s.name)); return;
      case 'buffSet': if (p.buffSets.length) choose(String(obj[part.key] ?? ''), p.buffSets.map((b) => b.name)); else wrap(kit.text('(make a buff set)', { color: c.warn })); return;
      case 'route': if (p.routes.length) choose(String(obj[part.key] ?? ''), p.routes.map((r) => r.name)); else wrap(kit.text('(make a route)', { color: c.warn })); return;
      case 'vitalOp': {
        const below = obj.kind === 'vital-below';
        wrap(kit.field(below ? 'below' : 'above', (a) => kit.menu(a, [{ label: 'below', value: 'vital-below' }, { label: 'above', value: 'vital-above' }], (v) => { obj.kind = v; changed(); }), 80));
        return;
      }
      case 'readonly': wrap(kit.text(String(obj[part.key] ?? ''), { color: c.warn, maxWidth: 360 })); return;
    }
  }

  // ── Combat (the macro) ──

  private renderCombat(area: HTMLElement, p: RoutineProfile, w: number, touch: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    const inner = col(8);
    area.appendChild(inner);
    const s = (p.settings ??= {});
    const top = flexRow(8);
    top.appendChild(tag(kit.check(!!p.macro, (v) => { if (v) p.macro = true; else delete p.macro; touch(); }), { automation: 'macro' }));
    top.appendChild(kit.header('Macro'));
    top.appendChild(kit.text('When no rule acts: fight what is in range, loot your kills, keep a buff set up, walk the loaded route.', { color: c.dim, maxWidth: w - 120 }));
    inner.appendChild(top);
    const box = kit.box();
    const b = col(8);
    b.style.padding = '10px';
    const flag = (key: string, label: string, def: boolean) => {
      const r = flexRow(8);
      const on = s[key] === undefined ? def : s[key] === true || s[key] === 'true' || s[key] === 1;
      r.appendChild(tag(kit.check(on, (v) => { s[key] = v; touch(); }), { setting: key }));
      r.appendChild(kit.text(label, { color: on ? c.text : c.dim }));
      b.appendChild(r);
      return r;
    };
    const fight = flag('EnableCombat', 'Fight monsters within', true);
    fight.appendChild(tag(kit.input(String(s.AttackDistance ?? 20), 44, (v) => { s.AttackDistance = Number(v) || 20; this.dirty = true; }), { setting: 'AttackDistance' }));
    fight.appendChild(kit.text('m', { color: c.dim }));
    flag('EnableLooting', 'Loot my kills by the loot rules', true);
    flag('EnableNav', 'Walk the loaded route', true);
    const buff = flag('EnableBuffing', 'Keep this buff set up:', false);
    if (p.buffSets.length) buff.appendChild(tag(kit.field(String(s.BuffSet || '—'), (a) => kit.menu(a, p.buffSets.map((x) => ({ label: x.name, value: x.name })), (v) => { s.BuffSet = v; touch(); }), 140), { setting: 'BuffSet' }));
    else buff.appendChild(kit.text('(make a buff set)', { color: c.warn }));
    box.appendChild(b);
    inner.appendChild(box);
    // Other settings (from an import, or Set setting actions) shown as they are.
    const known = new Set(['EnableCombat', 'AttackDistance', 'EnableLooting', 'EnableNav', 'EnableBuffing', 'BuffSet']);
    const others = Object.entries(s).filter(([k]) => !known.has(k));
    if (others.length) {
      inner.appendChild(kit.header('Other settings'));
      const ob = kit.box();
      const ol = col(3);
      ol.style.padding = '8px';
      for (const [k, v] of others) {
        const r = flexRow(8);
        r.appendChild(kit.text(k, { color: c.dim }));
        r.appendChild(kit.input(String(v), 120, (nv) => { s[k] = nv; this.dirty = true; }));
        ol.appendChild(r);
      }
      ob.appendChild(ol);
      inner.appendChild(ob);
    }
  }

  // ── Loot ──

  private renderLoot(area: HTMLElement, p: RoutineProfile, w: number, h: number, touch: () => void, view: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    const { left, right, rightBox } = this.split(area, w, h, 330);
    const lh = flexRow(8);
    lh.appendChild(kit.header('Rules'));
    lh.appendChild(kit.text('first match wins', { color: c.dim }));
    lh.appendChild(el('div', { flexGrow: '1' }));
    lh.appendChild(tag(kit.button('+ Rule', () => { p.loot.push({ label: 'New rule', action: 'keep', match: { name: '' } }); this.lootIndex = p.loot.length - 1; touch(); }), { automation: 'add-loot' }));
    left.appendChild(lh);
    const lb = kit.box();
    const ll = col(1);
    ll.style.padding = '3px';
    const badgeColor = (a: LootAction) => (a === 'sell' ? c.gold : a === 'salvage' ? c.warn : a === 'ignore' ? c.dim : c.good);
    p.loot.forEach((r, i) => {
      const row = kit.row(i === this.lootIndex, () => { this.lootIndex = i; this.tryResult = ''; view(); });
      tag(row, { automationLoot: String(i) });
      row.appendChild(kit.text(`${i + 1}`, { color: c.dim }));
      row.appendChild(kit.text(r.action === 'keep-up-to' ? `Keep ${r.count ?? 1}` : LOOT_ACTIONS.find((x) => x.value === r.action)?.label ?? r.action, { color: badgeColor(r.action) }));
      row.appendChild(grow(kit.text(r.label ?? '(unnamed)', { color: r.disabled || r.match.unsupported ? c.dim : c.text, maxWidth: 200 })));
      if (r.disabled || r.match.unsupported) row.appendChild(kit.text('off', { color: c.warn }));
      ll.appendChild(row);
    });
    lb.appendChild(ll);
    left.appendChild(lb);
    left.appendChild(kit.text('Anything no rule matches is left on the corpse.', { color: c.dim, maxWidth: 320 }));
    const r = p.loot[this.lootIndex];
    if (r) {
      const hd = flexRow(8);
      hd.appendChild(kit.header('Rule'));
      hd.appendChild(tag(kit.input(r.label ?? '', 220, (v) => { r.label = v.trim() || undefined; this.dirty = true; }), { automationField: 'label' }));
      hd.appendChild(el('div', { flexGrow: '1' }));
      if (this.lootIndex > 0) hd.appendChild(kit.button('Up', () => { p.loot.splice(this.lootIndex - 1, 0, ...p.loot.splice(this.lootIndex, 1)); this.lootIndex--; touch(); }));
      hd.appendChild(tag(kit.button('Delete', () => { p.loot.splice(this.lootIndex, 1); this.lootIndex = Math.max(0, this.lootIndex - 1); touch(); }, { variant: 'red' }), { automation: 'loot-remove' }));
      right.appendChild(hd);
      const box = kit.box();
      const b = col(8);
      b.style.padding = '10px';
      const ar = flexRow(8);
      ar.appendChild(tag(kit.check(!r.disabled, (v) => { if (v) delete r.disabled; else r.disabled = true; touch(); }), { automation: 'loot-on' }));
      ar.appendChild(kit.text('Action', { color: c.dim }));
      ar.appendChild(tag(kit.field(LOOT_ACTIONS.find((x) => x.value === r.action)?.label ?? r.action, (a) => kit.menu(a, LOOT_ACTIONS.map((x) => ({ label: x.label, value: x.value })), (v) => {
        r.action = v as LootAction;
        if (v === 'keep-up-to') r.count = r.count ?? 5; else delete r.count;
        touch();
      }), 120), { automationField: 'action' }));
      if (r.action === 'keep-up-to') { ar.appendChild(kit.text('count', { color: c.dim })); ar.appendChild(kit.input(String(r.count ?? 5), 44, (v) => { r.count = Number(v) || 1; this.dirty = true; })); }
      b.appendChild(ar);
      b.appendChild(kit.text('The item must match all of', { color: c.gold }));
      const used = LOOT_REQS.filter((q) => r.match[q.key] !== undefined);
      for (const q of used) {
        const qr = flexRow(8);
        tag(qr, { requirement: q.key });
        qr.appendChild(kit.text(q.label, { color: c.text }));
        qr.appendChild(kit.text(q.op, { color: c.dim }));
        if (q.type === 'types') {
          const cur = (r.match.types ?? [])[0] ?? '';
          qr.appendChild(tag(kit.field(cur || '—', (a) => kit.menu(a, ITEM_TYPES.map((t) => ({ label: t, value: t })), (v) => { r.match.types = [v]; touch(); }), 150), { automationField: 'types' }));
        } else {
          const v = r.match[q.key];
          qr.appendChild(tag(kit.input(v === undefined ? '' : String(v), q.type === 'number' ? 70 : 180, (nv) => {
            const t = nv.trim();
            (r.match as Record<string, unknown>)[q.key] = q.type === 'number' ? (t === '' ? 0 : Number(t)) : t;
            this.dirty = true;
          }), { automationField: q.key }));
        }
        qr.appendChild(kit.button('x', () => { delete r.match[q.key]; touch(); }, { width: 32 }));
        b.appendChild(qr);
      }
      for (const x of lootExtraLines(r.match)) {
        const xr = flexRow(8);
        tag(xr, { requirement: x.key });
        xr.appendChild(grow(kit.text(x.text, { color: c.text, maxWidth: w - 400 })));
        xr.appendChild(kit.button('x', () => {
          const list = r.match[x.key];
          if (Array.isArray(list)) { list.splice(x.index, 1); if (!list.length) delete r.match[x.key]; } else delete r.match[x.key];
          touch();
        }, { width: 32 }));
        b.appendChild(xr);
      }
      if (r.match.unsupported) b.appendChild(kit.text(`Can't test: ${r.match.unsupported}`, { color: c.warn, maxWidth: w - 360 }));
      if (r.note) b.appendChild(kit.text(r.note, { color: c.warn, maxWidth: w - 360 }));
      const free = LOOT_REQS.filter((q) => r.match[q.key] === undefined);
      if (free.length) b.appendChild(tag(kit.field('+ Requirement', (a) => kit.menu(a, free.map((q) => ({ label: `${q.label} ${q.op}`, value: q.key })), (v) => {
        const q = LOOT_REQS.find((x) => x.key === v)!;
        (r.match as Record<string, unknown>)[v] = q.type === 'number' ? 0 : q.type === 'types' ? ['Gem'] : '';
        touch();
      }), 150), { automation: 'add-requirement' }));
      box.appendChild(b);
      right.appendChild(box);
      // Try it on something you carry.
      right.appendChild(kit.header('Try it'));
      const tb = kit.box();
      const tr = flexRow(10, true);
      tr.style.padding = '10px';
      const items = this.source.items();
      tr.appendChild(tag(kit.field('Pick an item you carry', (a) => kit.menu(a, items.map((it, k) => ({ label: it.name, value: String(k), hint: it.value !== undefined ? `${it.value.toLocaleString('en-US')}p` : undefined })), (v) => {
        const it = items[Number(v)];
        const hit = firstLootRule(p.loot, it);
        this.tryResult = hit ? `${it.name} → ${LOOT_ACTIONS.find((x) => x.value === hit.rule.action)?.label}, matched rule ${hit.index + 1}` : `${it.name} → left on the corpse (no rule matches)`;
        touch();
      }, { search: true, width: 260 }), 200), { automation: 'try-it' }));
      tr.appendChild(tag(kit.text(this.tryResult || 'Shows which rule an item would match.', { color: this.tryResult ? c.text : c.dim, maxWidth: Math.max(160, w - 600) }), { automation: 'try-result' }));
      tb.appendChild(tr);
      right.appendChild(tb);
    }
    kit.scroll(rightBox);
  }

  // ── Buffs ──

  private renderBuffs(area: HTMLElement, p: RoutineProfile, w: number, h: number, touch: () => void, view: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    const { left, right, rightBox } = this.split(area, w, h, 220);
    left.appendChild(kit.header('Buff sets'));
    const lb = kit.box();
    const ll = col(1);
    ll.style.padding = '3px';
    p.buffSets.forEach((b, i) => {
      const r = kit.row(i === this.buffIndex, () => { this.buffIndex = i; view(); });
      tag(r, { automationBuffset: String(i) });
      r.appendChild(grow(kit.text(b.name, { color: c.text })));
      r.appendChild(kit.text(String(b.spells.length), { color: c.dim }));
      ll.appendChild(r);
    });
    lb.appendChild(ll);
    left.appendChild(lb);
    left.appendChild(tag(kit.button('+ New set', () => {
      let n = 1;
      while (p.buffSets.some((b) => b.name === `Set ${n}`)) n++;
      p.buffSets.push({ name: `Set ${n}`, spells: [], rebuffBelowSeconds: 120 });
      this.buffIndex = p.buffSets.length - 1;
      touch();
    }), { automation: 'add-buffset' }));
    const b: BuffSet | undefined = p.buffSets[this.buffIndex];
    if (b) {
      const hd = flexRow(8);
      hd.appendChild(kit.header('Set'));
      hd.appendChild(kit.input(b.name, 160, (v) => {
        const nv = v.trim();
        if (!nv || p.buffSets.some((x) => x !== b && x.name === nv)) return;
        for (const st of p.states) for (const r of st.rules) for (const a of r.do) if (a.kind === 'cast-buffs' && a.set === b.name) a.set = nv;
        b.name = nv; this.dirty = true;
      }));
      hd.appendChild(kit.text('Cast in this order.', { color: c.dim }));
      hd.appendChild(el('div', { flexGrow: '1' }));
      hd.appendChild(kit.button('Delete', () => { p.buffSets.splice(this.buffIndex, 1); this.buffIndex = 0; touch(); }, { variant: 'red' }));
      right.appendChild(hd);
      const box = kit.box();
      const t = col(1);
      t.style.padding = '6px';
      const th = flexRow(8);
      th.appendChild(grow(kit.header('Spell')));
      th.appendChild(kit.header('Left'));
      t.appendChild(th);
      const active = this.source.buffs();
      b.spells.forEach((s, si) => {
        const r = flexRow(8);
        tag(r, { spell: String(si) });
        const f = kit.input(s.spell, 240, (v) => { s.spell = v.trim(); this.dirty = true; });
        f.dataset.automationField = 'spell';
        r.appendChild(f);
        r.appendChild(el('div', { flexGrow: '1' }));
        const on = active.find((x) => x.name.toLowerCase() === s.spell.toLowerCase());
        r.appendChild(kit.text(on ? fmtSpan(on.remaining * 1000) : 'missing', { color: on && on.remaining > (b.rebuffBelowSeconds ?? 60) ? c.text : c.warn }));
        if (si > 0) r.appendChild(kit.button('Up', () => { b.spells.splice(si - 1, 0, ...b.spells.splice(si, 1)); touch(); }, { width: 44 }));
        r.appendChild(kit.button('x', () => { b.spells.splice(si, 1); touch(); }, { width: 32 }));
        t.appendChild(r);
      });
      box.appendChild(t);
      right.appendChild(box);
      const add = flexRow(8);
      const known = this.source.spells();
      add.appendChild(tag(kit.field('+ Spell from my spellbook', (a) => kit.menu(a, known.map((k) => ({ label: k.name, value: k.name, hint: k.school })), (v) => { b.spells.push({ spell: v }); touch(); }, { search: true, width: 300 }), 220), { automation: 'add-spell' }));
      add.appendChild(kit.button('+ Spell by name', () => { b.spells.push({ spell: '' }); touch(); }));
      right.appendChild(add);
      const when = flexRow(8);
      when.appendChild(kit.text('Rebuff when a spell has less than', { color: c.dim }));
      when.appendChild(tag(kit.input(String(b.rebuffBelowSeconds ?? 60), 50, (v) => { b.rebuffBelowSeconds = Number(v) || 0; this.dirty = true; }), { automationField: 'rebuff' }));
      when.appendChild(kit.text('seconds left', { color: c.dim }));
      right.appendChild(when);
    }
    kit.scroll(rightBox);
  }

  // ── Routes ──

  private renderRoutes(area: HTMLElement, p: RoutineProfile, w: number, h: number, touch: () => void, view: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    const { left, right, rightBox } = this.split(area, w, h, 220);
    left.appendChild(kit.header('Routes'));
    const lb = kit.box();
    const ll = col(1);
    ll.style.padding = '3px';
    p.routes.forEach((r, i) => {
      const row = kit.row(i === this.routeIndex, () => { this.routeIndex = i; view(); });
      tag(row, { automationRoute: String(i) });
      row.appendChild(grow(kit.text(r.name, { color: c.text })));
      row.appendChild(kit.text(`${r.points.length}`, { color: c.dim }));
      ll.appendChild(row);
    });
    lb.appendChild(ll);
    left.appendChild(lb);
    left.appendChild(tag(kit.button('+ New route', () => {
      let n = 1;
      while (p.routes.some((r) => r.name === `Route ${n}`)) n++;
      p.routes.push({ name: `Route ${n}`, mode: 'circular', points: [] });
      this.routeIndex = p.routes.length - 1;
      touch();
    }), { automation: 'add-route' }));
    const r: Route | undefined = p.routes[this.routeIndex];
    if (r) {
      const hd = flexRow(8);
      hd.appendChild(kit.header('Route'));
      hd.appendChild(kit.input(r.name, 160, (v) => {
        const nv = v.trim();
        if (!nv || p.routes.some((x) => x !== r && x.name === nv)) return;
        for (const st of p.states) for (const ru of st.rules) for (const a of ru.do) if (a.kind === 'follow-route' && a.route === r.name) a.route = nv;
        r.name = nv; this.dirty = true;
      }));
      hd.appendChild(tag(kit.field(r.mode, (a) => kit.menu(a, [{ label: 'circular', value: 'circular', hint: 'loops' }, { label: 'linear', value: 'linear', hint: 'back and forth' }, { label: 'once', value: 'once', hint: 'to the end' }], (v) => { r.mode = v as Route['mode']; touch(); }), 100), { automationField: 'mode' }));
      hd.appendChild(el('div', { flexGrow: '1' }));
      hd.appendChild(kit.button('Delete', () => { p.routes.splice(this.routeIndex, 1); this.routeIndex = 0; touch(); }, { variant: 'red' }));
      right.appendChild(hd);
      if (r.note) right.appendChild(kit.text(r.note, { color: c.warn, maxWidth: w - 250 }));
      const box = kit.box();
      const t = col(2);
      t.style.padding = '6px';
      r.points.forEach((pt, pi) => {
        const row = flexRow(8);
        row.appendChild(kit.text(`${pi + 1}.`, { color: c.dim }));
        row.appendChild(kit.input(pt, 160, (v) => { r.points[pi] = v.trim(); this.dirty = true; }));
        row.appendChild(kit.button('x', () => { r.points.splice(pi, 1); r.z?.splice(pi, 1); touch(); }, { width: 32 }));
        t.appendChild(row);
      });
      if (!r.points.length) t.appendChild(kit.text('No points yet.', { color: c.dim }));
      box.appendChild(t);
      right.appendChild(box);
      right.appendChild(tag(kit.button('Add where I stand', () => {
        const here = this.source.coords();
        if (!here) { this.note = 'Your position is not known yet.'; touch(); return; }
        r.points.push(here);
        r.z?.push(null); // heights stay one per point (a point recorded here has none)
        touch();
      }), { automation: 'add-point' }));
    }
    kit.scroll(rightBox);
  }

  explain(): string { const p = this.profile(); return p ? explainProfile(p) : ''; }
}

/** The first loot rule that matches an item (Try it), with its index. */
function firstLootRule(rules: LootRule[], item: { name: string; type?: string; value?: number; burden?: number }): { rule: LootRule; index: number } | null {
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const m = r.match;
    if (r.disabled || m.unsupported) continue;
    if (m.name && !new RegExp(m.name, 'i').test(item.name)) continue;
    const norm = (t: string) => t.replace(/\s+/g, '').toLowerCase();
    if (m.types?.length && !(item.type && m.types.some((t) => norm(t) === norm(item.type!)))) continue;
    if (m.valueAtLeast !== undefined && !(item.value !== undefined && item.value >= m.valueAtLeast)) continue;
    if (m.valueAtMost !== undefined && !(item.value !== undefined && item.value <= m.valueAtMost)) continue;
    if (m.burdenAtMost !== undefined && !(item.burden !== undefined && item.burden <= m.burdenAtMost)) continue;
    // Needs the item examined, or you (level, skills, pack): Try it only knows what the pack shows.
    if (m.appraisal || m.props?.length || m.palettes?.length || m.colours?.length || m.descFlags !== undefined || m.spells || m.moreSpells?.length || m.spellCountAtLeast !== undefined || m.minDamageAtLeast !== undefined || m.totalRatingsAtLeast !== undefined) continue;
    if (m.freeSlotsAtLeast !== undefined || m.characterLevelAtLeast !== undefined || m.characterLevelAtMost !== undefined || m.characterSkills?.length) continue;
    return { rule: r, index: i };
  }
  return null;
}

export function blankDoc(server: string, account: string): RoutineDoc { return emptyRoutineDoc(server, account); }
