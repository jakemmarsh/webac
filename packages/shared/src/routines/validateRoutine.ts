/**
 * Validation and plain-language explanation of a RoutineDoc. The validator
 * reports every problem with its path (`profiles[0].states[1].rules[2].do[0]`),
 * so whoever wrote the document — the editor, an importer, or Claude —
 * can fix it before the engine ever sees it.
 */
import { VT_MONSTER_COLUMNS } from './vtankProfile.js';
import {
  ROUTINE_SCHEMA_VERSION, type RoutineAction, type RoutineCondition, type RoutineDoc, type RoutineProfile,
} from './RoutineDoc.js';

export interface RoutineIssue { path: string; message: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown, min = -Infinity, max = Infinity): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

const COORDS = /^\s*\d+(\.\d+)?\s*[NS]\s*[, ]\s*\d+(\.\d+)?\s*[EW]\s*$/i;
const VITALS = ['health', 'stamina', 'mana'];
const LOOT_ACTIONS = ['keep', 'keep-up-to', 'salvage', 'sell', 'read', 'ignore'];
const MODULES = ['buffs', 'vitals', 'combat', 'looting', 'navigation', 'inventory', 'service'];

function regexOk(p: string): boolean {
  try { new RegExp(p, 'i'); return true; } catch { return false; }
}

/** A .utl SalvageCombine block (RoutineDoc SalvageCombine): band strings, material keys as ACE MaterialType ids. */
function checkSalvageCombine(v: unknown, path: string, out: RoutineIssue[]): void {
  if (!isObj(v)) { out.push({ path, message: 'must be { "default": "1-6, 7-8, 9, 10", "materials": { "<material id>": "<bands>" } }' }); return; }
  const bandsOk = (b: unknown): boolean => typeof b === 'string' && /^[\d\s.,;-]*$/.test(b);
  if (!bandsOk(v.default)) out.push({ path: `${path}.default`, message: 'must be workmanship bands like "1-6, 7-8, 9, 10"' });
  if (v.materials !== undefined) {
    if (!isObj(v.materials)) out.push({ path: `${path}.materials`, message: 'must map material ids to bands' });
    else for (const [k, b] of Object.entries(v.materials)) {
      if (!/^\d+$/.test(k)) out.push({ path: `${path}.materials.${k}`, message: 'the key must be a material id (ACE MaterialType)' });
      else if (!bandsOk(b)) out.push({ path: `${path}.materials.${k}`, message: 'must be workmanship bands like "1-10"' });
    }
  }
  if (v.valueModes !== undefined) {
    if (!isObj(v.valueModes)) out.push({ path: `${path}.valueModes`, message: 'must map material ids to a pyreal value' });
    else for (const [k, n] of Object.entries(v.valueModes)) if (!/^\d+$/.test(k) || !isNum(n, 0)) out.push({ path: `${path}.valueModes.${k}`, message: 'a material id → a pyreal value ≥ 0' });
  }
}

/** VirindiTank's Monsters / Items / Consumables / Buffs tabs (vtankProfile.ts). */
function checkVtank(v: unknown, path: string, out: RoutineIssue[]): void {
  if (!isObj(v)) { out.push({ path, message: 'must be an object' }); return; }
  const strs = (k: string) => { if (!Array.isArray(v[k]) || !(v[k] as unknown[]).every(isStr)) out.push({ path: `${path}.${k}`, message: 'must be a list of names' }); };
  strs('consumables'); strs('excludedScarabs'); strs('extraBuffs'); strs('blacklistedBuffs');
  if (!Array.isArray(v.items) || !v.items.every((x) => isObj(x) && isStr(x.name))) out.push({ path: `${path}.items`, message: 'must be a list of { "name": … }' });
  else v.items.forEach((x: Record<string, unknown>, i: number) => {
    if (x.id !== undefined && !isNum(x.id, 0)) out.push({ path: `${path}.items[${i}].id`, message: 'must be an object id' });
    if (x.hands !== undefined && x.hands !== 1 && x.hands !== 2) out.push({ path: `${path}.items[${i}].hands`, message: 'must be 1 or 2 (unset: Auto)' });
  });
  if (!Array.isArray(v.monsters) || !v.monsters.length) { out.push({ path: `${path}.monsters`, message: 'needs the <DEFAULT> row first' }); return; }
  v.monsters.forEach((m: unknown, i: number) => {
    const mp = `${path}.monsters[${i}]`;
    if (!isObj(m) || !isStr(m.name)) { out.push({ path: mp, message: 'a monster row needs a name' }); return; }
    if (!isNum(m.priority, -1, 4)) out.push({ path: `${mp}.priority`, message: 'must be -1..4' });
    if (!Array.isArray(m.on) || !m.on.every((c) => (VT_MONSTER_COLUMNS as readonly string[]).includes(String(c)))) out.push({ path: `${mp}.on`, message: `columns are ${VT_MONSTER_COLUMNS.join(' ')}` });
    for (const k of ['damage', 'exVuln', 'petDamage']) if (!isNum(m[k], 0)) out.push({ path: `${mp}.${k}`, message: 'must be a damage type number' });
    for (const k of ['weapon', 'offhand']) if (m[k] !== null && !isStr(m[k])) out.push({ path: `${mp}.${k}`, message: 'must be an item name or null (<AUTO>)' });
    for (const k of ['weaponId', 'offhandId']) if (m[k] !== undefined && !isNum(m[k], 0)) out.push({ path: `${mp}.${k}`, message: 'must be an object id' });
  });
  if (isObj(v.monsters[0]) && v.monsters[0].name !== '<DEFAULT>') out.push({ path: `${path}.monsters[0].name`, message: 'the first row is <DEFAULT>' });
  // A .usd's GemFoodItems and what the import kept (vtankUsd.ts).
  if (v.gemFood !== undefined && (!Array.isArray(v.gemFood) || !v.gemFood.every((g) => isObj(g) && isStr(g.name) && isNum(g.spell)))) out.push({ path: `${path}.gemFood`, message: 'must be a list of { "name": …, "spell": spell id }' });
  if (v.usd !== undefined && !isObj(v.usd)) out.push({ path: `${path}.usd`, message: 'must be an object (what a .usd import kept)' });
}

