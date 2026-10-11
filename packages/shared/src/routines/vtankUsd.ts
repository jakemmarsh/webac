/**
 * VirindiTank's settings files (`.usd`, docs/vtank-parity-gaps.md §10.2): a
 * macro profile's options and its Monsters / Items / Consumables / Buffs tabs,
 * read into a routine profile and written back out.
 *
 * Format (docs/vtank-formats.md §6; facts from VTank-written files, no code
 * ported): the same typed-value serialisation as `.met` (`i`, `s`, `d`, `ba`,
 * `TABLE`) plus `b` (`True` / `False`). The file is a table count, then each
 * table as its name, column count, column names, one `y`/`n` index flag per
 * column, row count and the rows' cells. A nested table value is `TABLE` and
 * the same shape without a name. CRLF line ends.
 *
 * Tables: Settings (Setting, Value, Description, SettingType: 1 bool, 2
 * double, 3 int, 5 string, 6 enum), MyMonsters (the Monsters tab, 21
 * columns), BuffedItems (Object id, Spell id: the Items tab in order, and the
 * spells each gets), AssistItems (Object name, Type: the Consumables tab and
 * each entry's kind), GemFoodItems (Name, Spell), ExtraBuffSpells and
 * AntiExtraBuffSpells (ExemplarId: one spell id per family), and
 * ItemUseSpecifiers (Object id, Uses). Object ids are the server's own (one
 * character's items); spells are ids.
 *
 * What we don't model is kept (`VtankProfileData.usd`) and written back as it
 * was, and every export says what it couldn't hold.
 */
import type { RoutineProfile } from './RoutineDoc.js';
import { emptyVtankData, VT_DAMAGE, VT_DEFAULT_MONSTER, VT_PET_AUTO, type UsdTable, type UsdValue, type VtankProfileData, type VtMonsterColumn, type VtMonsterRow, type VtUsdKeep } from './vtankProfile.js';
import { VT_OPTIONS, vtCanonicalName, vtFromVTank, vtOption, vtToVTank } from './vtankOptions.js';
import { vtankFile, vtFileName, vtNumber, type VTankExport } from './vtankExport.js';

const NL = '\r\n';

// ── reading and writing the tables ──

