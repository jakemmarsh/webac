/**
 * BUG.routine-partial-profile-crash (2026-11-09) — a routine profile as the engine and the windows read it, complete.
 *
 * Every write of a routine document is validated (validateRoutineDoc: the bridge's store, the browser store, the
 * VirindiTank window's import), but nothing checked what came back: the bridge's file and the browser's copy are
 * parsed and used as they are, and a relay call hands the engine whatever profile it carries. A Seedsow player's
 * running macro had a profile with no `states`, and RoutineEngine.tick threw out of the page's frame loop every
 * tick: `p.states.find` in dryRun, then (once the character died) `p.states.some` in usesCondition.
 *
 * normalizeRoutineProfile gives every list the engine walks a list, and every object it reads an object, at the
 * boundary where a profile comes in (RoutineSync's load and check, RoutineEngine's start / update / dryRun / stand-by
 * profile), so the engine needs no guards of its own. A complete profile comes back as the same object (nothing is
 * copied); a part that had to be filled is a new object, and the stored document is not touched. What can't be
 * filled sensibly is switched off with a note saying why, never guessed: a rule with no usable conditions would
 * otherwise fire every step.
 */
import { ALL_MODULES_OFF, type BuffSet, type LootRule, type Route, type RoutineAction, type RoutineCondition, type RoutineDoc, type RoutineProfile, type RoutineRule, type RoutineState } from './RoutineDoc.js';
import { VT_DEFAULT_MONSTER, type VtankProfileData } from './vtankProfile.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** `list` mapped through `f` (elements `f` drops return null); the same array when nothing changed. */
function mapList<T>(list: unknown, f: (x: unknown) => T | null): T[] {
  if (!Array.isArray(list)) return [];
  let changed = false;
  const out: T[] = [];
  for (const x of list) {
    const y = f(x);
    if (y !== x) changed = true;
    if (y !== null) out.push(y);
  }
  return changed ? out : list as T[];
}

/** A condition the engine can check, or null (not an object, no kind, or an any / all / not without its parts). */
function conditionOk(c: unknown): c is RoutineCondition {
  if (!isObj(c) || !isStr(c.kind)) return false;
  if (c.kind === 'not') return conditionOk(c.condition);
  if (c.kind === 'any' || c.kind === 'all') return Array.isArray(c.conditions) && c.conditions.every(conditionOk);
  if ('names' in c && c.names !== undefined && !(Array.isArray(c.names) && c.names.every(isStr))) return false;
  return true;
}

function normalizeRule(r: unknown, i: number): RoutineRule | null {
  if (!isObj(r)) return null;
  const when = Array.isArray(r.when) ? r.when : [];
  const doList = mapList<RoutineAction>(r.do, (a) => (isObj(a) && isStr(a.kind) ? a as unknown as RoutineAction : null));
  const whenOk = when.length > 0 && when.every(conditionOk);
  if (whenOk && doList === r.do) return r as unknown as RoutineRule;
  const out = { ...r, when: whenOk ? when : [{ kind: 'always' }], do: doList } as unknown as RoutineRule;
  if (!whenOk) {
    // No conditions would hold "always": switched off rather than firing every step.
    out.disabled = true;
    out.note = `switched off: rule ${i + 1}'s conditions were missing or unreadable when it was loaded`;
  }
  return out;
}

function normalizeState(s: unknown, i: number): RoutineState | null {
  if (!isObj(s)) return null;
  const name = isStr(s.name) ? s.name : `State ${i + 1}`;
  let at = 0;
  const rules = mapList<RoutineRule>(s.rules, (r) => normalizeRule(r, at++));
  if (name === s.name && rules === s.rules) return s as unknown as RoutineState;
  return { ...s, name, rules } as RoutineState;
}

function normalizeLootRule(l: unknown): LootRule | null {
  if (!isObj(l)) return null;
  if (isObj(l.match) && isStr(l.action)) return l as unknown as LootRule;
  // A rule with nothing to match never matches (lootRuleFor skips switched-off rules).
  return { ...l, action: isStr(l.action) ? l.action : 'keep', match: isObj(l.match) ? l.match : {}, disabled: true, note: 'switched off: stored without what it matches' } as unknown as LootRule;
}

const lootList = (v: unknown): LootRule[] => mapList(v, normalizeLootRule);

function normalizeRoute(r: unknown, i: number): Route | null {
  if (!isObj(r)) return null;
  const name = isStr(r.name) ? r.name : `Route ${i + 1}`;
  const mode = r.mode === 'circular' || r.mode === 'linear' || r.mode === 'once' || r.mode === 'follow' ? r.mode : 'circular';
  const points = mapList<string>(r.points, (p) => (isStr(p) ? p : null));
  const stops = r.stops === undefined ? undefined : mapList<{ at: number; do: RoutineAction[] }>(r.stops, (s) => {
    if (!isObj(s) || typeof s.at !== 'number') return null;
    const d = mapList<RoutineAction>(s.do, (a) => (isObj(a) && isStr(a.kind) ? a as unknown as RoutineAction : null));
    return d === s.do ? s as { at: number; do: RoutineAction[] } : { ...s, at: s.at, do: d };
  });
  if (name === r.name && mode === r.mode && points === r.points && stops === r.stops) return r as unknown as Route;
  const out = { ...r, name, mode, points } as unknown as Route;
  if (stops === undefined) delete out.stops; else out.stops = stops;
  return out;
}