function checkCondition(c: unknown, path: string, out: RoutineIssue[]): void {
  if (!isObj(c)) { out.push({ path, message: 'condition must be an object with a kind' }); return; }
  const k = c.kind;
  const bad = (m: string): void => { out.push({ path, message: `${String(k)}: ${m}` }); };
  switch (k) {
    case 'always': return;
    case 'vital-below': case 'vital-above':
      if (!VITALS.includes(String(c.vital))) bad('vital must be health, stamina or mana');
      if (!isNum(c.percent, 0, 100)) bad('percent must be 0..100');
      return;
    case 'monster-within': case 'no-monster-within':
      if (!isNum(c.meters, 0, 500)) bad('meters must be 0..500');
      if (c.names !== undefined && (!Array.isArray(c.names) || !c.names.every(isStr))) bad('names must be a list of names');
      return;
    case 'buff-missing': if (!isStr(c.spell)) bad('spell is required'); return;
    case 'free-slots-below': if (!isNum(c.slots, 0, 102)) bad('slots must be 0..102'); return;
    case 'item-count-below':
      if (!isStr(c.item)) bad('item is required');
      if (!isNum(c.count, 0)) bad('count must be ≥ 0');
      return;
    case 'burden-above': if (!isNum(c.percent, 0, 500)) bad('percent must be 0..500'); return;
    case 'chat-matches': if (!isStr(c.pattern) || !regexOk(c.pattern)) bad('pattern must be a valid regex'); return;
    case 'near':
      if (!isStr(c.coords) || !COORDS.test(c.coords)) bad('coords must look like "42.1N, 33.6E"');
      if (!isNum(c.meters, 0, 5000)) bad('meters must be 0..5000');
      return;
    case 'seconds-in-state': if (!isNum(c.seconds, 0)) bad('seconds must be ≥ 0'); return;
    case 'unassigned-xp-above': if (!isNum(c.xp, 0)) bad('xp must be ≥ 0'); return;
    case 'not': checkCondition(c.condition, `${path}.condition`, out); return;
    case 'any': case 'all':
      if (!Array.isArray(c.conditions)) { bad('conditions must be a list'); return; }
      c.conditions.forEach((x, i) => checkCondition(x, `${path}.conditions[${i}]`, out));
      return;
    case 'unsupported': if (!isStr(c.what)) bad('what is required'); return;
    case 'landblock': if (!isNum(c.landblock, 0)) bad('landblock must be a number'); return;
    case 'landcell': if (!isNum(c.cell, 0)) bad('cell must be a number'); return;
    case 'portal-entered': case 'portal-exited': case 'died': case 'vendor-open': case 'vendor-closed': case 'route-done': case 'need-buff': return;
    case 'spell-time-at-least': if (!isStr(c.spell) && !isNum(c.spellId, 1)) bad('spell (or spellId) is required'); if (!isNum(c.seconds, 0)) bad('seconds must be ≥ 0'); return;
    case 'seconds-in-state-persistent': if (!isNum(c.seconds, 0)) bad('seconds must be ≥ 0'); return;
    case 'route-distance-at-least': if (!isNum(c.meters, 0)) bad('meters must be ≥ 0'); return;
    case 'monster-priority-count':
      if (!isNum(c.priority, -1, 4)) bad('priority must be -1..4');
      if (!isNum(c.count, 1)) bad('count must be ≥ 1');
      if (!isNum(c.meters, 0, 500)) bad('meters must be 0..500');
      return;
    case 'chat-capture':
      if (!isStr(c.pattern) || !regexOk(c.pattern)) bad('pattern must be a valid regex');
      if (c.colors !== undefined && (!Array.isArray(c.colors) || !c.colors.every((x) => isNum(x, 0)))) bad('colors must be a list of chat colour ids');
      return;
    case 'monster-count':
      if (!isStr(c.pattern) || !regexOk(c.pattern)) bad('pattern must be a valid regex');
      if (!isNum(c.count, 1)) bad('count must be ≥ 1');
      if (!isNum(c.meters, 0, 500)) bad('meters must be 0..500');
      return;
    case 'expression': if (!isStr(c.expr)) bad('expr is required'); return;
    // Beyond VTank, Jake 2026-10-12.
    case 'attackers-at-least': if (!isNum(c.count, 1, 50)) bad('count must be 1..50'); return;
    case 'being-cast-at': if (c.seconds !== undefined && !isNum(c.seconds, 1, 60)) bad('seconds must be 1..60'); return;
    case 'no-monster-near':
      if (!isNum(c.meters, 0, 500)) bad('meters must be 0..500');
      if ((c.coords === undefined) === (c.object === undefined)) bad('give either coords or object (not both)');
      if (c.coords !== undefined && (!isStr(c.coords) || !COORDS.test(c.coords))) bad('coords must look like "42.1N, 33.6E"');
      if (c.object !== undefined && !isStr(c.object)) bad('object must be a name');
      return;
    case 'my-corpse-within': if (!isNum(c.meters, 0, 500)) bad('meters must be 0..500'); return;
    default: out.push({ path, message: `unknown condition kind "${String(k)}"` });
  }
}

