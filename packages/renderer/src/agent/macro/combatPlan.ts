/**
 * The macro's combat planner: VirindiTank's Monsters tab as a pure decision
 * (docs/vtank-macro-behavior.md §4, §10). Given the monsters around you, the
 * Monsters-tab rows, your spells / skills / items and VTank's settings, it
 * picks a target and the one next thing to do: change stance, equip the row's
 * weapon, cast a debuff or an attack spell, or attack with the weapon.
 *
 * Spell families come from the active era's SpellTable (0x0E00000E), never
 * from spell names: each Monsters-tab column is anchored on one spell id
 * (ACE.Entity/Enum/SpellId.cs, e.g. ImperilOther1 = 25), and the family is
 * every spell sharing that anchor's `category` and `school` in THIS era's
 * table. Spell ids are stable across eras but categories are not (Imperil
 * Other is category 116 at end of retail, 110 in the 1999 table), so a
 * category is always read from the data. An era that lacks the anchor spell
 * (no void columns before end of retail; no streaks, arcs or rings in 1999)
 * simply has no family for that column, and the column casts nothing.
 *
 * Exact spell-table fields used (ACE.Entity/Enum/SpellFlags.cs on `bitfield`):
 * SelfTargeted 0x8, Beneficial 0x4 and FellowshipSpell 0x2000 exclude
 * self / helpful / fellowship variants from a debuff or attack family;
 * NonTrackingProjectile 0x1000 splits arcs from bolts (they share a category);
 * DamageOverTime 0x10000 marks the DoT columns, which DebuffPrecastSeconds
 * does not refresh early (ADV: "except DoTs").
 *
 * Units: distances in metres (= VTank's UI yards); `now` and castLog `at` in
 * milliseconds; spell and castLog `duration` in seconds; DebuffPrecastSeconds
 * in seconds.
 */
import { VT_DAMAGE, vtOption, type PlanItem, type PlanSkill, type PlanSpell, type Stance, type VtMonsterColumn, type VtMonsterRow } from '@ac/shared';

export interface CombatMonster { guid: number; name: string; dist: number; relBearing: number; health?: number; species?: string; }

export interface CombatInput {
  /** Creatures you could fight (already filtered to monsters). */
  monsters: CombatMonster[];
  /** The Monsters tab, <DEFAULT> first. */
  rows: VtMonsterRow[];
  spells: PlanSpell[];
  skills: PlanSkill[];
  /** What you carry; the Items-tab list (names). */
  items: PlanItem[];
  itemNames: string[];
  wielded: { weapon?: string; offhand?: string };
  stance: Stance;
  /** VTank names, our units (ranges in metres). Missing names take VTank's defaults. */
  settings: Record<string, string | number | boolean>;
  /** Debuffs we cast, for time left (`at` ms, `duration` s). */
  castLog: Array<{ guid: number; category: number; at: number; duration: number }>;
  /** Milliseconds, on the castLog's clock. */
  now: number;
  selectedGuid: number | null;
  families: CombatFamilies;
}

export type CombatAction =
  | { kind: 'cast'; spell: PlanSpell; target: number; why: string }
  | { kind: 'attack'; target: number; why: string }
  | { kind: 'equip'; item: PlanItem; why: string }
  | { kind: 'stance'; to: Stance; why: string };

// ─── Spell families ─────────────────────────────────────────────────────────

export type CombatElement = 'acid' | 'bludgeon' | 'cold' | 'lightning' | 'fire' | 'pierce' | 'slash' | 'nether';
export type AttackShape = 'bolt' | 'arc' | 'streak' | 'ring';
/** The Monsters-tab columns that cast one fixed family (V is per element). */
export type DebuffColumn = 'F' | 'B' | 'G' | 'I' | 'Y' | 'WC' | 'FC' | 'Cp' | 'DC' | 'Cs';

export interface CombatFamily {
  /** The anchor spell (ACE SpellId) the family was found from. */
  anchor: number;
  /** The spell table's category, in this era. */
  category: number;
  /** The spell table's school (1 War, 2 Life, 3 Item, 4 Creature, 5 Void). */
  school: number;
  /** A damage-over-time family (SpellFlags.DamageOverTime). */
  dot: boolean;
  /** Spell ids in the family (other-targeted, not beneficial, not fellowship; arcs apart from bolts). */
  ids: Set<number>;
}

