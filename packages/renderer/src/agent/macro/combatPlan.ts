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
import { VT_DAMAGE, VT_PET_AUTO, vtOption, type PlanItem, type PlanSkill, type PlanSpell, type Stance, type VtMonsterColumn, type VtMonsterRow } from '@ac/shared';

export interface CombatMonster {
  guid: number; name: string; dist: number; relBearing: number;
  /** Its health fraction (0–1), as last reported (QueryHealth / the selection bar). */
  health?: number;
  species?: string;
  /** The points of the last blow you landed on it (combat text), for the streak finisher. */
  lastDamage?: number;
}

/**
 * What the era's world data says about a monster, by name (VirindiTank's game-info
 * DB: MonsterDamageOverrides / SpeciesDamages, SpeciesMembers; built per era by
 * tools/build-monster-tables.ts). `weak` is the seven elements most damaging
 * first; `maxHealth` its maximum health in points.
 */
export interface MonsterFacts { weak: CombatElement[]; maxHealth: number }

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
  /** [0, 1) random numbers for the Random damage type (default Math.random). */
  random?: () => number;
  /** The era's monster table, by name (case-insensitive); absent or unlisted: VTank's unlisted-monster behaviour. */
  monsterFacts?: (name: string) => MonsterFacts | undefined;
}

export type CombatAction =
  | { kind: 'cast'; spell: PlanSpell; target: number; why: string }
  /** `element`: what the row's Dmg resolved to, for the swing's power bar (attackPower.ts). */
  | { kind: 'attack'; target: number; why: string; element?: CombatElement | null }
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
  /** Life Magic Harm Other (the Harm damage type), Drain Health Other (Drain Auto) and Tusker Fists (Fists), when the era has them. */
  harm?: CombatFamily;
  drain?: CombatFamily;
  fists?: CombatFamily;
}

/** ACE SpellFlags (ACE.Entity/Enum/SpellFlags.cs). */
const SF_BENEFICIAL = 0x4;
const SF_SELF_TARGETED = 0x8;
const SF_REVERSED = 0x10;
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

/**
 * The non-elemental attack modes' anchors (ACE SpellId). Their categories hold
 * other spells too, told apart by SpellFlags.Reversed (0x10, a drain): Harm
 * Other's category also has Martyr's Hecatomb (no Reversed; it spends a quarter
 * of YOUR health), Drain Health Other's has Health to Stamina / Mana Other (no
 * Reversed; they move the target's own vitals). Tusker Fists' category 230 also
 * holds creature walls (Hammering Crawler, Spray of Coins), so it is a family
 * of one.
 */
const HARM_ANCHOR = 7; // HarmOther1
const DRAIN_ANCHOR = 1237; // DrainHealth1 ("Drain Health Other I")
const FISTS_ANCHOR = 2934; // TuskerFists

export interface CombatSpellTableEntry { name: string; category: number; school: number; bitfield: number; power: number; duration?: number; desc?: string }