function checkAction(a: unknown, path: string, p: RoutineProfile, out: RoutineIssue[]): void {
  if (!isObj(a)) { out.push({ path, message: 'action must be an object with a kind' }); return; }
  const k = a.kind;
  const bad = (m: string): void => { out.push({ path, message: `${String(k)}: ${m}` }); };
  const states = new Set((Array.isArray(p.states) ? p.states : []).map((s) => s?.name));
  switch (k) {
    case 'set-state': if (!states.has(a.state as string)) bad(`no state named "${String(a.state)}"`); return;
    case 'cast':
      if (!isStr(a.spell)) bad('spell is required');
      if (a.target !== undefined && a.target !== 'self' && a.target !== 'target') bad('target must be self or target');
      return;
    case 'cast-buffs':
      if (!(Array.isArray(p.buffSets) && p.buffSets.some((b) => b?.name === a.set))) bad(`no buff set named "${String(a.set)}"`);
      return;
    case 'use-item':
      if (!isStr(a.item)) bad('item is required');
      if (a.on !== undefined && a.on !== 'self' && a.on !== 'target') bad('on must be self or target');
      if (a.to !== undefined && !isStr(a.to)) bad('to must be an object name');
      return;
    case 'attack-nearest':
      if (a.meters !== undefined && !isNum(a.meters, 0, 500)) bad('meters must be 0..500');
      if (a.names !== undefined && (!Array.isArray(a.names) || !a.names.every(isStr))) bad('names must be a list of names');
      return;
    case 'loot-nearby': if (a.meters !== undefined && !isNum(a.meters, 0, 100)) bad('meters must be 0..100'); return;
    case 'follow-route':
      if (!(Array.isArray(p.routes) && p.routes.some((r) => r?.name === a.route))) bad(`no route named "${String(a.route)}"`);
      return;
    case 'walk-to': if (!isStr(a.coords) || !COORDS.test(a.coords)) bad('coords must look like "42.1N, 33.6E"'); return;
    case 'use-object': case 'talk-to': case 'destroy-view': if (!isStr(a.name)) bad('name is required'); return;
    case 'create-view': if (!isStr(a.name)) bad('name is required'); if (typeof a.xml !== 'string' || !/<view\b/i.test(a.xml)) bad('xml needs a <view>'); return;
    case 'destroy-all-views': return;
    case 'say':
      if (!isStr(a.text)) bad('text is required');
      else if (/^\s*@/.test(a.text)) bad('"@" server commands are not allowed (routines play as a player)');
      return;
    case 'sell-by-loot-rules': if (typeof a.vendor !== 'string') bad('vendor must be a name ("" = the vendor window already open)'); return;
    case 'combat-mode': if (!['peace', 'melee', 'missile', 'magic'].includes(String(a.mode))) bad('mode must be peace, melee, missile or magic'); return;
    case 'give':
      if (!isStr(a.item)) bad('item is required');
      if (!isStr(a.to)) bad('to (who) is required');
      if (a.count !== undefined && !isNum(a.count, 1)) bad('count must be ≥ 1');
      return;
    case 'wait': if (!isNum(a.seconds, 0, 3600)) bad('seconds must be 0..3600'); return;
    case 'train':
      if (!Array.isArray(a.plan) || !a.plan.length) bad('plan must list { stat, upTo } entries');
      else a.plan.forEach((e, i) => {
        if (!isObj(e) || !isStr(e.stat)) bad(`plan[${i}]: stat is required (an attribute, vital or trained skill)`);
        else if (!isNum(e.upTo, 1, 10000)) bad(`plan[${i}]: upTo must be 1..10000`);
      });
      return;
    case 'stop': return;
    case 'unsupported': if (!isStr(a.what)) bad('what is required'); return;
    case 'call-state':
      if (!states.has(a.state as string)) bad(`no state named "${String(a.state)}"`);
      if (!states.has(a.returnTo as string)) bad(`no state named "${String(a.returnTo)}" to return to`);
      return;
    case 'return': case 'clear-watchdog': case 'checkpoint': return;
    case 'use-portal': if (!isNum(a.id, 0)) bad('id must be an object id'); return;
    case 'jump':
      if (a.heading !== undefined && !isNum(a.heading, -360, 360)) bad('heading must be degrees');
      if (a.holdMs !== undefined && !isNum(a.holdMs, 0, 5000)) bad('holdMs must be 0..5000');
      return;
    case 'load-loot': if (!(isObj(p.lootSets) && isStr(a.set) && a.set in p.lootSets)) bad(`no loot set named "${String(a.set)}"`); return;
    case 'load-route':
      if (!(Array.isArray(p.routes) && p.routes.some((r) => r?.name === a.route))) bad(`no route named "${String(a.route)}"`);
      return;
    case 'set-setting':
      if (!isStr(a.name)) bad('name is required');
      if (!['string', 'number', 'boolean'].includes(typeof a.value)) bad('value must be a string, number or true/false');
      return;
    case 'set-watchdog':
      if (!states.has(a.state as string)) bad(`no state named "${String(a.state)}"`);
      if (!isNum(a.meters, 0)) bad('meters must be ≥ 0');
      if (!isNum(a.seconds, 1)) bad('seconds must be ≥ 1');
      return;
    case 'expression': if (!isStr(a.expr)) bad('expr is required'); return;
    // Beyond VTank, Jake 2026-10-12.
    case 'pull':
      if (!isStr(a.pattern) || !regexOk(a.pattern)) bad('pattern must be a valid regex');
      if (!isStr(a.back) || !COORDS.test(a.back)) bad('back must look like "42.1N, 33.6E"');
      if (a.meters !== undefined && !isNum(a.meters, 1, 500)) bad('meters must be 1..500');
      if (a.holdMeters !== undefined && !isNum(a.holdMeters, 1, 500)) bad('holdMeters must be 1..500');
      return;
    case 'hold-position':
      if (!isNum(a.meters, 1, 500)) bad('meters must be 1..500');
      if (a.coords !== undefined && (!isStr(a.coords) || !COORDS.test(a.coords))) bad('coords must look like "42.1N, 33.6E" (leave it out for where you stand)');
      return;
    case 'release-position': return;
    case 'loot-corpse':
      if (!isStr(a.name)) bad('name is required ("Corpse of …")');
      if (a.meters !== undefined && !isNum(a.meters, 1, 200)) bad('meters must be 1..200');
      return;
    case 'recall':
      if (!isStr(a.via)) bad('via is required: a recall command ("/ls") or a recall spell');
      if (a.abortAttackers !== undefined && !isNum(a.abortAttackers, 1, 50)) bad('abortAttackers must be 1..50');
      return;
    case 'flee-to':
      if (a.portal !== undefined && typeof a.portal !== 'string') bad('portal must be a name');
      if (!(a.portal && (!a.coords || a.coords === '')) && (!isStr(a.coords) || !COORDS.test(a.coords))) bad('coords must look like "42.1N, 33.6E" (or be empty when a portal is named)');
      return;
    default: out.push({ path, message: `unknown action kind "${String(k)}"` });
  }
}