function normalizeBuffSet(b: unknown): BuffSet | null {
  if (!isObj(b) || !isStr(b.name)) return null;
  const spells = mapList<BuffSet['spells'][number]>(b.spells, (s) => (isObj(s) && isStr(s.spell) ? s as BuffSet['spells'][number] : null));
  return spells === b.spells ? b as unknown as BuffSet : { ...b, name: b.name, spells } as BuffSet;
}

function normalizeVtank(v: unknown): VtankProfileData | undefined {
  if (!isObj(v)) return undefined;
  const names = (k: string) => mapList<string>(v[k], (x) => (isStr(x) ? x : null));
  let monsters = mapList<VtankProfileData['monsters'][number]>(v.monsters, (m) => (isObj(m) && isStr(m.name) ? m as unknown as VtankProfileData['monsters'][number] : null));
  if (!monsters.length) monsters = [structuredClone(VT_DEFAULT_MONSTER)];
  const items = mapList<VtankProfileData['items'][number]>(v.items, (x) => (isObj(x) && isStr(x.name) ? x as unknown as VtankProfileData['items'][number] : null));
  const out = {
    ...v, monsters, items, consumables: names('consumables'), excludedScarabs: names('excludedScarabs'),
    extraBuffs: names('extraBuffs'), blacklistedBuffs: names('blacklistedBuffs'),
  } as unknown as VtankProfileData;
  const same = (Object.keys(out) as Array<keyof VtankProfileData>).every((k) => out[k] === v[k]);
  return same ? v as unknown as VtankProfileData : out;
}

/**
 * `raw` as a complete RoutineProfile: the same object when it already is one. Lists the engine walks that are
 * missing become empty lists (a profile with no states gets one empty state named for its initialState, as
 * VirindiTank's Default), module switches that are missing are off, an initialState that names no state becomes
 * the first state's, and a rule whose conditions are missing or unreadable is switched off with a note.
 */
export function normalizeRoutineProfile(raw: unknown): RoutineProfile {
  const p: Record<string, unknown> = isObj(raw) ? raw : {};
  const name = isStr(p.name) && p.name ? p.name : 'Routine';
  const given = isObj(p.modules) ? p.modules : {};
  const modulesOk = isObj(p.modules) && (Object.keys(ALL_MODULES_OFF) as Array<keyof typeof ALL_MODULES_OFF>).every((m) => typeof given[m] === 'boolean');
  const modules = modulesOk ? p.modules as RoutineProfile['modules']
    : Object.fromEntries(Object.keys(ALL_MODULES_OFF).map((m) => [m, given[m] === true])) as RoutineProfile['modules'];
  let at = 0;
  let states = mapList<RoutineState>(p.states, (s) => normalizeState(s, at++));
  if (!Array.isArray(p.states)) states = [{ name: isStr(p.initialState) && p.initialState ? p.initialState : 'Default', rules: [] }];
  const initialState = isStr(p.initialState) && (!states.length || states.some((s) => s.name === p.initialState)) ? p.initialState : states[0]?.name ?? 'Default';
  const loot = lootList(p.loot);
  let rn = 0;
  const routes = mapList<Route>(p.routes, (r) => normalizeRoute(r, rn++));
  const buffSets = mapList<BuffSet>(p.buffSets, normalizeBuffSet);
  let lootSets = p.lootSets as RoutineProfile['lootSets'];
  if (p.lootSets !== undefined) {
    if (!isObj(p.lootSets)) lootSets = undefined;
    else {
      const sets: Record<string, LootRule[]> = {};
      let changed = false;
      for (const [k, v] of Object.entries(p.lootSets)) { sets[k] = lootList(v); if (sets[k] !== v) changed = true; }
      lootSets = changed ? sets : p.lootSets as Record<string, LootRule[]>;
    }
  }
  const vtank = p.vtank === undefined ? undefined : normalizeVtank(p.vtank);
  const settings = p.settings === undefined || isObj(p.settings) ? p.settings : undefined;
  const ruleFiring = p.ruleFiring === undefined || p.ruleFiring === 'repeat' || p.ruleFiring === 'once' ? p.ruleFiring : undefined;
  const same = raw === p && name === p.name && modules === p.modules && states === p.states && initialState === p.initialState && loot === p.loot
    && routes === p.routes && buffSets === p.buffSets && lootSets === p.lootSets && vtank === p.vtank && settings === p.settings && ruleFiring === p.ruleFiring;
  if (same) return p as unknown as RoutineProfile;
  const out = { ...p, name, modules, initialState, states, loot, routes, buffSets } as unknown as RoutineProfile;
  for (const [k, v] of [['lootSets', lootSets], ['vtank', vtank], ['settings', settings], ['ruleFiring', ruleFiring]] as const) {
    if (v === undefined) delete (out as unknown as Record<string, unknown>)[k]; else (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * A loaded routine document with every profile complete (normalizeRoutineProfile), in place: `profiles` becomes a
 * list (non-object entries dropped) and `characters` an object. Returns how many profiles had to be filled in.
 * Anything that isn't an object is left alone (the caller's own check says so).
 */
export function normalizeRoutineDoc(doc: unknown): number {
  if (!isObj(doc)) return 0;
  const d = doc as unknown as RoutineDoc & Record<string, unknown>;
  let fixed = 0;
  if (!Array.isArray(d.profiles)) { d.profiles = []; fixed++; }
  const list = d.profiles as unknown[];
  for (let i = list.length - 1; i >= 0; i--) {
    if (!isObj(list[i])) { list.splice(i, 1); fixed++; continue; }
    const n = normalizeRoutineProfile(list[i]);
    if (n !== list[i]) { list[i] = n; fixed++; }
  }
  if (d.characters !== undefined && !isObj(d.characters)) { delete d.characters; fixed++; }
  return fixed;
}