export interface CombatFamilies {
  debuff: Partial<Record<DebuffColumn, CombatFamily>>;
  vuln: Partial<Record<CombatElement, CombatFamily>>;
  attack: Partial<Record<CombatElement, Partial<Record<AttackShape, CombatFamily>>>>;
}

/** ACE SpellFlags (ACE.Entity/Enum/SpellFlags.cs). */
const SF_BENEFICIAL = 0x4;
const SF_SELF_TARGETED = 0x8;
const SF_NON_TRACKING_PROJECTILE = 0x1000;
const SF_FELLOWSHIP = 0x2000;
const SF_DAMAGE_OVER_TIME = 0x10000;

/**
 * Each column's anchor: the level-I (or only) spell of the family, by ACE
 * SpellId (ACE.Entity/Enum/SpellId.cs names in comments). The element of an
 * attack / vuln family is the element in that SpellId's name, which agrees with
 * ACE SpellCategory's name for the end-of-retail category (e.g. ForceBolt1 →
 * category 122 PiercingMissile; ShockWave1 → 118 BludgeoningMissile).
 */
const DEBUFF_ANCHORS: Record<DebuffColumn, number> = {
  F: 171, // FesterOther1
  B: 262, // DefenselessnessOther1
  G: 15, // VulnerabilityOther1
  I: 25, // ImperilOther1
  Y: 280, // MagicYieldOther1
  WC: 5379, // CurseWeakness1
  FC: 5371, // CurseFestering1
  Cp: 5395, // Corruption1
  DC: 5339, // CurseDestructionOther1
  Cs: 5387, // Corrosion1
};
const VULN_ANCHORS: Partial<Record<CombatElement, number>> = {
  acid: 521, // AcidVulnerabilityOther1
  bludgeon: 1048, // BludgeonVulnerabilityOther1
  cold: 1060, // ColdVulnerabilityOther1
  lightning: 1084, // LightningVulnerabilityOther1
  fire: 21, // FireVulnerabilityOther1
  pierce: 1151, // PiercingVulnerabilityOther1
  slash: 1127, // BladeVulnerabilityOther1
};
const ATTACK_ANCHORS: Record<CombatElement, Record<AttackShape, number>> = {
  acid: { bolt: 58 /* AcidStream1 */, arc: 2711 /* AcidArc1 */, streak: 1790 /* AcidStreak1 */, ring: 1783 /* AcidRing */ },
  bludgeon: { bolt: 64 /* ShockWave1 */, arc: 2746 /* ShockArc1 */, streak: 1820 /* ShockwaveStreak1 */, ring: 1789 /* ShockwaveRing */ },
  cold: { bolt: 28 /* FrostBolt1 */, arc: 2725 /* FrostArc1 */, streak: 1808 /* FrostStreak1 */, ring: 1787 /* FrostRing */ },
  lightning: { bolt: 75 /* LightningBolt1 */, arc: 2732 /* LightningArc1 */, streak: 1814 /* LightningStreak1 */, ring: 1788 /* LightningRing */ },
  fire: { bolt: 27 /* FlameBolt1 */, arc: 2739 /* FlameArc1 */, streak: 1796 /* FlameStreak1 */, ring: 1785 /* FlameRing */ },
  pierce: { bolt: 86 /* ForceBolt1 */, arc: 2718 /* ForceArc1 */, streak: 1802 /* ForceStreak1 */, ring: 1786 /* ForceRing */ },
  slash: { bolt: 92 /* WhirlingBlade1 */, arc: 2753 /* BladeArc1 */, streak: 1826 /* WhirlingBladeStreak1 */, ring: 1784 /* BladeRing */ },
  nether: { bolt: 5349 /* NetherBolt1 */, arc: 5369 /* NetherArc1 */, streak: 5357 /* NetherStreak1 */, ring: 5361 /* NetherRing */ },
};