function checkProfile(p: unknown, path: string, out: RoutineIssue[]): void {
  if (!isObj(p)) { out.push({ path, message: 'profile must be an object' }); return; }
  const prof = p as unknown as RoutineProfile;
  if (!isStr(p.name)) out.push({ path: `${path}.name`, message: 'name is required' });
  if (!isObj(p.modules)) out.push({ path: `${path}.modules`, message: `modules must list ${MODULES.join(', ')} as true/false` });
  else for (const m of MODULES) if (typeof (p.modules as Record<string, unknown>)[m] !== 'boolean') out.push({ path: `${path}.modules.${m}`, message: 'must be true or false' });
  if (p.ruleFiring !== undefined && p.ruleFiring !== 'repeat' && p.ruleFiring !== 'once') out.push({ path: `${path}.ruleFiring`, message: 'must be repeat or once' });
  for (const list of ['states', 'loot', 'buffSets', 'routes']) {
    if (!Array.isArray(p[list])) out.push({ path: `${path}.${list}`, message: 'must be a list (may be empty)' });
  }
  const states = Array.isArray(p.states) ? p.states : [];
  const names = new Set<string>();
  states.forEach((s, si) => {
    const sp = `${path}.states[${si}]`;
    if (!isObj(s) || !isStr(s.name)) { out.push({ path: sp, message: 'a state needs a name' }); return; }
    if (names.has(s.name)) out.push({ path: `${sp}.name`, message: `duplicate state "${s.name}"` });
    names.add(s.name);
    if (!Array.isArray(s.rules)) { out.push({ path: `${sp}.rules`, message: 'must be a list' }); return; }
    s.rules.forEach((r: unknown, ri: number) => {
      const rp = `${sp}.rules[${ri}]`;
      if (!isObj(r)) { out.push({ path: rp, message: 'a rule needs when and do' }); return; }
      if (!Array.isArray(r.when) || r.when.length === 0) out.push({ path: `${rp}.when`, message: 'needs at least one condition (use {"kind":"always"})' });
      else r.when.forEach((c: unknown, ci: number) => checkCondition(c, `${rp}.when[${ci}]`, out));
      // An empty list is VirindiTank's None action: the rule does nothing when it fires.
      if (!Array.isArray(r.do)) out.push({ path: `${rp}.do`, message: 'must be a list of actions' });
      else r.do.forEach((a: unknown, ai: number) => checkAction(a, `${rp}.do[${ai}]`, prof, out));
    });
  });
  if (states.length && !names.has(p.initialState as string)) out.push({ path: `${path}.initialState`, message: `no state named "${String(p.initialState)}"` });
  (Array.isArray(p.loot) ? p.loot : []).forEach((l: unknown, li: number) => {
    const lp = `${path}.loot[${li}]`;
    if (!isObj(l)) { out.push({ path: lp, message: 'a loot rule needs action and match' }); return; }
    if (!LOOT_ACTIONS.includes(String(l.action))) out.push({ path: `${lp}.action`, message: `must be one of ${LOOT_ACTIONS.join(', ')}` });
    if (l.action === 'keep-up-to' && !isNum(l.count, 1)) out.push({ path: `${lp}.count`, message: 'keep-up-to needs count ≥ 1' });
    if (!isObj(l.match)) { out.push({ path: `${lp}.match`, message: 'match is required' }); return; }
    for (const re of ['name', 'appraisal'] as const) {
      const v = l.match[re];
      if (v !== undefined && (!isStr(v) || !regexOk(v))) out.push({ path: `${lp}.match.${re}`, message: 'must be a valid regex' });
    }
    if (l.match.props !== undefined) {
      if (!Array.isArray(l.match.props)) out.push({ path: `${lp}.match.props`, message: 'must be a list' });
      else l.match.props.forEach((t: unknown, ti: number) => {
        if (!isObj(t) || !['int', 'float', 'string', 'bool', 'did'].includes(String(t.kind)) || !isNum(t.key, 0) || !['le', 'ge', 'eq', 'ne', 'flag', 'match'].includes(String(t.op)) || (typeof t.value !== 'number' && typeof t.value !== 'string')) {
          out.push({ path: `${lp}.match.props[${ti}]`, message: 'needs kind (int/float/string/bool/did), key, op (le/ge/eq/ne/flag/match) and value' });
        } else if (t.op === 'match' && (!isStr(t.value) || !regexOk(t.value))) out.push({ path: `${lp}.match.props[${ti}].value`, message: 'must be a valid regex' });
      });
    }
    for (const k of ['descFlags', 'totalRatingsAtLeast', 'minDamageAtLeast', 'freeSlotsAtLeast', 'characterLevelAtLeast', 'characterLevelAtMost'] as const) {
      if (l.match[k] !== undefined && !isNum(l.match[k], 0)) out.push({ path: `${lp}.match.${k}`, message: 'must be a number ≥ 0' });
    }
    if (l.match.palettes !== undefined && !(Array.isArray(l.match.palettes) && l.match.palettes.every((x) => isObj(x) && isNum((x as { slot?: unknown }).slot, 0) && isNum((x as { palette?: unknown }).palette, 0)))) {
      out.push({ path: `${lp}.match.palettes`, message: 'each needs a slot and a palette' });
    }
    if (l.match.colours !== undefined && !(Array.isArray(l.match.colours) && l.match.colours.every((x) => isObj(x) && Array.isArray((x as { rgb?: unknown }).rgb) && ((x as { rgb: unknown[] }).rgb).length === 3 && isNum((x as { maxHue?: unknown }).maxHue, 0) && isNum((x as { maxSV?: unknown }).maxSV, 0)))) {
      out.push({ path: `${lp}.match.colours`, message: 'each needs an rgb triple, maxHue and maxSV' });
    }
    if (l.match.characterSkills !== undefined && !(Array.isArray(l.match.characterSkills) && l.match.characterSkills.every((s) => isObj(s) && isNum((s as { skill?: unknown }).skill, 1)))) {
      out.push({ path: `${lp}.match.characterSkills`, message: 'each needs a skill id' });
    }
    const spellOk = (sp: unknown): boolean => isObj(sp) && isStr(sp.match) && regexOk(sp.match) && (sp.notMatch === undefined || (isStr(sp.notMatch) && regexOk(sp.notMatch))) && isNum(sp.count, 1);
    if (l.match.spells !== undefined && !spellOk(l.match.spells)) {
      out.push({ path: `${lp}.match.spells`, message: 'needs match (regex), optional notMatch (regex) and count ≥ 1' });
    }
    if (l.match.moreSpells !== undefined && !(Array.isArray(l.match.moreSpells) && l.match.moreSpells.every(spellOk))) {
      out.push({ path: `${lp}.match.moreSpells`, message: 'each needs match (regex), optional notMatch (regex) and count ≥ 1' });
    }
  });
  (Array.isArray(p.buffSets) ? p.buffSets : []).forEach((b: unknown, bi: number) => {
    if (!isObj(b) || !isStr(b.name) || !Array.isArray(b.spells) || !b.spells.every((x) => isObj(x) && isStr(x.spell))) {
      out.push({ path: `${path}.buffSets[${bi}]`, message: 'a buff set needs a name and spells [{ "spell": "…" }]' });
    }
  });
  if (p.vtank !== undefined) checkVtank(p.vtank, `${path}.vtank`, out);
  if (p.navRoute !== undefined && !(Array.isArray(p.routes) && p.routes.some((r) => isObj(r) && r.name === p.navRoute))) out.push({ path: `${path}.navRoute`, message: `no route named "${String(p.navRoute)}"` });
  if (p.salvageCombine !== undefined) checkSalvageCombine(p.salvageCombine, `${path}.salvageCombine`, out);
  if (p.salvageCombineSets !== undefined) {
    if (!isObj(p.salvageCombineSets)) out.push({ path: `${path}.salvageCombineSets`, message: 'must map loot set names to SalvageCombine blocks' });
    else for (const [k, b] of Object.entries(p.salvageCombineSets)) checkSalvageCombine(b, `${path}.salvageCombineSets.${k}`, out);
  }
  if (p.lootSet !== undefined && !(isObj(p.lootSets) && Array.isArray(p.lootSets[String(p.lootSet)]))) out.push({ path: `${path}.lootSet`, message: `no loot set named "${String(p.lootSet)}"` });
  (Array.isArray(p.routes) ? p.routes : []).forEach((r: unknown, ri: number) => {
    const rp = `${path}.routes[${ri}]`;
    if (!isObj(r) || !isStr(r.name)) { out.push({ path: rp, message: 'a route needs a name' }); return; }
    if (!['circular', 'linear', 'once', 'follow'].includes(String(r.mode))) out.push({ path: `${rp}.mode`, message: 'must be circular, linear, once or follow' });
    if (r.mode === 'follow' && r.follow !== undefined && !isStr(r.follow)) out.push({ path: `${rp}.follow`, message: 'must be a player name' });
    // An empty route is VirindiTank's empty nav profile (Navroute Empty holds).
    if (!Array.isArray(r.points) || !r.points.every((pt) => isStr(pt) && COORDS.test(pt))) {
      out.push({ path: `${rp}.points`, message: 'needs coordinates like "42.1N, 33.6E"' });
    }
    if (r.z !== undefined && !(Array.isArray(r.z) && r.z.every((h) => h === null || isNum(h)))) out.push({ path: `${rp}.z`, message: 'must be a list of heights (numbers or null)' });
    if (r.stops !== undefined) {
      if (!Array.isArray(r.stops)) out.push({ path: `${rp}.stops`, message: 'must be a list' });
      else r.stops.forEach((st: unknown, si: number) => {
        const sp = `${rp}.stops[${si}]`;
        if (!isObj(st) || !isNum(st.at, 0, (Array.isArray(r.points) ? r.points.length : 1) - 1)) { out.push({ path: sp, message: 'at must be a point index' }); return; }
        if (!Array.isArray(st.do) || !st.do.length) { out.push({ path: `${sp}.do`, message: 'needs at least one action' }); return; }
        st.do.forEach((a: unknown, ai: number) => checkAction(a, `${sp}.do[${ai}]`, prof, out));
      });
    }
  });
}

