/**
 * BUG.routine-settings-reset — two copies of one account's routines (two tabs, two devices) each save the
 * whole document. Before this, the later save put back every value the other copy had changed since it
 * loaded: an edit on the phone undid the desktop's settings ("the settings reset constantly").
 *
 * mergeRoutineDocs is a three-way merge: `base` is the stored document this page's edits started from,
 * `mine` this page's document now, `theirs` what is stored now. A value only one side changed keeps that
 * change; a value both changed differently takes this page's (the newest action). Objects (a profile's
 * settings, modules, loot sets, `characters`) merge key by key; lists of named entries (profiles, states,
 * routes) merge entry by entry by name; any other list (rules, waypoints, loot rules) is one value.
 */
import type { RoutineDoc } from './RoutineDoc.js';

type Json = unknown;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** JSON with object keys sorted, so two equal values compare equal whatever order their keys were written in. */
function canon(v: Json): string {
  if (v === undefined) return 'undefined';
  return JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
}
const same = (a: Json, b: Json): boolean => a === b || canon(a) === canon(b);

/** A list whose entries are all objects with distinct string names (profiles, states, routes). */
function namedList(v: Json): v is Array<Record<string, unknown> & { name: string }> {
  if (!Array.isArray(v)) return false;
  const seen = new Set<string>();
  for (const e of v) {
    if (!isObj(e) || typeof e.name !== 'string' || seen.has(e.name)) return false;
    seen.add(e.name);
  }
  return true;
}

function merge3(base: Json, mine: Json, theirs: Json): Json {
  if (same(mine, theirs)) return mine;
  if (same(mine, base)) return theirs;
  if (same(theirs, base)) return mine;
  if (isObj(mine) && isObj(theirs)) {
    const b = isObj(base) ? base : {};
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(b)])) {
      const v = merge3(b[k], mine[k], theirs[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (namedList(mine) && namedList(theirs) && (base === undefined || namedList(base))) {
    const by = (l: Array<{ name: string }>) => new Map(l.map((e) => [e.name, e]));
    const b = by((base as Array<{ name: string }> | undefined) ?? []);
    const m = by(mine);
    const t = by(theirs);
    // This page's order, then entries only the other copy added, in its order.
    const names = [...mine.map((e) => e.name), ...theirs.map((e) => e.name).filter((n) => !m.has(n))];
    const out: unknown[] = [];
    for (const n of names) {
      const v = merge3(b.get(n), m.get(n), t.get(n));
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  return mine;
}

/**
 * `mine` with what changed in `theirs` since `base` (see above). A character's starting or last-chosen
 * profile that no longer exists is dropped, so the result is a document the store accepts. A new object:
 * none of the three is changed.
 */
export function mergeRoutineDocs(base: RoutineDoc, mine: RoutineDoc, theirs: RoutineDoc): RoutineDoc {
  const out = structuredClone(merge3(base, mine, theirs)) as RoutineDoc;
  const names = new Set((Array.isArray(out.profiles) ? out.profiles : []).map((p) => p?.name));
  for (const k of ['characters', 'selected'] as const) {
    const m = out[k];
    if (!isObj(m)) continue;
    for (const [ch, p] of Object.entries(m)) if (!names.has(p)) delete m[ch];
  }
  return out;
}

/**
 * The profile a character's window shows when the document loads: the one it last chose, else the one it
 * starts with (Mine only), else the first. Only a profile that exists. VirindiTank kept a character's choices
 * across logins (docs/vtank-macro-behavior.md §2: only [Default] "resets on logout"; "at login, if no loot
 * profile is set"); before 2026-11-17 ours forgot a pick from the dropdown, so the next login showed the
 * first profile's settings instead, which read as the settings resetting (BUG.routine-settings-reset).
 */
export function startingProfile(doc: RoutineDoc, character: string | null): string | null {
  const has = (n: string | undefined): n is string => !!n && doc.profiles.some((p) => p.name === n);
  if (character) {
    const last = doc.selected?.[character];
    if (has(last)) return last;
    const mine = doc.characters?.[character];
    if (has(mine)) return mine;
  }
  return doc.profiles[0]?.name ?? null;
}