export interface CombatSpellTableEntry { name: string; category: number; school: number; bitfield: number; power: number; duration?: number; desc?: string }

export function buildCombatFamilies(spellTable: { spells: Map<number, CombatSpellTableEntry> }): CombatFamilies {
  const byCategory = new Map<number, Array<[number, CombatSpellTableEntry]>>();
  for (const e of spellTable.spells) {
    let l = byCategory.get(e[1].category);
    if (!l) byCategory.set(e[1].category, (l = []));
    l.push(e);
  }
  const family = (anchor: number): CombatFamily | undefined => {
    const a = spellTable.spells.get(anchor);
    if (!a) return undefined; // this era lacks the family
    const arc = (a.bitfield & SF_NON_TRACKING_PROJECTILE) !== 0;
    const ids = new Set<number>();
    for (const [id, s] of byCategory.get(a.category) ?? []) {
      if (s.school !== a.school) continue;
      if (s.bitfield & (SF_SELF_TARGETED | SF_BENEFICIAL | SF_FELLOWSHIP)) continue;
      if (((s.bitfield & SF_NON_TRACKING_PROJECTILE) !== 0) !== arc) continue;
      ids.add(id);
    }
    return { anchor, category: a.category, school: a.school, dot: (a.bitfield & SF_DAMAGE_OVER_TIME) !== 0, ids };
  };
  const out: CombatFamilies = { debuff: {}, vuln: {}, attack: {} };
  for (const [col, id] of Object.entries(DEBUFF_ANCHORS) as Array<[DebuffColumn, number]>) { const f = family(id); if (f) out.debuff[col] = f; }
  for (const [el, id] of Object.entries(VULN_ANCHORS) as Array<[CombatElement, number]>) { const f = family(id); if (f) out.vuln[el] = f; }
  for (const [el, shapes] of Object.entries(ATTACK_ANCHORS) as Array<[CombatElement, Record<AttackShape, number>]>) {
    for (const [shape, id] of Object.entries(shapes) as Array<[AttackShape, number]>) {
      const f = family(id);
      if (f) (out.attack[el] ??= {})[shape] = f;
    }
  }
  return out;
}

// ─── Monster list matching (MLM) ────────────────────────────────────────────

export interface MatchContext {
  settings?: Record<string, string | number | boolean>;
  metastate?: string;
  /** Extra MLM variables the host knows (typeid, maxhp, hasshield …). */
  vars?: Record<string, string | number>;
}

/**
 * The row for a monster (MLM): the rows after <DEFAULT> top-down; the first
 * whose Name equals the monster's name (case-insensitive, INF), or whose
 * expression is true, wins; otherwise <DEFAULT>. An expression that does not
 * parse, or reads a variable we have no value for (typeid, maxhp, hasshield,
 * metastate when not given), does not match.
 */
export function matchMonsterRow(rows: VtMonsterRow[], m: CombatMonster, ctx: MatchContext = {}): VtMonsterRow {
  const def = rows.find((r) => r.name === '<DEFAULT>') ?? rows[0];
  for (const r of rows) {
    if (r === def) continue;
    if (r.expr) {
      try { if (mlmTruthy(evalMlm(r.name, m, ctx))) return r; } catch { /* no match */ }
    } else if (r.name.trim().toLowerCase() === m.name.trim().toLowerCase()) return r;
  }
  return def;
}

type MlmValue = number | string;
class MlmError extends Error {}

const MLM_OPS = ['&&', '||', '!=', '==', '>=', '<=', '>', '<', '#', '+', '-', '*', '/', '%', '(', ')'] as const;
type MlmTok = { op: string } | { word: string } | { lit: string };

function lexMlm(src: string): MlmTok[] {
  const toks: MlmTok[] = [];
  let i = 0;
  let word = '';
  let escaped = false;
  const flush = () => {
    const w = word.trim();
    if (w || escaped) toks.push(escaped ? { lit: word.trim() } : { word: w });
    word = ''; escaped = false;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { word += src[i + 1] ?? ''; escaped = true; i += 2; continue; }
    const op = MLM_OPS.find((o) => src.startsWith(o, i));
    if (op) { flush(); toks.push({ op }); i += op.length; continue; }
    word += c; i++;
  }
  flush();
  return toks;
}