/** Every problem in the document, with where it is; empty when it is valid. */
export function validateRoutineDoc(doc: unknown): RoutineIssue[] {
  const out: RoutineIssue[] = [];
  if (!isObj(doc)) return [{ path: '', message: 'the document must be a JSON object' }];
  if (doc.schemaVersion !== ROUTINE_SCHEMA_VERSION) out.push({ path: 'schemaVersion', message: `must be ${ROUTINE_SCHEMA_VERSION}` });
  if (!isStr(doc.account)) out.push({ path: 'account', message: 'account is required' });
  if (!isStr(doc.server)) out.push({ path: 'server', message: 'server is required' });
  if (!Array.isArray(doc.profiles)) { out.push({ path: 'profiles', message: 'must be a list' }); return out; }
  const names = new Set<string>();
  doc.profiles.forEach((p: unknown, i: number) => {
    checkProfile(p, `profiles[${i}]`, out);
    const n = isObj(p) ? p.name : undefined;
    if (isStr(n)) { if (names.has(n)) out.push({ path: `profiles[${i}].name`, message: `duplicate profile "${n}"` }); names.add(n); }
  });
  if (doc.characters !== undefined) {
    if (!isObj(doc.characters)) out.push({ path: 'characters', message: 'must map character names to profile names' });
    else for (const [c, p] of Object.entries(doc.characters)) if (!names.has(p as string)) out.push({ path: `characters.${c}`, message: `no profile named "${String(p)}"` });
  }
  return out;
}