class Lines {
  pos = 0;
  constructor(readonly text: string) {}
  line(): string {
    if (this.pos > this.text.length) throw new Error('unexpected end of file');
    const i = this.text.indexOf('\r\n', this.pos);
    const end = i < 0 ? this.text.length : i;
    const out = this.text.slice(this.pos, end);
    this.pos = i < 0 ? this.text.length + 1 : i + 2;
    return out;
  }
  int(): number {
    const l = this.line().trim();
    if (!/^-?\d+$/.test(l)) throw new Error(`expected an integer, found "${l}"`);
    return Number(l);
  }
  chars(n: number): string {
    if (this.pos + n > this.text.length) throw new Error(`expected ${n} characters, file ends`);
    const out = this.text.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  get rest(): string { return this.text.slice(Math.min(this.pos, this.text.length)); }
}

function readValue(r: Lines): UsdValue {
  const tag = r.line();
  switch (tag) {
    case 'i': return { t: 'i', v: r.int() };
    case 's': return { t: 's', v: r.line() };
    case 'd': { const l = r.line().trim().replace(',', '.'); const v = Number(l); if (!Number.isFinite(v)) throw new Error(`expected a number, found "${l}"`); return { t: 'd', v }; }
    case 'b': { const l = r.line().trim(); if (!/^(true|false)$/i.test(l)) throw new Error(`expected True or False, found "${l}"`); return { t: 'b', v: /^true$/i.test(l) }; }
    case 'ba': { const n = r.int(); return { t: 'ba', v: r.chars(n) }; }
    case 'TABLE': { const t = readTableBody(r); return { t: 'table', cols: t.cols, index: t.index, rows: t.rows }; }
    default: throw new Error(`unknown value tag "${tag}"`);
  }
}

function readTableBody(r: Lines): { cols: string[]; index: boolean[]; rows: UsdValue[][] } {
  const ncols = r.int();
  const cols = Array.from({ length: ncols }, () => r.line());
  const index = Array.from({ length: ncols }, () => r.line().trim() === 'y');
  const nrows = r.int();
  const rows = Array.from({ length: nrows }, () => Array.from({ length: ncols }, () => readValue(r)));
  return { cols, index, rows };
}

/** A `.usd` file's tables, in file order. */
export function parseUsd(text: string): UsdTable[] {
  const r = new Lines(text.replace(/^﻿/, '').replace(/\r?\n/g, '\r\n'));
  const n = r.int();
  const out: UsdTable[] = [];
  for (let i = 0; i < n; i++) {
    const name = r.line();
    out.push({ name, ...readTableBody(r) });
  }
  if (r.rest.trim()) throw new Error('text after the last table');
  return out;
}

function writeValue(v: UsdValue): string {
  switch (v.t) {
    case 'i': return `i${NL}${v.v | 0}${NL}`;
    case 's': return `s${NL}${v.v.replace(/\r?\n|\r/g, ' ')}${NL}`;
    case 'd': return `d${NL}${vtNumber(v.v)}${NL}`;
    case 'b': return `b${NL}${v.v ? 'True' : 'False'}${NL}`;
    case 'ba': return `ba${NL}${v.v.length}${NL}${v.v}`;
    case 'table': return `TABLE${NL}${tableBody(v)}`;
  }
}

function tableBody(t: { cols: string[]; index: boolean[]; rows: UsdValue[][] }): string {
  return `${t.cols.length}${NL}${t.cols.map((c) => c + NL).join('')}${t.cols.map((_, i) => `${t.index[i] ? 'y' : 'n'}${NL}`).join('')}${t.rows.length}${NL}${t.rows.map((row) => row.map(writeValue).join('')).join('')}`;
}

/** Tables as `.usd` text (CRLF, VTank's table order: by name). */
export function writeUsd(tables: UsdTable[]): string {
  const sorted = [...tables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return `${sorted.length}${NL}${sorted.map((t) => `${t.name}${NL}${tableBody(t)}`).join('')}`;
}

// ── names for ids (a live client has them; the importer works without) ──

/**
 * How ids in a `.usd` become names and back: the client's spell table and the
 * character's carried items. Each is optional: what can't be named is kept by
 * id (and named when the macro runs, `resolveVtankIds`).
 */
export interface VtNames {
  spellName?(id: number): string | undefined;
  spellId?(name: string): number | undefined;
  objectName?(guid: number): string | undefined;
  objectId?(name: string): number | undefined;
}

// ── the tables' meaning ──

/** MyMonsters' switch columns → the Monsters tab's letters. */
const MONSTER_SWITCHES: Array<[string, VtMonsterColumn]> = [
  ['Imperil', 'I'], ['Vuln', 'V'], ['Yield', 'Y'], ['GravityW', 'G'], ['Attack', 'A'], ['Ring', 'R'], ['Broadside', 'B'], ['Fester', 'F'],
  ['WeakeningCurse', 'WC'], ['FesteringCurse', 'FC'], ['Corruption', 'Cp'], ['DestructiveCurse', 'DC'], ['Corrosion', 'Cs'], ['Streak', 'S'],
];
export const USD_MONSTER_COLUMNS = ['MonsterName', 'AttackPriority', 'DamageType', 'WeaponToUse', ...MONSTER_SWITCHES.map(([c]) => c), 'SecondaryVuln', 'SecondaryEquip', 'PetDamageType'];

/** AssistItems' Type: the Consumables tab's kinds (facts from MOSS, read for format facts only). */
export const VT_ASSIST_TYPES: Record<number, string> = {
  0: 'health kit', 1: 'health food', 2: 'stamina kit', 3: 'stamina food', 4: 'mana kit', 5: 'mana food',
  6: 'mana charge', 7: 'grenade', 8: 'mana stone', 9: 'pea', 10: 'lockpick', 11: 'all peas',
};

/**
 * A Consumables entry's kind from its name, for one added here (VTank asks
 * when you add it; a `.usd` that had it keeps its own). Only names that say
 * it plainly; the rest are reported.
 */
export function guessAssistType(name: string): number | undefined {
  const n = name.toLowerCase();
  if (n === '[all peas]') return 11;
  if (/ pea$/.test(n)) return 9;
  if (/lockpick/.test(n)) return 10;
  if (/mana stone/.test(n)) return 8;
  if (/mana charge/.test(n)) return 6;
  if (/grenade/.test(n)) return 7;
  if (/healing kit/.test(n)) return 0;
  return undefined;
}

/** SettingType: 1 bool, 2 double, 3 int, 5 string, 6 enum, 7 a table (as VTank writes them). */
const SETTING_TYPE = { bool: 1, float: 2, range: 2, int: 3, string: 5, enum: 6 } as const;

const KNOWN = new Set(['Settings', 'MyMonsters', 'BuffedItems', 'AssistItems', 'GemFoodItems', 'ExtraBuffSpells', 'AntiExtraBuffSpells', 'ItemUseSpecifiers']);

const cellStr = (v: UsdValue | undefined): string | null => (v && (v.t === 's' || v.t === 'ba') ? v.v : null);
const cellNum = (v: UsdValue | undefined): number | null => (v && (v.t === 'i' || v.t === 'd') ? v.v : null);
const cellBool = (v: UsdValue | undefined): boolean | null => (v && v.t === 'b' ? v.v : v && v.t === 'i' ? v.v !== 0 : null);
/** An expression row in the Monsters tab: the file has no flag (VTank tries each name both ways); operators mark one here. */
const looksLikeExpression = (name: string): boolean => /[=<>!&|#()%]/.test(name);

function col(t: UsdTable, name: string): number { return t.cols.findIndex((c) => c.toLowerCase() === name.toLowerCase()); }

/** What a `.usd` gives a profile: its settings and its VirindiTank tabs, and what couldn't be read exactly. */
export interface UsdImport { settings: Record<string, string | number | boolean>; vtank: VtankProfileData; problems: string[] }

/** A `.usd`'s tables as a profile's settings and VirindiTank tabs. */
export function usdToProfileData(tables: UsdTable[], names: VtNames = {}): UsdImport {
  const problems: string[] = [];
  const v = emptyVtankData();
  const keep: VtUsdKeep = {};
  const settings: Record<string, string | number | boolean> = {};
  const itemIds: Record<string, number> = {};
  const byName = (n: string) => tables.find((t) => t.name === n);

  // Settings: every option, typed and in our units (ranges × 240).
  const st = byName('Settings');
  if (st) {
    const ks = col(st, 'Setting'), vs = col(st, 'Value');
    for (const row of st.rows) {
      const name = cellStr(row[ks]);
      const val = row[vs];
      if (!name || !val) continue;
      if (val.t === 'table' || val.t === 'ba') {
        keep.settingsRaw = [...(keep.settingsRaw ?? []), { name, value: val }];
        continue;
      }
      settings[vtCanonicalName(name)] = vtFromVTank(name, val.v);
    }
  } else problems.push('no Settings table: the options stay as they were');

  // Monsters.
  const mt = byName('MyMonsters');
  if (mt) {
    const at = (row: UsdValue[], c: string) => row[col(mt, c)];
    const rows: VtMonsterRow[] = [];
    for (const row of mt.rows) {
      const name = cellStr(at(row, 'MonsterName'));
      if (name === null) continue;
      const weaponId = cellNum(at(row, 'WeaponToUse')) ?? -1;
      const offId = cellNum(at(row, 'SecondaryEquip')) ?? 0;
      const ref = (id: number, none: number): { name: string | null; id?: number } => {
        if (id === none || id === -1) return { name: null };
        const n = names.objectName?.(id >>> 0);
        if (n) { itemIds[n] = id; return { name: n }; }
        return { name: null, id };
      };
      const w = ref(weaponId, -1), o = ref(offId, 0);
      const out: VtMonsterRow = {
        name, priority: cellNum(at(row, 'AttackPriority')) ?? 1,
        on: MONSTER_SWITCHES.filter(([c]) => cellBool(at(row, c)) === true).map(([, l]) => l),
        damage: cellNum(at(row, 'DamageType')) ?? VT_DAMAGE.Auto, exVuln: cellNum(at(row, 'SecondaryVuln')) ?? VT_DAMAGE.None,
        weapon: w.name, offhand: o.name, petDamage: cellNum(at(row, 'PetDamageType')) ?? VT_PET_AUTO,
      };
      if (name !== '<DEFAULT>' && looksLikeExpression(name)) out.expr = true;
      if (w.id !== undefined || o.id !== undefined) out.vt = { ...(w.id !== undefined ? { weapon: w.id } : {}), ...(o.id !== undefined ? { offhand: o.id } : {}) };
      if (out.priority < -1 || out.priority > 4) { problems.push(`monster "${name}": priority ${out.priority} is outside -1..4; set to ${Math.max(-1, Math.min(4, out.priority))}`); out.priority = Math.max(-1, Math.min(4, out.priority)); }
      rows.push(out);
    }
    const def = rows.findIndex((r) => r.name === '<DEFAULT>');
    v.monsters = def >= 0 ? [rows[def], ...rows.filter((_, i) => i !== def)] : [structuredClone(VT_DEFAULT_MONSTER), ...rows];
    const unnamed = rows.filter((r) => r.vt).length;
    if (unnamed) problems.push(`${unnamed} monster row(s) name a weapon or offhand by an object id no carried item has; kept by id (used when that item is carried)`);
  }

  // Items tab: BuffedItems' objects in order (a row per spell; -1 = none named).
  const bt = byName('BuffedItems');
  if (bt) {
    const oc = col(bt, 'Object'), sc = col(bt, 'Spell');
    keep.buffedItems = bt.rows.flatMap((row) => { const o = cellNum(row[oc]), s = cellNum(row[sc]); return o === null || s === null ? [] : [{ object: o, spell: s }]; });
    const seen = new Set<number>();
    const unnamed: number[] = [];
    for (const { object } of keep.buffedItems) {
      if (object === -1 || seen.has(object)) continue;
      seen.add(object);
      const n = names.objectName?.(object >>> 0);
      if (n) { itemIds[n] = object; if (!v.items.some((x) => x.name === n)) v.items.push({ name: n }); } else unnamed.push(object);
    }
    if (unnamed.length) { keep.unnamedItems = unnamed; problems.push(`${unnamed.length} Items-tab object id(s) aren't among your carried items; kept by id (used when carried)`); }
  }

  // Consumables: AssistItems (name, kind).
  const ast = byName('AssistItems');
  if (ast) {
    const oc = col(ast, 'Object'), tc = col(ast, 'Type');
    for (const row of ast.rows) {
      const name = cellStr(row[oc]), type = cellNum(row[tc]);
      if (!name || type === null) continue;
      if (type < 0 || type > 11) { keep.assistOther = [...(keep.assistOther ?? []), { name, type }]; continue; }
      if (!v.consumables.includes(name)) v.consumables.push(name);
      keep.assistTypes = { ...(keep.assistTypes ?? {}), [name]: type };
    }
    if (keep.assistOther?.length) problems.push(`${keep.assistOther.length} Consumables row(s) of a kind we don't know; kept as they are`);
  }

  // Gems and food used as buffs.
  const gt = byName('GemFoodItems');
  if (gt) {
    const nc = col(gt, 'Name'), sc = col(gt, 'Spell');
    v.gemFood = gt.rows.flatMap((row) => { const n = cellStr(row[nc]), s = cellNum(row[sc]); return n && s !== null ? [{ name: n, spell: s }] : []; });
  }

  // Buffs tab: one exemplar spell per family.
  const spells = (table: string, into: string[]): number[] => {
    const t = byName(table);
    if (!t) return [];
    const c = col(t, 'ExemplarId');
    const unnamed: number[] = [];
    for (const row of t.rows) {
      const id = cellNum(row[c]);
      if (id === null) continue;
      const n = names.spellName?.(id);
      if (n) { if (!into.includes(n)) into.push(n); } else if (!unnamed.includes(id)) unnamed.push(id);
    }
    return unnamed;
  };
  const ux = spells('ExtraBuffSpells', v.extraBuffs);
  const ub = spells('AntiExtraBuffSpells', v.blacklistedBuffs);
  if (ux.length) keep.unnamedExtraBuffs = ux;
  if (ub.length) keep.unnamedBlacklistedBuffs = ub;
  if (ux.length + ub.length) problems.push(`${ux.length + ub.length} Buffs-tab spell id(s) not named here (no spell table); kept by id and named when the macro runs`);

  // Kept as they are.
  const it = byName('ItemUseSpecifiers');
  if (it) {
    const oc = col(it, 'Object'), uc = col(it, 'Uses');
    const rows = it.rows.flatMap((row) => { const o = cellNum(row[oc]), u = cellNum(row[uc]); return o === null || u === null ? [] : [{ object: o, uses: u }]; });
    if (rows.length) keep.itemUseSpecifiers = rows;
  }
  const other = tables.filter((t) => !KNOWN.has(t.name));
  if (other.length) keep.tables = other;
  if (Object.keys(itemIds).length) keep.itemIds = itemIds;
  if (Object.keys(keep).length) v.usd = keep;
  return { settings, vtank: v, problems };
}

/**
 * A `.usd` into a profile: its settings and VirindiTank tabs replace the
 * profile's (VTank loads a settings profile whole); states, routes and loot stay.
 */
export function importUsd(base: RoutineProfile, text: string, names: VtNames = {}): { value: RoutineProfile; problems: string[] } {
  const r = usdToProfileData(parseUsd(text), names);
  return { value: { ...base, settings: r.settings, vtank: r.vtank }, problems: r.problems };
}

// ── writing ──

const S = (v: string): UsdValue => ({ t: 's', v });
const I = (v: number): UsdValue => ({ t: 'i', v: Math.trunc(v) | 0 });
const B = (v: boolean): UsdValue => ({ t: 'b', v });
const D = (v: number): UsdValue => ({ t: 'd', v });

/** One setting as the Settings table's Value cell and SettingType. */
function settingCell(name: string, value: string | number | boolean): { value: UsdValue; type: number } {
  const opt = vtOption(name);
  const vt = vtToVTank(name, value);
  if (opt) {
    if (opt.kind === 'bool') return { value: B(vt === true || vt === 'true'), type: SETTING_TYPE.bool };
    if (opt.kind === 'string') return { value: S(String(vt)), type: SETTING_TYPE.string };
    const n = Number(vt);
    if (opt.kind === 'float' || opt.kind === 'range') return { value: D(Number.isFinite(n) ? n : 0), type: SETTING_TYPE.float };
    return { value: I(Number.isFinite(n) ? n : 0), type: opt.kind === 'enum' ? SETTING_TYPE.enum : SETTING_TYPE.int };
  }
  if (typeof vt === 'boolean') return { value: B(vt), type: SETTING_TYPE.bool };
  if (typeof vt === 'number') return Number.isInteger(vt) ? { value: I(vt), type: SETTING_TYPE.int } : { value: D(vt), type: SETTING_TYPE.float };
  return { value: S(vt), type: SETTING_TYPE.string };
}

/** VTank's default profile's GemFoodItems (an unset `gemFood` means these). */
export const VT_DEFAULT_GEM_FOOD = [{ name: "Asheron's Benediction", spell: 3810 }, { name: "Blackmoor's Favor", spell: 3811 }];

/** A profile's settings and VirindiTank tabs as a `.usd` settings file. */
export function exportUsd(p: RoutineProfile, names: VtNames = {}): VTankExport {
  const problems: string[] = [];
  const v = p.vtank ?? emptyVtankData();
  const keep = v.usd ?? {};
  const itemIds = keep.itemIds ?? {};
  const idOf = (name: string): number | undefined => itemIds[name] ?? names.objectId?.(name);
  const tables: UsdTable[] = [];

  // Settings: every option VTank has (ours at its value or default), then any other the profile set, then kept rows.
  const set = p.settings ?? {};
  const rows: UsdValue[][] = [];
  const written = new Set<string>();
  for (const o of VT_OPTIONS) {
    const value = Object.prototype.hasOwnProperty.call(set, o.name) ? set[o.name] : o.default;
    const c = settingCell(o.name, value);
    rows.push([S(o.name), c.value, S(o.help ?? ''), I(c.type)]);
    written.add(o.name.toLowerCase());
  }
  for (const [k, val] of Object.entries(set)) {
    if (written.has(vtCanonicalName(k).toLowerCase())) continue;
    const c = settingCell(k, val);
    rows.push([S(k), c.value, S(''), I(c.type)]);
    written.add(k.toLowerCase());
  }
  // A table-valued setting (RechargeHandlerSet) is SettingType 7 in VTank's own files.
  for (const r of keep.settingsRaw ?? []) if (!written.has(r.name.toLowerCase())) rows.push([S(r.name), r.value, S(''), I(r.value.t === 'table' ? 7 : SETTING_TYPE.string)]);
  tables.push({ name: 'Settings', cols: ['Setting', 'Value', 'Description', 'SettingType'], index: [true, false, false, false], rows });

  // Monsters.
  const monsters = v.monsters.length && v.monsters[0].name === '<DEFAULT>' ? v.monsters : [VT_DEFAULT_MONSTER, ...v.monsters];
  tables.push({
    name: 'MyMonsters', cols: USD_MONSTER_COLUMNS, index: USD_MONSTER_COLUMNS.map((_, i) => i === 0),
    rows: monsters.map((m) => {
      const ref = (name: string | null, kept: number | undefined, none: number, what: string): number => {
        if (name) { const id = idOf(name); if (id !== undefined) return id; problems.push(`monster "${m.name}": its ${what} "${name}" isn't carried, and VirindiTank names it by object id; written as <AUTO>`); return none; }
        return kept ?? none;
      };
      return [S(m.name), I(m.priority), I(m.damage), I(ref(m.weapon, m.vt?.weapon, -1, 'weapon')),
        ...MONSTER_SWITCHES.map(([, l]) => B(m.on.includes(l))), I(m.exVuln), I(ref(m.offhand, m.vt?.offhand, 0, 'offhand')), I(m.petDamage)];
    }),
  });

  // Items tab: the kept rows of items still listed (and those kept by id), then a row for each new one.
  const listedIds = new Map<number, string>();
  const missing: string[] = [];
  for (const it of v.items) { const id = idOf(it.name); if (id === undefined) missing.push(it.name); else listedIds.set(id, it.name); }
  if (missing.length) problems.push(`Items tab: ${missing.map((x) => `"${x}"`).join(', ')} not carried, and VirindiTank lists items by object id; left out`);
  const keepIds = new Set([...listedIds.keys(), ...(keep.unnamedItems ?? [])]);
  const buffed = (keep.buffedItems ?? []).filter((r) => r.object === -1 || keepIds.has(r.object));
  const have = new Set(buffed.map((r) => r.object));
  for (const id of listedIds.keys()) if (!have.has(id)) buffed.push({ object: id, spell: -1 });
  if (v.items.some((x) => x.noBuffs)) problems.push('Items tab: "Add (no buffs)" isn\'t told apart in a .usd we can write; those items are listed as plain items');
  tables.push({ name: 'BuffedItems', cols: ['Object', 'Spell'], index: [false, false], rows: buffed.map((r) => [I(r.object), I(r.spell)]) });

  // Consumables (AssistItems): each entry with its kind.
  const types = keep.assistTypes ?? {};
  const assist: UsdValue[][] = [];
  const noKind: string[] = [];
  for (const name of v.consumables) {
    const t = types[name] ?? guessAssistType(name);
    if (t === undefined) noKind.push(name); else assist.push([S(name), I(t)]);
  }
  for (const r of keep.assistOther ?? []) assist.push([S(r.name), I(r.type)]);
  if (noKind.length) problems.push(`Consumables: ${noKind.map((x) => `"${x}"`).join(', ')} have no VirindiTank kind (kit, food, potion…: add them in VirindiTank); left out`);
  if (v.excludedScarabs.length) problems.push(`Consumables: Excluded Scarab Types (${v.excludedScarabs.join(', ')}) aren't written: where VirindiTank keeps them isn't known`);
  tables.push({ name: 'AssistItems', cols: ['Object', 'Type'], index: [false, false], rows: assist });

  tables.push({ name: 'GemFoodItems', cols: ['Name', 'Spell'], index: [false, false], rows: (v.gemFood ?? VT_DEFAULT_GEM_FOOD).map((g) => [S(g.name), I(g.spell)]) });

  // Buffs tab: spell names back to ids.
  const exemplars = (list: string[], kept: number[] | undefined, what: string): UsdValue[][] => {
    const out: number[] = [];
    const unknown: string[] = [];
    for (const n of list) { const id = names.spellId?.(n); if (id === undefined) unknown.push(n); else if (!out.includes(id)) out.push(id); }
    for (const id of kept ?? []) if (!out.includes(id)) out.push(id);
    if (unknown.length) problems.push(`${what}: ${unknown.map((x) => `"${x}"`).join(', ')} not found in the spell table${names.spellId ? '' : ' (export from the game window to name them)'}; left out`);
    return out.map((id) => [I(id)]);
  };
  tables.push({ name: 'ExtraBuffSpells', cols: ['ExemplarId'], index: [false], rows: exemplars(v.extraBuffs, keep.unnamedExtraBuffs, 'Extra Buff Spells') });
  tables.push({ name: 'AntiExtraBuffSpells', cols: ['ExemplarId'], index: [false], rows: exemplars(v.blacklistedBuffs, keep.unnamedBlacklistedBuffs, 'Blacklisted Buff Families') });

  tables.push({ name: 'ItemUseSpecifiers', cols: ['Object', 'Uses'], index: [true, false], rows: (keep.itemUseSpecifiers ?? []).map((r) => [I(r.object), I(r.uses)]) });
  for (const t of keep.tables ?? []) if (!tables.some((x) => x.name === t.name)) tables.push(t);
  return vtankFile(vtFileName(p.name, 'usd'), writeUsd(tables), problems);
}

// ── ids named when the macro runs ──

/**
 * The tabs with what was kept by id named from the client: carried items by
 * object id, spells from the spell table. Returns `v` itself when nothing was
 * kept by id (the common case).
 */
export function resolveVtankIds(v: VtankProfileData, names: VtNames): VtankProfileData {
  const k = v.usd;
  const monsterIds = v.monsters.some((m) => m.vt);
  if (!k?.unnamedItems?.length && !k?.unnamedExtraBuffs?.length && !k?.unnamedBlacklistedBuffs?.length && !monsterIds) return v;
  const items = [...v.items];
  for (const id of k?.unnamedItems ?? []) { const n = names.objectName?.(id >>> 0); if (n && !items.some((x) => x.name === n)) items.push({ name: n }); }
  const spells = (list: string[], ids: number[] | undefined): string[] => {
    const out = [...list];
    for (const id of ids ?? []) { const n = names.spellName?.(id); if (n && !out.includes(n)) out.push(n); }
    return out;
  };
  const monsters = v.monsters.map((m) => {
    if (!m.vt) return m;
    const w = m.weapon ?? (m.vt.weapon !== undefined ? names.objectName?.(m.vt.weapon >>> 0) ?? null : null);
    const o = m.offhand ?? (m.vt.offhand !== undefined ? names.objectName?.(m.vt.offhand >>> 0) ?? null : null);
    return { ...m, weapon: w, offhand: o };
  });
  return { ...v, items, monsters, extraBuffs: spells(v.extraBuffs, k?.unnamedExtraBuffs), blacklistedBuffs: spells(v.blacklistedBuffs, k?.unnamedBlacklistedBuffs) };
}