/** MLM operator precedence, loosest first (MLM: `( ) % / * + - # != == > < >= <= && ||`). */
const MLM_LEVELS: string[][] = [['||'], ['&&'], ['!=', '==', '>', '<', '>=', '<='], ['#'], ['+', '-'], ['%', '/', '*']];

function evalMlm(src: string, m: CombatMonster, ctx: MatchContext): MlmValue {
  const toks = lexMlm(src);
  let p = 0;
  const peekOp = (): string | undefined => { const t = toks[p]; return t && 'op' in t ? t.op : undefined; };
  const atom = (): MlmValue => {
    const t = toks[p++];
    if (!t) throw new MlmError('unexpected end');
    if ('op' in t) {
      if (t.op === '(') { const v = level(0); if (peekOp() !== ')') throw new MlmError('missing )'); p++; return v; }
      if (t.op === '-') { const v = atom(); return -num(v); }
      throw new MlmError(`unexpected ${t.op}`);
    }
    if ('lit' in t) return t.lit;
    return variable(t.word, m, ctx);
  };
  const level = (n: number): MlmValue => {
    if (n >= MLM_LEVELS.length) return atom();
    let left = level(n + 1);
    for (let op = peekOp(); op && MLM_LEVELS[n].includes(op); op = peekOp()) {
      p++;
      left = binary(op, left, level(n + 1));
    }
    return left;
  };
  const v = level(0);
  if (p !== toks.length) throw new MlmError('trailing input');
  return v;
}

function variable(word: string, m: CombatMonster, ctx: MatchContext): MlmValue {
  const k = word.toLowerCase();
  if (/^-?\d+(\.\d+)?$/.test(word)) return Number(word);
  if (k === 'true') return 1;
  if (k === 'false') return 0;
  if (k === 'name') return m.name;
  if (k === 'range') return m.dist;
  if (k === 'species') { if (m.species === undefined) throw new MlmError('no species'); return m.species; }
  if (k === 'metastate') { if (ctx.metastate === undefined) throw new MlmError('no metastate'); return ctx.metastate; }
  if (word.startsWith('setting_')) { // case-sensitive (MLM)
    const v = ctx.settings?.[word.slice('setting_'.length)];
    if (v === undefined) throw new MlmError('no setting');
    return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }
  if (ctx.vars && k in ctx.vars) return ctx.vars[k];
  if (k === 'typeid' || k === 'maxhp' || k === 'hasshield') throw new MlmError(`no ${k}`);
  return word; // unknown identifiers are strings (MLM)
}

const isNum = (v: MlmValue): boolean => typeof v === 'number' || (v.trim() !== '' && Number.isFinite(Number(v)));
const num = (v: MlmValue): number => { if (!isNum(v)) throw new MlmError(`not a number: ${v}`); return Number(v); };

function binary(op: string, a: MlmValue, b: MlmValue): MlmValue {
  switch (op) {
    case '||': return mlmTruthy(a) || mlmTruthy(b) ? 1 : 0;
    case '&&': return mlmTruthy(a) && mlmTruthy(b) ? 1 : 0;
    case '#': return new RegExp(String(b), 'i').test(String(a)) ? 1 : 0;
    case '+': return isNum(a) && isNum(b) ? num(a) + num(b) : String(a) + String(b);
    case '-': return num(a) - num(b);
    case '*': return num(a) * num(b);
    case '/': return num(a) / num(b);
    case '%': return num(a) % num(b);
  }
  // Comparisons: numeric when both sides are numbers, else case-insensitive strings (MLM).
  const both = isNum(a) && isNum(b);
  const x: number | string = both ? num(a) : String(a).toLowerCase();
  const y: number | string = both ? num(b) : String(b).toLowerCase();
  switch (op) {
    case '==': return x === y ? 1 : 0;
    case '!=': return x !== y ? 1 : 0;
    case '>': return x > y ? 1 : 0;
    case '<': return x < y ? 1 : 0;
    case '>=': return x >= y ? 1 : 0;
    case '<=': return x <= y ? 1 : 0;
  }
  throw new MlmError(`unknown operator ${op}`);
}