// ── explanation ──

function sayCondition(c: RoutineCondition): string {
  switch (c.kind) {
    case 'always': return 'always';
    case 'vital-below': return `${c.vital} below ${c.percent}%`;
    case 'vital-above': return `${c.vital} above ${c.percent}%`;
    case 'monster-within': return `${c.names?.length ? c.names.join('/') : 'a monster'} within ${c.meters} m`;
    case 'no-monster-within': return `no ${c.names?.length ? c.names.join('/') : 'monster'} within ${c.meters} m`;
    case 'buff-missing': return `${c.spell} is not on`;
    case 'free-slots-below': return `fewer than ${c.slots} free pack slots`;
    case 'item-count-below': return `fewer than ${c.count} ${c.item}`;
    case 'burden-above': return `burden above ${c.percent}%`;
    case 'chat-matches': return `chat says /${c.pattern}/`;
    case 'near': return `within ${c.meters} m of ${c.coords}`;
    case 'seconds-in-state': return `${c.seconds} s in this state`;
    case 'unassigned-xp-above': return `more than ${c.xp.toLocaleString()} unassigned XP`;
    case 'not': return `not (${sayCondition(c.condition)})`;
    case 'any': return c.conditions.length ? `any of (${c.conditions.map(sayCondition).join('; ')})` : 'never';
    case 'all': return c.conditions.length ? `all of (${c.conditions.map(sayCondition).join('; ')})` : 'always';
    case 'unsupported': return `[can't run: ${c.what}]`;
    case 'landblock': return `in landblock 0x${(c.landblock >>> 0).toString(16).toUpperCase()}`;
    case 'landcell': return `in cell 0x${(c.cell >>> 0).toString(16).toUpperCase()}`;
    case 'portal-entered': return 'you entered portal space';
    case 'portal-exited': return 'you came out of portal space';
    case 'died': return 'you died';
    case 'vendor-open': return 'a vendor window is open';
    case 'vendor-closed': return 'no vendor window is open';
    case 'route-done': return 'the loaded route is finished';
    case 'spell-time-at-least': return `${c.spell || `spell ${c.spellId}`} has at least ${c.seconds} s left`;
    case 'seconds-in-state-persistent': return `${c.seconds} s in this state (pauses included)`;
    case 'route-distance-at-least': return `at least ${c.meters} m from every point of the route`;
    case 'monster-priority-count': return `${c.count}+ monsters of priority ${c.priority} within ${c.meters} m`;
    case 'chat-capture': return `chat says /${c.pattern}/ (captured)`;
    case 'need-buff': return 'the buff set needs a rebuff';
    case 'monster-count': return `at least ${c.count} monsters matching /${c.pattern}/ within ${c.meters} m`;
    case 'expression': return `expression ${c.expr}`;
    case 'attackers-at-least': return `${c.count}+ creatures attacking you (last 10 s)`;
    case 'being-cast-at': return `a spell came at you in the last ${c.seconds ?? 5} s`;
    case 'no-monster-near': return `no monster within ${c.meters} m of ${c.coords ?? `the ${c.object}`}`;
    case 'my-corpse-within': return `your corpse within ${c.meters} m`;
  }
}