export function buildCombatFamilies(spellTable: { spells: Map<number, CombatSpellTableEntry> }): CombatFamilies {
  const byCategory = new Map<number, Array<[number, CombatSpellTableEntry]>>();
  for (const e of spellTable.spells) {
    let l = byCategory.get(e[1].category);
    if (!l) byCategory.set(e[1].category, (l = []));
    l.push(e);
  }
  const family = (anchor: number, opts: { sameFlags?: number; only?: boolean } = {}): CombatFamily | undefined => {
    const a = spellTable.spells.get(anchor);
    if (!a) return undefined; // this era lacks the family
    const arc = (a.bitfield & SF_NON_TRACKING_PROJECTILE) !== 0;
    const ids = new Set<number>();
    const members: Array<[number, CombatSpellTableEntry]> = opts.only ? [[anchor, a]] : byCategory.get(a.category) ?? [];
    for (const [id, s] of members) {
      if (s.school !== a.school) continue;
      if (opts.sameFlags && (s.bitfield & opts.sameFlags) !== (a.bitfield & opts.sameFlags)) continue;
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
  const harm = family(HARM_ANCHOR, { sameFlags: SF_REVERSED });
  if (harm) out.harm = harm;
  const drain = family(DRAIN_ANCHOR, { sameFlags: SF_REVERSED });
  if (drain) out.drain = drain;
  const fists = family(FISTS_ANCHOR, { only: true });
  if (fists) out.fists = fists;
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

/** Monsters within AttackDistance (or `maxRange`; and beyond AttackMinimumDistance) whose row is not priority -1, best first. */
function candidates(input: CombatInput, maxRange?: number): Candidate[] {
  const max = maxRange ?? numSetting(input.settings, 'AttackDistance');
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
 * the war ladder). Untrained magic cannot be used.
 *
 * Debuffs follow DebuffSelectionMethod (USD enum 1 Spell Level, 2 Skill, the
 * default): Skill picks the level by your buffed skill against the spell's
 * difficulty (the threshold rule above, as for attacks); Spell Level picks the
 * highest level you know in a school you have trained, whatever your skill.
 * INF: VTank's exact algorithm is not public (ADV: "Select 'Skill' when
 * fighting monsters with high magic defense").
 */
function bestSpell(input: CombatInput, fam: CombatFamily | undefined, debuff = false): PlanSpell | null {
  if (!fam) return null;
  const threshold = debuff && numSetting(input.settings, 'DebuffSelectionMethod') === 1 ? -Infinity : numSetting(input.settings, 'SpellDiffExcessThreshold-Hunt');
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

const ALL_ELEMENTS: CombatElement[] = ['pierce', 'bludgeon', 'slash', 'acid', 'lightning', 'cold', 'fire', 'nether'];
/** One Random pick per decision, so the V column's vuln and the attack agree. */
const randomPick = new WeakMap<CombatInput, CombatElement | null>();

/** VTank's element order for a monster its database doesn't list (MOSS VtankDamageDatabase.UnlistedElementOrder). */
const UNLISTED_ORDER: CombatElement[] = ['pierce', 'bludgeon', 'slash', 'acid', 'lightning', 'cold', 'fire'];
const TABLE_LETTER: Record<string, CombatElement> = { p: 'pierce', b: 'bludgeon', s: 'slash', a: 'acid', l: 'lightning', c: 'cold', f: 'fire' };

/** The era's monster table rows ([name, weak letters, maxHealth]; tools/build-monster-tables.ts) as a by-name lookup. */
export function indexMonsterTable(rows: Array<[string, string, number]>): (name: string) => MonsterFacts | undefined {
  const map = new Map<string, MonsterFacts>();
  for (const [name, weak, maxHealth] of rows) {
    map.set(name.trim().toLowerCase(), { weak: [...weak].flatMap((c) => (TABLE_LETTER[c] ? [TABLE_LETTER[c]] : [])), maxHealth });
  }
  return (name) => map.get(name.trim().toLowerCase());
}

/**
 * Whether this fight can deal an element: a launcher when you carry ammunition
 * of it (or prismatic) that it takes; a caster (or bare hands) when you can
 * cast its bolt; a melee weapon always, since only its own element (handled
 * before this) or the vuln changes (MOSS CanDeliverElement limits only a
 * launcher; the bolt rule is ours, so a mage's Auto names an element it casts).
 */
function canDeliver(input: CombatInput, el: CombatElement, weapon: PlanItem | undefined): boolean {
  const kind = weaponKind(weapon);
  if (kind === 'missile') return ammoOf(input, weapon, el, 'any') !== null;
  if (kind === 'caster' || !weapon) return bestSpell(input, input.families.attack[el]?.bolt) !== null;
  return true;
}

/**
 * The element a row's damage means. A specific Dmg type is that element (Void
 * = nether). Harm and Drain Auto are not elemental (Life Magic drains), so V
 * casts no element vuln for them. Fists is bludgeoning (ACE spell 2934 Tusker
 * Fists, e_Type Bludgeon). Random (CHG .113) is a random element among those
 * whose bolt you can cast, picked once per decision. Auto and Prismatic (MOSS
 * CombatController.ResolveAttackElementCore; Prismatic differs only in the
 * ammunition it takes) are, in order: the weapon's own examined DamageType;
 * nether when Void Magic is trained and War Magic is not (FAQ); the monster's
 * weak elements from the era's monster table, most damaging first, that you
 * can deal (canDeliver); else (a monster the table doesn't list, or nothing of
 * its list deliverable) the first element in VTank's unlisted order whose bolt
 * you can cast.
 */
function resolveElement(input: CombatInput, damage: number, weapon: PlanItem | undefined, m?: CombatMonster): CombatElement | null {
  const fixed = VT_TO_ELEMENT[damage];
  if (fixed) return fixed;
  if (damage === VT_DAMAGE.None || damage === VT_DAMAGE.Harm || damage === VT_DAMAGE.DrainAuto) return null;
  if (damage === VT_DAMAGE.Fists) return 'bludgeon';
  if (damage === VT_DAMAGE.Random) {
    if (!randomPick.has(input)) {
      const can = ALL_ELEMENTS.filter((el) => bestSpell(input, input.families.attack[el]?.bolt));
      randomPick.set(input, can.length ? can[Math.min(can.length - 1, Math.floor((input.random ?? Math.random)() * can.length))] : null);
    }
    const r = randomPick.get(input);
    if (r) return r;
  }
  const bits = weapon?.ints?.[PROP_DAMAGE_TYPE];
  if (bits) for (const [bit, el] of ACE_DAMAGE_BITS) if (bits & bit) return el;
  const trained = (school: string) => { const s = schoolSkill(input, school); return !!s && s.training !== 'untrained'; };
  if (trained('Void Magic') && !trained('War Magic') && bestSpell(input, input.families.attack.nether?.bolt)) return 'nether';
  const weak = m ? input.monsterFacts?.(m.name)?.weak ?? [] : [];
  for (const el of weak) if (canDeliver(input, el, weapon)) return el;
  for (const el of UNLISTED_ORDER) if (bestSpell(input, input.families.attack[el]?.bolt)) return el;
  return null;
}

// ─── Ammunition ─────────────────────────────────────────────────────────────

/** PropertyInt.Damage / AmmoType / WieldRequirements / WieldSkillType / WieldDifficulty (ACE). */
const PROP_DAMAGE = 44, PROP_AMMO_TYPE = 50, PROP_WIELD_REQ = 158, PROP_WIELD_SKILL = 159, PROP_WIELD_DIFF = 160;
/** UiEffects element glows (Fire 0x20, Lightning 0x40, Frost 0x80, Acid 0x100), seen without an examination. */
const UI_EFFECT_ELEMENTS: Array<[number, CombatElement]> = [[0x20, 'fire'], [0x40, 'lightning'], [0x80, 'cold'], [0x100, 'acid']];
type AmmoElement = CombatElement | 'prismatic' | null;

const isAmmo = (i: PlanItem): boolean => /(^|\+)MissileAmmo(\+|$)/.test(i.fits ?? i.slot ?? '');
/** An ammunition stack's element: its examined DamageType, else its UiEffects glow. Prismatic ammo has no element of its own (see ammoFor). */
function ammoElement(i: PlanItem): AmmoElement {
  if (/prismatic/i.test(i.name)) return 'prismatic';
  const bits = i.ints?.[PROP_DAMAGE_TYPE];
  if (bits) for (const [bit, el] of ACE_DAMAGE_BITS) if (bits & bit) return el;
  for (const [bit, el] of UI_EFFECT_ELEMENTS) if ((i.uiEffects ?? 0) & bit) return el;
  return null;
}
/** Its wield requirement, when it has one the planner can check (a skill, buffed or base). */
function canWield(input: CombatInput, i: PlanItem): boolean {
  const req = i.ints?.[PROP_WIELD_REQ];
  if (req !== 1 && req !== 2) return true;
  const sk = input.skills.find((x) => x.id === i.ints?.[PROP_WIELD_SKILL]);
  return !!sk && (req === 1 ? sk.buffed : sk.base) >= (i.ints?.[PROP_WIELD_DIFF] ?? 0);
}

/**
 * The ammunition a missile row shoots, VTank's way (facts from openac-mosstank's
 * reading of VTank, docs/vtank-macro-behavior.md §4): only ammo the launcher takes
 * (AmmoType), of the row's element or prismatic, the highest damage that you
 * can wield. Dmg type Prismatic (11) wants prismatic ammo first; Auto takes
 * either; a named element takes prismatic only when nothing of that element is
 * carried. With no element to want (Auto on a plain launcher), the best ammo
 * of any element. Launcher and ammo match by AmmoType (their public description, else the examination).
 * Auto / Prismatic want the monster's weak element you carry ammunition for
 * (resolveElement with the era's monster table), so the arrows swap per monster.
 */
export function ammoFor(input: CombatInput, row: VtMonsterRow, launcher: PlanItem | undefined, m?: CombatMonster): PlanItem | null {
  const wanted = resolveElement(input, row.damage === VT_DAMAGE.Prismatic ? VT_DAMAGE.Auto : row.damage, launcher, m);
  const policy = row.damage === VT_DAMAGE.Prismatic ? 'force' : row.damage === VT_DAMAGE.Auto ? 'any' : 'none';
  return ammoOf(input, launcher, wanted, policy);
}

/** The best carried ammunition the launcher takes, of `wanted` (or prismatic, per policy), or of any element with none wanted. */
function ammoOf(input: CombatInput, launcher: PlanItem | undefined, wanted: CombatElement | null, policy: 'force' | 'any' | 'none'): PlanItem | null {
  const ammoTypeOf = (i: PlanItem | undefined) => i?.ammoType ?? i?.ints?.[PROP_AMMO_TYPE];
  const type = ammoTypeOf(launcher);
  if (!type) return null;
  let best: PlanItem | null = null;
  let bestScore = -Infinity;
  for (const a of input.items) {
    if (!isAmmo(a) || ammoTypeOf(a) !== type || (a.stack ?? 1) < 1 || !canWield(input, a)) continue;
    const el = ammoElement(a);
    let score = a.ints?.[PROP_DAMAGE] ?? 0;
    if (policy === 'force' && el !== 'prismatic') score -= 1000;
    if (wanted && el !== wanted) {
      if (el !== 'prismatic') continue;
      if (policy === 'none') score -= 1000;
    }
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return best;
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
  const element = resolveElement(input, c.row.damage, weapon, c.m);
  const exElement = c.row.exVuln === VT_DAMAGE.None ? null : resolveElement(input, c.row.exVuln, weapon, c.m);
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
    const spell = bestSpell(input, fam, true);
    if (!spell) continue; // the era lacks it, or you can't cast it
    const left = timeLeft(input, c.m.guid, fam.category);
    if (fam.dot ? left > 0 : left > precast) continue;
    const label = col === 'X' ? 'Ex. Vuln' : col;
    return { spell, why: `${label} on ${c.m.name}${left > 0 ? ` (${Math.round(left)} s left)` : ''}` };
  }
  return null;
}

// ─── The streak finisher ────────────────────────────────────────────────────

/**
 * Whether the monster is hurt enough for the streak to finish it (VTank, from
 * MOSS CombatController.IsFinishingBlow and MonsterHealthTracker): its health
 * left in points (the reported fraction × its maximum health from the era's
 * monster table; the full maximum before any report) is above 0 and below a
 * seventh of your last blow on it, or, before you have landed one, a seventh
 * of the streak's difficulty (integer division). A monster the table doesn't
 * list has no points to compare, so it is never finished with a streak.
 * INF: MOSS also takes each later blow off the estimate until the next health
 * report; we use the latest reported fraction.
 */
export function isFinishingBlow(input: CombatInput, m: CombatMonster, streak: PlanSpell): boolean {
  const max = input.monsterFacts?.(m.name)?.maxHealth ?? 0;
  if (max <= 0) return false;
  const remaining = m.health === undefined ? max : Math.round(m.health * max);
  const threshold = Math.floor((m.lastDamage && m.lastDamage > 0 ? m.lastDamage : streak.power) / 7);
  return remaining > 0 && remaining < threshold;
}

/**
 * The points of a blow you landed on `name`, from a combat chat line (melee:
 * "You hit Drudge Skulker for 12 points of slashing damage!", CombatDialog
 * formatAttackerChat; war magic: ACE SpellProjectile "You scorch Drudge
 * Skulker for 40 points with Flame Bolt VI."), or null.
 */
export function blowPoints(text: string, name: string): number | null {
  const at = text.indexOf(`You `);
  if (at < 0) return null;
  const m = /^You \S+ (.+?) for (\d+) points?\b/.exec(text.slice(at));
  return m && m[1].toLowerCase() === name.toLowerCase() ? Number(m[2]) : null;
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

const trainedIn = (input: CombatInput, school: string): boolean => { const s = schoolSkill(input, school); return !!s && s.training !== 'untrained'; };

/**
 * Harm: the best Harm Other you can cast. Fists: Tusker Fists (VTank leaves
 * the positioning to you and aims from .116, as our cast at the target does).
 * Drain Auto (also Auto with neither War nor Void Magic trained, FAQ .112):
 * Drain Health Other takes a share of the target's CURRENT health, so it is
 * cast while the target is at half health or more (or reports none), and
 * Harm Other's fixed damage finishes it below that. INF: VTank's exact drain
 * choice (CHG .168 changed it for monsters that report no health) is not
 * public; the half-health switch is ours.
 */
function magicModeAttack(input: CombatInput, top: Candidate): { spell: PlanSpell; why: string } | null {
  const d = top.row.damage;
  const name = top.m.name;
  if (d === VT_DAMAGE.Harm) { const s = bestSpell(input, input.families.harm); return s ? { spell: s, why: `harm at ${name}` } : null; }
  if (d === VT_DAMAGE.Fists) { const s = bestSpell(input, input.families.fists); return s ? { spell: s, why: `fists at ${name}` } : null; }
  const drainMode = d === VT_DAMAGE.DrainAuto || (d === VT_DAMAGE.Auto && !trainedIn(input, 'War Magic') && !trainedIn(input, 'Void Magic'));
  if (!drainMode) return null;
  const drain = bestSpell(input, input.families.drain);
  const harm = bestSpell(input, input.families.harm);
  const healthy = top.m.health === undefined || top.m.health >= 0.5;
  if (drain && (healthy || !harm)) return { spell: drain, why: `drain at ${name}` };
  if (harm) return { spell: harm, why: `harm at ${name} (low health)` };
  return null;
}

// ─── Pets ───────────────────────────────────────────────────────────────────

/** UiEffects bits (ACE.Entity/Enum/UiEffects.cs) → element. */
const UI_EFFECT_ELEMENT: Array<[number, CombatElement]> = [[0x20, 'fire'], [0x40, 'lightning'], [0x80, 'cold'], [0x100, 'acid'], [0x200, 'bludgeon'], [0x400, 'slash'], [0x800, 'pierce'], [0x1000, 'nether']];

/**
 * A summoning essence's element, from what the client sees: its UiEffects in
 * the object's public description (the icon's element glow). ACE's
 * PetDevice.PetDeviceToPetMapping (essence → pet + DamageType) is server code
 * a client can't read, but in the ACE world DB every essence it gives an
 * element carries the matching UiEffects (Fire 0x20, Lightning 0x40, Frost
 * 0x80, Acid 0x100: 252 of 252); the golem essences show only Magical (0x1),
 * so they have no element here.
 */
export function petDeviceElement(item: PlanItem): CombatElement | null {
  const u = item.uiEffects ?? 0;
  for (const [bit, el] of UI_EFFECT_ELEMENT) if (u & bit) return el;
  return null;
}

export interface PetPlan { device: PlanItem; element: CombatElement | null; count: number; why: string }

/**
 * VirindiTank's Summon Pets choice (CHG .156/.157): monsters within pet range
 * (not beyond it: the caller passes Monster Range or Custom Pet Range) whose
 * row is not priority -1 and whose PetDmg is not None count towards Pet Min.
 * Monsters. The element comes from the highest-priority one's PetDmg: PAuto =
 * the element your own Dmg type resolves to for it, else the Auto element;
 * Auto = the Auto element; an element = only that element. The device is the
 * first pet device (Items-tab order) of that element. INF: with PAuto / Auto
 * and no essence of either element, the first device is used.
 */
export function planPet(input: CombatInput, opts: { range: number; minMonsters: number; devices: PlanItem[] }): PetPlan | null {
  if (!opts.devices.length) return null;
  const counted = candidates(input, opts.range).filter((c) => c.row.petDamage !== VT_DAMAGE.None);
  if (counted.length < Math.max(1, opts.minMonsters)) return null;
  const top = counted[0];
  const weapon = rowWeapon(input, top.row);
  const byElement = (el: CombatElement | null) => (el ? opts.devices.find((d) => petDeviceElement(d) === el) : undefined);
  const why = (d: PlanItem) => `${counted.length} within ${Math.round(opts.range)} m, ${top.m.name} first: ${d.name}`;
  const pd = top.row.petDamage;
  if (pd === VT_PET_AUTO || pd === VT_DAMAGE.Auto) {
    const mine = pd === VT_PET_AUTO ? byElement(resolveElement(input, top.row.damage, weapon, top.m)) : undefined;
    const d = mine ?? byElement(resolveElement(input, VT_DAMAGE.Auto, weapon, top.m)) ?? opts.devices[0];
    return { device: d, element: petDeviceElement(d), count: counted.length, why: why(d) };
  }
  const want = VT_TO_ELEMENT[pd] ?? null;
  const d = byElement(want);
  return d ? { device: d, element: want, count: counted.length, why: why(d) } : null;
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
  if (!on('A') && !on('R') && !on('S')) return null; // debuff only (STD)

  const eq = equipFor(input, top.row, weapon);
  if (eq) return eq;

  const element = resolveElement(input, top.row.damage, weapon, top.m);
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
  if (!on('A') && !on('S') && top.m.dist <= numSetting(input.settings, 'RingDistance')) return null;

  if (kind === 'caster' || !weapon) {
    if (fams) {
      // S alone streaks every time; A with S streaks only as the finisher (MOSS CombatController: PlanStreak / IsFinishingBlow).
      const streak = on('S') ? bestSpell(input, fams.streak) : null;
      if (streak && (!on('A') || isFinishingBlow(input, top.m, streak))) return cast(input, streak, top.m.guid, on('A') ? `streak to finish ${top.m.name}` : `streak at ${top.m.name}`);
      const bolt = bestSpell(input, fams.bolt);
      const useArcs = numSetting(input.settings, 'UseArcs');
      const arcOk = useArcs === 3 || (useArcs === 2 && top.m.dist >= numSetting(input.settings, 'ArcRange'));
      const arc = arcOk ? bestSpell(input, fams.arc) : null;
      // Arcs replace bolts when known at the best castable level (CHG 0.3.0.17).
      if (arc && (!bolt || arc.power >= bolt.power)) return cast(input, arc, top.m.guid, `arc at ${top.m.name}`);
      if (bolt) return cast(input, bolt, top.m.guid, `bolt at ${top.m.name}`);
    }
    // The Life Magic / Tusker Fists modes (FAQ: "Void Basic, Drain Auto or Harm"; Auto with neither War nor Void trained is Drain Auto).
    const m = magicModeAttack(input, top);
    if (m) return cast(input, m.spell, top.m.guid, m.why);
    if (kind === 'caster') return null; // a caster with no castable attack: nothing to do
  }
  // A launcher shoots the row's ammunition (VTank swaps arrows per monster).
  if (kind === 'missile') {
    const ammo = ammoFor(input, top.row, weapon, top.m);
    if (ammo && !(ammo.equipped && /MissileAmmo/.test(ammo.slot ?? 'MissileAmmo'))) return { kind: 'equip', item: ammo, why: `${top.row.name} shoots ${ammo.name}` };
  }
  const stance: Stance = kind === 'missile' ? 'missile' : 'melee';
  return needStance(input, stance, `to attack with ${weapon?.name ?? 'bare hands'}`) ?? { kind: 'attack', target: top.m.guid, why: `${top.row.name === '<DEFAULT>' ? 'default' : top.row.name} p${top.row.priority}`, element };
}