function mlmTruthy(v: MlmValue): boolean {
  if (typeof v === 'number') return v !== 0;
  const s = v.trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false';
}

// ─── Settings ───────────────────────────────────────────────────────────────

function setting(settings: Record<string, string | number | boolean>, name: string): string | number | boolean {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(settings)) {
    if (k.toLowerCase() === want || vtOption(k)?.name.toLowerCase() === want) return v;
  }
  return vtOption(name)?.default ?? 0;
}
const numSetting = (s: CombatInput['settings'], name: string): number => { const v = setting(s, name); return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : Number(v) || 0; };
const boolSetting = (s: CombatInput['settings'], name: string): boolean => { const v = setting(s, name); return v === true || v === 1 || (typeof v === 'string' && /^(true|1)$/i.test(v)); };

// ─── Targets ────────────────────────────────────────────────────────────────

interface Candidate { m: CombatMonster; row: VtMonsterRow }

/** Monsters within AttackDistance (and beyond AttackMinimumDistance) whose row is not priority -1, best first. */
function candidates(input: CombatInput): Candidate[] {
  const max = numSetting(input.settings, 'AttackDistance');
  const min = numSetting(input.settings, 'AttackMinimumDistance');
  const method = numSetting(input.settings, 'TargetSelectMethod');
  const angleRange = numSetting(input.settings, 'TargetSelectAngleRange');
  const ctx: MatchContext = { settings: input.settings };
  const list: Candidate[] = [];
  for (const m of input.monsters) {
    if (m.dist > max || m.dist < min) continue;
    const row = matchMonsterRow(input.rows, m, ctx);
    if (row.priority < 0) continue;
    list.push({ m, row });
  }
  const turn = (c: Candidate) => Math.abs(c.m.relBearing);
  list.sort((a, b) => {
    if (a.row.priority !== b.row.priority) return b.row.priority - a.row.priority;
    if (method === 1) return a.m.dist - b.m.dist;
    if (method === 2) return turn(a) - turn(b);
    // Both: nearer than TargetSelectAngleRange goes by smallest turn, farther by distance (ADV).
    const an = a.m.dist < angleRange, bn = b.m.dist < angleRange;
    if (an !== bn) return an ? -1 : 1;
    return an ? turn(a) - turn(b) : a.m.dist - b.m.dist;
  });
  if (boolSetting(input.settings, 'TargetLock') && input.selectedGuid !== null) {
    // TargetLock: the selected monster unless a higher-priority one is present (FAQ).
    const i = list.findIndex((c) => c.m.guid === input.selectedGuid);
    if (i > 0 && list[i].row.priority >= list[0].row.priority) list.unshift(...list.splice(i, 1));
  }
  // Not modelled: VTank's preference for targets that need the weapon already wielded (CHG .113).
  return list;
}

export function pickTarget(input: CombatInput): CombatMonster | null {
  return candidates(input)[0]?.m ?? null;
}

// ─── Spells ─────────────────────────────────────────────────────────────────

/** AC skill ids of the magic schools (ACE.Entity/Enum/Skill.cs). */
const SCHOOL_SKILL: Record<string, number> = { 'creature enchantment': 31, 'item enchantment': 32, 'life magic': 33, 'war magic': 34, 'void magic': 43 };

function schoolSkill(input: CombatInput, school: string): PlanSkill | undefined {
  const k = school.toLowerCase();
  return input.skills.find((s) => s.name.toLowerCase() === k) ?? input.skills.find((s) => s.id === SCHOOL_SKILL[k]);
}

/**
 * The best spell of a family you can cast: the highest difficulty whose
 * difficulty + SpellDiffExcessThreshold-Hunt ≤ your buffed school skill (FAQ),
 * difficulty = the spell table's power (INF; the FAQ's 1/50/…/400 table is
 * the war ladder). Untrained magic cannot be used. DebuffSelectionMethod is
 * not modelled (its "Skill" algorithm is not public).
 */