function sayAction(a: RoutineAction): string {
  switch (a.kind) {
    case 'set-state': return `switch to "${a.state}"`;
    case 'cast': return `cast ${a.spell}${a.target === 'target' ? ' at the target' : ' on yourself'}`;
    case 'cast-buffs': return `cast buff set "${a.set}"`;
    case 'use-item': return `use ${a.item}${a.to ? ` on ${a.to}` : a.on ? ` on ${a.on === 'self' ? 'yourself' : 'the target'}` : ''}`;
    case 'attack-nearest': return `attack the nearest ${a.names?.length ? a.names.join('/') : 'monster'}${a.meters ? ` within ${a.meters} m` : ''}`;
    case 'loot-nearby': return `loot corpses${a.meters ? ` within ${a.meters} m` : ''} by the loot rules`;
    case 'follow-route': return `follow route "${a.route}"`;
    case 'walk-to': return `walk to ${a.coords}`;
    case 'use-object': return `use ${a.name}`;
    case 'talk-to': return `talk to ${a.name} until it answers`;
    case 'checkpoint': return 'wait until the server has you at the point';
    case 'use-portal': return `use the portal #${(a.id >>> 0).toString(16)} (or the one nearest the point)`;
    case 'create-view': return `open the view "${a.name}"`;
    case 'destroy-view': return `close the view "${a.name}"`;
    case 'destroy-all-views': return 'close every view';
    case 'say': return `say "${a.text}"`;
    case 'sell-by-loot-rules': return `sell what the loot rules mark "sell" to ${a.vendor || 'the open vendor'}`;
    case 'combat-mode': return `switch to ${a.mode} mode`;
    case 'give': return `give ${a.count ? `${a.count} ` : ''}${a.item} to ${a.to}`;
    case 'wait': return `wait ${a.seconds} s`;
    case 'train': return `spend XP raising ${a.plan.map((e) => `${e.stat} to ${e.upTo}`).join(', ')}`;
    case 'stop': return 'stop the routine';
    case 'unsupported': return `[can't run: ${a.what}]`;
    case 'call-state': return `go to "${a.state}" (and return to "${a.returnTo}")`;
    case 'return': return 'return to the calling state';
    case 'load-route': return `load route "${a.route}"`;
    case 'set-setting': return `set ${a.name} to ${String(a.value)}`;
    case 'set-watchdog': return `go to "${a.state}" if you haven't moved ${a.meters} m in ${a.seconds} s`;
    case 'clear-watchdog': return 'clear the watchdog';
    case 'jump': return `jump${a.forward ? ' forward' : ''}${a.heading !== undefined ? ` facing ${a.heading}°` : ''}${a.holdMs ? ` (hold ${a.holdMs} ms)` : ''}`;
    case 'load-loot': return `use loot set "${a.set}"`;
    case 'expression': return `run expression ${a.expr}`;
    case 'pull': return `pull the nearest /${a.pattern}/${a.meters ? ` within ${a.meters} m` : ''} back to ${a.back}${a.holdMeters ? ` and hold there (${a.holdMeters} m)` : ''}`;
    case 'hold-position': return `hold position (fight nothing more than ${a.meters} m from ${a.coords ?? 'here'})`;
    case 'release-position': return 'release the held position';
    case 'loot-corpse': return `loot ${a.name} by the loot rules`;
    case 'recall': return `recall (${a.via}), giving up if ${a.abortAttackers ?? 1}+ creatures attack first`;
    case 'flee-to': return a.portal ? `${a.coords ? `run to ${a.coords}, then ` : ''}use ${a.portal}, not stopping when hit` : `run to ${a.coords}, not stopping when hit`;
  }
}