function bestSpell(input: CombatInput, fam: CombatFamily | undefined): PlanSpell | null {
  if (!fam) return null;
  const threshold = numSetting(input.settings, 'SpellDiffExcessThreshold-Hunt');
  let best: PlanSpell | null = null;
  for (const s of input.spells) {
    if (!fam.ids.has(s.id) || s.self || s.buff) continue;
    const skill = schoolSkill(input, s.school);
    if (!skill || skill.training === 'untrained' || s.power + threshold > skill.buffed) continue;
    if (!best || s.power > best.power) best = s;
  }
  return best;
}

// ─── Elements and weapons ───────────────────────────────────────────────────

const VT_TO_ELEMENT: Partial<Record<number, CombatElement>> = {
  [VT_DAMAGE.Pierce]: 'pierce', [VT_DAMAGE.Bludgeon]: 'bludgeon', [VT_DAMAGE.Slash]: 'slash', [VT_DAMAGE.Acid]: 'acid',
  [VT_DAMAGE.Lightning]: 'lightning', [VT_DAMAGE.Cold]: 'cold', [VT_DAMAGE.Fire]: 'fire', [VT_DAMAGE.Void]: 'nether',
};
/** ACE DamageType bits (ACE.Entity/Enum/DamageType.cs) → element, in ACE's bit order. */
const ACE_DAMAGE_BITS: Array<[number, CombatElement]> = [[0x1, 'slash'], [0x2, 'pierce'], [0x4, 'bludgeon'], [0x8, 'cold'], [0x10, 'fire'], [0x20, 'acid'], [0x40, 'lightning'], [0x400, 'nether']];
/** PropertyInt.DamageType (ACE). */
const PROP_DAMAGE_TYPE = 45;
/** ACE ItemType bits. */
const IT_MELEE = 0x1, IT_MISSILE = 0x100, IT_CASTER = 0x8000;

type WeaponKind = 'melee' | 'missile' | 'caster';
function weaponKind(item: PlanItem | undefined): WeaponKind {
  const t = item?.itemType ?? 0;
  if (t & IT_CASTER) return 'caster';
  if (t & IT_MISSILE) return 'missile';
  return 'melee'; // a melee weapon, or bare hands
}
const isWeapon = (item: PlanItem): boolean => ((item.itemType ?? 0) & (IT_MELEE | IT_MISSILE | IT_CASTER)) !== 0;

const findItem = (input: CombatInput, name: string | undefined): PlanItem | undefined =>
  name ? input.items.find((i) => i.name.toLowerCase() === name.toLowerCase()) : undefined;
const isWielded = (input: CombatInput, item: PlanItem, slot: 'weapon' | 'offhand'): boolean =>
  item.equipped === true || (input.wielded[slot]?.toLowerCase() === item.name.toLowerCase());

/**
 * The weapon a row fights with. A named Weapon you carry is used; "Any Wand"
 * is a carried caster (the wielded one first). <AUTO> (and a named weapon you
 * no longer carry) keeps what you wield; with nothing wielded, the first
 * weapon / caster on the Items tab that you carry. INF: VTank's real auto
 * choice also weighs its game-info damage DB and rend weapons, which are not
 * public.
 */
function rowWeapon(input: CombatInput, row: VtMonsterRow): PlanItem | undefined {
  if (row.weapon && row.weapon.toLowerCase() === 'any wand') {
    const casters = input.items.filter((i) => weaponKind(i) === 'caster');
    const w = casters.find((i) => isWielded(input, i, 'weapon')) ?? casters[0];
    if (w) return w;
  } else if (row.weapon) {
    const named = findItem(input, row.weapon);
    if (named) return named;
  }
  const current = findItem(input, input.wielded.weapon) ?? input.items.find((i) => i.equipped && isWeapon(i));
  if (current) return current;
  for (const n of input.itemNames) { const it = findItem(input, n); if (it && isWeapon(it)) return it; }
  return undefined;
}

/**
 * The element a row's damage means. A specific Dmg type is that element (Void
 * = nether). Auto (and the modes we do not model: Harm, DrainAuto, Prismatic,
 * Random, Fists) is, in order: the weapon's examined DamageType; nether when
 * Void Magic is trained and War Magic is not (FAQ); the first element (VTank
 * enum order) whose bolt you can cast. INF: VTank's real Auto reads a
 * per-monster damage list from its game-info DB, which is not public.
 */
function resolveElement(input: CombatInput, damage: number, weapon: PlanItem | undefined): CombatElement | null {
  const fixed = VT_TO_ELEMENT[damage];
  if (fixed) return fixed;
  if (damage === VT_DAMAGE.None) return null;
  const bits = weapon?.ints?.[PROP_DAMAGE_TYPE];
  if (bits) for (const [bit, el] of ACE_DAMAGE_BITS) if (bits & bit) return el;
  const trained = (school: string) => { const s = schoolSkill(input, school); return !!s && s.training !== 'untrained'; };
  if (trained('Void Magic') && !trained('War Magic') && bestSpell(input, input.families.attack.nether?.bolt)) return 'nether';
  for (const el of ['pierce', 'bludgeon', 'slash', 'acid', 'lightning', 'cold', 'fire'] as CombatElement[]) {
    if (bestSpell(input, input.families.attack[el]?.bolt)) return el;
  }
  return null;
}

// ─── Debuffs ────────────────────────────────────────────────────────────────

/**
 * The debuff order. INF: VTank's order among checked columns is not public
 * (docs §11 item 6); F B G I Y V in column order is plausible, then the
 * Ex. Vuln, then the void columns WC FC Cp DC Cs in column order.
 */
const DEBUFF_ORDER: Array<VtMonsterColumn | 'X'> = ['F', 'B', 'G', 'I', 'Y', 'V', 'X', 'WC', 'FC', 'Cp', 'DC', 'Cs'];

function timeLeft(input: CombatInput, guid: number, category: number): number {
  let left = -Infinity;
  for (const c of input.castLog) {
    if (c.guid !== guid || c.category !== category) continue;
    left = Math.max(left, (c.at - input.now) / 1000 + c.duration);
  }
  return left;
}

/** The next debuff this monster needs, if any: a castable family member it lacks (or will lose within DebuffPrecastSeconds; DoTs only when gone). */
function nextDebuff(input: CombatInput, c: Candidate, weapon: PlanItem | undefined): { spell: PlanSpell; why: string } | null {
  const precast = numSetting(input.settings, 'DebuffPrecastSeconds');
  const element = resolveElement(input, c.row.damage, weapon);
  const exElement = c.row.exVuln === VT_DAMAGE.None ? null : resolveElement(input, c.row.exVuln, weapon);
  const done = new Set<number>();
  for (const col of DEBUFF_ORDER) {
    let fam: CombatFamily | undefined;
    if (col === 'X') fam = exElement ? input.families.vuln[exElement] : undefined;
    else {
      if (!c.row.on.includes(col)) continue;
      fam = col === 'V' ? (element ? input.families.vuln[element] : undefined) : input.families.debuff[col as DebuffColumn];
    }
    if (!fam || done.has(fam.category)) continue;
    done.add(fam.category);
    const spell = bestSpell(input, fam);
    if (!spell) continue; // the era lacks it, or you can't cast it
    const left = timeLeft(input, c.m.guid, fam.category);
    if (fam.dot ? left > 0 : left > precast) continue;
    const label = col === 'X' ? 'Ex. Vuln' : col;
    return { spell, why: `${label} on ${c.m.name}${left > 0 ? ` (${Math.round(left)} s left)` : ''}` };
  }
  return null;
}

// ─── The plan ───────────────────────────────────────────────────────────────

function needStance(input: CombatInput, to: Stance, why: string): CombatAction | null {
  return input.stance === to ? null : { kind: 'stance', to, why };
}