/** A profile in plain words: what turns on, each state's rules in order, loot rules, buffs, routes. */
export function explainProfile(p: RoutineProfile): string {
  const on = Object.entries(p.modules).filter(([, v]) => v).map(([k]) => k);
  const out = [`Profile "${p.name}"${p.description ? `: ${p.description}` : ''}`, `modules on: ${on.length ? on.join(', ') : 'none'}`];
  if (p.states.length) {
    out.push(`starts in "${p.initialState}"`);
    for (const s of p.states) {
      out.push(`state "${s.name}":`);
      s.rules.forEach((r, i) => out.push(`  ${i + 1}. ${r.disabled ? '[off] ' : ''}${r.label ? `${r.label}: ` : ''}when ${r.when.map(sayCondition).join(' and ')} → ${r.do.map(sayAction).join(', then ')}${r.note ? ` (${r.note})` : ''}`));
    }
  }
  if (p.loot.length) {
    out.push('loot (first match wins):');
    p.loot.forEach((l, i) => {
      const m = l.match;
      const what = [m.name && `name /${m.name}/`, m.types?.length && m.types.join('/'), m.valueAtLeast !== undefined && `value ≥ ${m.valueAtLeast}`, m.valueAtMost !== undefined && `value ≤ ${m.valueAtMost}`, m.burdenAtMost !== undefined && `burden ≤ ${m.burdenAtMost}`, m.appraisal && `appraisal /${m.appraisal}/`, m.props?.length && `${m.props.length} property test${m.props.length > 1 ? 's' : ''}`, m.spells && `${m.spells.count}+ spells /${m.spells.match}/`, m.moreSpells?.length && m.moreSpells.map((x) => `${x.count}+ spells /${x.match}/`).join(', '), m.spellCountAtLeast !== undefined && `${m.spellCountAtLeast}+ spells`, m.colours?.length && m.colours.map((x) => `colour near rgb(${x.rgb.join(',')})${x.group ? ` on ${x.group}` : x.slots ? ` in slot ${x.slots.join('/')}` : ''}`).join(', '), m.palettes?.length && m.palettes.map((x) => `slot ${x.slot} palette 0x${(x.palette & 0xffffff).toString(16).toUpperCase()}`).join(', '), m.descFlags !== undefined && `object flags 0x${m.descFlags.toString(16)}`, m.totalRatingsAtLeast !== undefined && `total ratings ≥ ${m.totalRatingsAtLeast}`, m.minDamageAtLeast !== undefined && `min damage ≥ ${m.minDamageAtLeast}`, m.freeSlotsAtLeast !== undefined && `you have ${m.freeSlotsAtLeast}+ free slots`, m.characterLevelAtLeast !== undefined && `your level ≥ ${m.characterLevelAtLeast}`, m.characterLevelAtMost !== undefined && `your level ≤ ${m.characterLevelAtMost}`, m.characterSkills?.length && `${m.characterSkills.length} skill test${m.characterSkills.length > 1 ? 's' : ''}`, m.unsupported && `[can't test: ${m.unsupported}]`].filter(Boolean).join(', ') || 'anything';
      out.push(`  ${i + 1}. ${l.disabled ? '[off] ' : ''}${l.label ? `${l.label}: ` : ''}${l.action}${l.action === 'keep-up-to' ? ` ${l.count}` : ''}: ${what}${l.note ? ` (${l.note})` : ''}`);
    });
  }
  for (const b of p.buffSets) out.push(`buff set "${b.name}": ${b.spells.map((s) => s.spell).join(', ')}${b.rebuffBelowSeconds ? ` (rebuff under ${b.rebuffBelowSeconds} s)` : ''}`);
  for (const r of p.routes) {
    out.push(`route "${r.name}" (${r.mode}): ${r.points.join(' → ')}${r.note ? ` (${r.note})` : ''}`);
    for (const st of r.stops ?? []) out.push(`  at point ${st.at + 1}: ${st.do.map(sayAction).join(', then ')}`);
  }
  return out.join('\n');
}