/** Equip the row's weapon / offhand when it isn't in hand. */
function equipFor(input: CombatInput, row: VtMonsterRow, weapon: PlanItem | undefined): CombatAction | null {
  if (weapon && !isWielded(input, weapon, 'weapon')) return { kind: 'equip', item: weapon, why: `${row.name} uses ${weapon.name}` };
  const off = findItem(input, row.offhand ?? undefined);
  if (off && !isWielded(input, off, 'offhand')) return { kind: 'equip', item: off, why: `${row.name} offhand ${off.name}` };
  return null;
}

function cast(input: CombatInput, spell: PlanSpell, target: number, why: string): CombatAction {
  return needStance(input, 'magic', `to cast ${spell.name}`) ?? { kind: 'cast', spell, target, why };
}

export function planCombat(input: CombatInput): CombatAction | null {
  const list = candidates(input);
  const top = list[0];
  if (!top) return null;
  const weapon = rowWeapon(input, top.row);
  const kind = weaponKind(weapon);

  // SwitchWandsToDebuff: a caster row weapon is wielded before debuffing too (ADV); otherwise weapons switch for the attack only.
  if (kind === 'caster' && boolSetting(input.settings, 'SwitchWandsToDebuff')) {
    const eq = equipFor(input, top.row, weapon);
    if (eq) return eq;
  }

  // Debuffs first, per DebuffEachFirst: 1 One (the target), 2 Priority (every monster of its priority), 3 All (CHG 0.3.0.19).
  const each = numSetting(input.settings, 'DebuffEachFirst');
  const toDebuff = each === 3 ? list : each === 2 ? list.filter((c) => c.row.priority === top.row.priority) : [top];
  for (const c of toDebuff) {
    const d = nextDebuff(input, c, rowWeapon(input, c.row));
    if (d) return cast(input, d.spell, c.m.guid, d.why);
  }

  const on = (col: VtMonsterColumn) => top.row.on.includes(col);
  if (!on('A') && !on('R')) return null; // debuff only (STD)

  const eq = equipFor(input, top.row, weapon);
  if (eq) return eq;

  const element = resolveElement(input, top.row.damage, weapon);
  const fams = element ? input.families.attack[element] : undefined;

  // Ring (STD): with A+R when ≥ MinimumRingTargets monsters are within RingDistance; with R only when any R monster is.
  if (on('R') && fams?.ring) {
    const ringDist = numSetting(input.settings, 'RingDistance');
    const inRing = list.filter((c) => c.m.dist <= ringDist);
    const ringNow = on('A') ? inRing.length >= numSetting(input.settings, 'MinimumRingTargets') : inRing.some((c) => c.row.on.includes('R'));
    const ring = ringNow ? bestSpell(input, fams.ring) : null;
    if (ring) return cast(input, ring, top.m.guid, `ring: ${inRing.length} within ${ringDist} m`);
  }
  // R only: war on targets outside ring range; inside it, nothing more (STD).
  if (!on('A') && top.m.dist <= numSetting(input.settings, 'RingDistance')) return null;

  if (kind === 'caster' || !weapon) {
    if (fams) {
      const streak = on('S') ? bestSpell(input, fams.streak) : null;
      if (streak) return cast(input, streak, top.m.guid, `streak at ${top.m.name}`);
      const bolt = bestSpell(input, fams.bolt);
      const useArcs = numSetting(input.settings, 'UseArcs');
      const arcOk = useArcs === 3 || (useArcs === 2 && top.m.dist >= numSetting(input.settings, 'ArcRange'));
      const arc = arcOk ? bestSpell(input, fams.arc) : null;
      // Arcs replace bolts when known at the best castable level (CHG 0.3.0.17).
      if (arc && (!bolt || arc.power >= bolt.power)) return cast(input, arc, top.m.guid, `arc at ${top.m.name}`);
      if (bolt) return cast(input, bolt, top.m.guid, `bolt at ${top.m.name}`);
    }
    if (kind === 'caster') return null; // a caster with no castable attack: nothing to do
  }
  const stance: Stance = kind === 'missile' ? 'missile' : 'melee';
  return needStance(input, stance, `to attack with ${weapon?.name ?? 'bare hands'}`) ?? { kind: 'attack', target: top.m.guid, why: `${top.row.name === '<DEFAULT>' ? 'default' : top.row.name} p${top.row.priority}` };
}
