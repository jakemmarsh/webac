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
import { PropertyInt, VT_DAMAGE, VT_DEFAULT_MONSTER, VT_PET_AUTO, vtOption, type PlanItem, type PlanSkill, type PlanSpell, type Stance, type VtMonsterColumn, type VtMonsterRow } from '@ac/shared';
import { pickLadderWeapon, weaponElement } from './weaponLadder.ts';
import { debuffSources, type DebuffSource, type DebuffSpellInfo } from './itemDebuffs.ts';
import { planDrain, type DrainRow } from './drainPlan.ts';
import { useRequirementProblem } from './itemUse.ts';

export interface CombatMonster {
  guid: number; name: string; dist: number; relBearing: number;
  /** Its health fraction (0–1), as last reported (QueryHealth / the selection bar). */
  health?: number;
  species?: string;
  /** The points of the last blow you landed on it (combat text), for the streak finisher. */
  lastDamage?: number;
  /** A bolt or an arrow at it would hit a wall, the ground or an object first (UseProjectileAwareness; the client's line-of-fire test). */
  blocked?: boolean;
  /** The server has answered "You fail to affect …" to a debuff at it: it is immune to spells that aren't projectiles. */
  magicImmune?: boolean;
  /**
   * Beyond VTank (ProtectFellows, beyondVtank.ts): it is on a fellow. Fought before the others of its priority (after a
   * TargetLock pick), and a candidate out past Monster Range (the macro bounds it by ProtectFellowsDistance).
   */
  onFellow?: boolean;
  /**
   * Beyond VTank: its blows (hits, misses, evades) at you came in the last 10 s of combat lines (AgentApi.attackersOfMe).
   * When the last target is gone, one hitting you is the next target after what is on a fellow (ProtectFellows) and
   * before the selection the client's Auto Target made (TargetLock) or a nearer monster that isn't (candidates).
   */
  hittingYou?: boolean;
}

/**
 * What the era's world data says about a monster, by name (VirindiTank's game-info
 * DB: MonsterDamageOverrides / SpeciesDamages, SpeciesMembers; built per era by
 * tools/build-monster-tables.ts). `weak` is the seven elements most damaging
 * first; `maxHealth` its maximum health in points.
 */
export interface MonsterFacts {
  weak: CombatElement[]; maxHealth: number;
  /** What each element of `weak` does against it (its Resist* multiplier: 1 full damage, 0.5 half); absent: not known. */
  resist?: Partial<Record<CombatElement, number>>;
  /** CreatureType (what a slayer names); undefined when the table doesn't say. */
  species?: number;
  /** NonProjectileMagicImmune: debuffs, drains and Harm never land. */
  magicImmune?: boolean;
  /** ResistHealthDrain 0: Drain Health takes nothing. */
  drainImmune?: boolean;
}

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
  /** The monster the macro's last combat action went to (VTank's sticky last target). */
  lastTarget?: number | null;
  /** The monster the player last attacked or cast at by hand (RoutineEngine.pickedTarget): with TargetLock, theirs first. */
  pickedByHand?: number | null;
  /**
   * The Items tab's Hands column for a carried item: 2 two-handed (no offhand is wielded with it), 1 one-handed,
   * undefined Auto (the item's own slots say: a TwoHanded slot is two-handed).
   */
  hands?: (item: PlanItem) => 1 | 2 | undefined;
  /** The era's spell table rows, for the spells items carry (caster, proc and grenade debuffs). */
  spellInfo?: (id: number) => DebuffSpellInfo | undefined;
  /** The Consumables tab (names): grenades are thrown from it. */
  consumableNames?: string[];
  /** Your health now and at most (Drain Auto's plan). */
  vitals?: { health: number; maxHealth: number };
  /** The era's drains and martyrs (tools/build-drain-tables.ts); absent: Drain Auto casts the best drain. */
  drainTable?: DrainRow[];
  /**
   * The era's special ammunition by name: its UseSpecialAmmo mask (1 Raider, 2 SCurrency; tools/build-ammo-tables.ts),
   * 0 for ordinary ammo. Special ammo is shot only when UseSpecialAmmo allows its kind.
   */
  specialAmmo?: (name: string) => number;
}

export type CombatAction =
  /** `projectile`: a bolt, arc, streak or Tusker Fists (UseBreakableTurnTo turns to face the monster first). */
  | { kind: 'cast'; spell: PlanSpell; target: number; why: string; projectile?: boolean }
  /**
   * `element`: what the row's Dmg resolved to, for the swing's power bar (attackPower.ts). `debuff`: the swing
   * or throw is for a weapon's or a grenade's debuff, logged when the server says it went on.
   */
  | { kind: 'attack'; target: number; why: string; element?: CombatElement | null; debuff?: { spell: PlanSpell; item: PlanItem } }
  /** A caster's own debuff, used on the monster. */
  | { kind: 'use-item'; item: PlanItem; target: number; spell: PlanSpell; why: string }
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
  /**
   * Each member's mean damage, from its own description in this era's spell table ("The bolt does 68-136 points of fire
   * damage to the first thing it hits": 102), where it says. The macro weighs a weak bolt of the most damaging element
   * against a strong bolt of another by it (pickElement).
   */
  damage?: Map<number, number>;
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

/**
 * A war spell's mean damage from its description: "does 16-31 points of acid damage" → 23.5 (end of retail; Dark
 * Majesty's Acid Stream I says 10-20). Null when the text names no damage range.
 */
export function spellDamage(desc: string | undefined): number | null {
  const m = desc ? /\bdoes (\d+)\s*-\s*(\d+) points\b/i.exec(desc) : null;
  return m ? (Number(m[1]) + Number(m[2])) / 2 : null;
}

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
    const damage = new Map<number, number>();
    const members: Array<[number, CombatSpellTableEntry]> = opts.only ? [[anchor, a]] : byCategory.get(a.category) ?? [];
    for (const [id, s] of members) {
      if (s.school !== a.school) continue;
      if (opts.sameFlags && (s.bitfield & opts.sameFlags) !== (a.bitfield & opts.sameFlags)) continue;
      if (s.bitfield & (SF_SELF_TARGETED | SF_BENEFICIAL | SF_FELLOWSHIP)) continue;
      if (((s.bitfield & SF_NON_TRACKING_PROJECTILE) !== 0) !== arc) continue;
      ids.add(id);
      const dmg = spellDamage(s.desc);
      if (dmg !== null) damage.set(id, dmg);
    }
    return { anchor, category: a.category, school: a.school, dot: (a.bitfield & SF_DAMAGE_OVER_TIME) !== 0, ids, ...(damage.size ? { damage } : {}) };
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

interface Candidate {
  m: CombatMonster; row: VtMonsterRow;
  /** A debuff of its row is due on it (nextDebuff). */
  needsDebuff: boolean;
  /** VTank's urgency: +1 with the attack element's vuln on it, +2 with Imperil (a weapon) or Magic Yield (magic) on it. */
  urgency: number;
  /** TargetLock is on and it is the selected monster. */
  locked: boolean;
  /** The macro's last combat action went to it. */
  last: boolean;
  /** TargetLock is on and it is selected because the player picked it by hand (not the client's Auto Target). */
  handLocked: boolean;
  /** The weapon and offhand swaps fighting it needs (its row's weapon / offhand not in hand). */
  swaps: number;
}

/**
 * Monsters within AttackDistance (or `maxRange`; and beyond AttackMinimumDistance) whose row is not
 * priority -1, best first, by VirindiTank's target choice (facts from MOSS CombatTargetSelection):
 * 1. With DebuffEachFirst All, a monster that needs a debuff first, whatever its priority.
 * 2. Higher priority.
 * 3. With DebuffEachFirst Priority or All, one that needs a debuff.
 * 4. Higher urgency (already vulned to the attack element +1; already Imperiled, or Yielded when
 *    fighting with magic, +2): finish what's been started.
 * 5. With TargetLock, the selected monster the player picked by hand. Then, beyond VTank, when the last target is
 *    gone (the next pick after a kill): one on a fellow (ProtectFellows), then one hitting you (hittingYou), before any
 *    other selection (the client's Auto Target makes one after a kill). Mid-fight: the selection, then one on a fellow.
 * 6. With TargetSelectMethod Both and both within TargetSelectAngleRange: fewer weapon swaps.
 * 7. The monster the last combat action went to (sticky).
 * 8. TargetSelectMethod: 1 By Range (nearer, then smaller turn); 2 By Angle (smaller turn, then
 *    nearer); 3 Both (within TargetSelectAngleRange beats beyond it; within by turn then distance,
 *    beyond by distance then turn).
 * Before 2026-10-11 only priority, TargetLock and the method decided.
 */
function candidates(input: CombatInput, maxRange?: number): Candidate[] {
  const max = maxRange ?? numSetting(input.settings, 'AttackDistance');
  const min = numSetting(input.settings, 'AttackMinimumDistance');
  const method = numSetting(input.settings, 'TargetSelectMethod');
  const each = numSetting(input.settings, 'DebuffEachFirst');
  const angleRange = method === 3 ? numSetting(input.settings, 'TargetSelectAngleRange') : 0;
  const lock = boolSetting(input.settings, 'TargetLock') && input.selectedGuid !== null;
  const ctx: MatchContext = { settings: input.settings };
  const list: Candidate[] = [];
  for (const m of input.monsters) {
    if ((m.dist > max && !m.onFellow) || m.dist < min) continue;
    const row = matchMonsterRow(input.rows, m, ctx);
    if (row.priority < 0) continue;
    const weapon = rowWeapon(input, row, m);
    const locked = lock && m.guid === input.selectedGuid;
    const c: Candidate = { m, row, needsDebuff: false, urgency: 0, locked, handLocked: locked && input.pickedByHand === m.guid, last: input.lastTarget === m.guid, swaps: 0 };
    c.needsDebuff = nextDebuff(input, c, weapon) !== null;
    c.urgency = urgency(input, c, weapon);
    if (weapon && !isWielded(input, weapon, 'weapon')) c.swaps++;
    const off = rowOffhand(input, row, weapon);
    if (off && !isWielded(input, off, 'offhand')) c.swaps++;
    list.push(c);
  }
  const turn = (c: Candidate) => Math.abs(c.m.relBearing);
  const first = (a: boolean, b: boolean): number => (a === b ? 0 : a ? -1 : 1);
  // The last target gone (killed, or out of reach): what is hitting you is the next one (beyond VTank, hittingYou).
  const nextPick = input.lastTarget == null || !input.monsters.some((m) => m.guid === input.lastTarget);
  list.sort((a, b) => {
    if (each === 3 && a.needsDebuff !== b.needsDebuff) return first(a.needsDebuff, b.needsDebuff);
    if (a.row.priority !== b.row.priority) return b.row.priority - a.row.priority;
    if ((each === 2 || each === 3) && a.needsDebuff !== b.needsDebuff) return first(a.needsDebuff, b.needsDebuff);
    if (a.urgency !== b.urgency) return b.urgency - a.urgency;
    if (a.handLocked !== b.handLocked) return first(a.handLocked, b.handLocked);
    if (nextPick) {
      // The next target after a kill: a fellow's attacker (ProtectFellows), then one hitting you, then the selection
      // the client's Auto Target made (it is no pick of the player's).
      if (!!a.m.onFellow !== !!b.m.onFellow) return first(!!a.m.onFellow, !!b.m.onFellow);
      if (!!a.m.hittingYou !== !!b.m.hittingYou) return first(!!a.m.hittingYou, !!b.m.hittingYou);
    }
    if (a.locked !== b.locked) return first(a.locked, b.locked);
    if (!!a.m.onFellow !== !!b.m.onFellow) return first(!!a.m.onFellow, !!b.m.onFellow);
    if (a.m.dist < angleRange && b.m.dist < angleRange && a.swaps !== b.swaps) return a.swaps - b.swaps;
    if (a.last !== b.last) return first(a.last, b.last);
    if (method === 1) return a.m.dist - b.m.dist || turn(a) - turn(b);
    if (method === 2) return turn(a) - turn(b) || a.m.dist - b.m.dist;
    const an = a.m.dist < angleRange, bn = b.m.dist < angleRange;
    if (an !== bn) return an ? -1 : 1;
    return an ? turn(a) - turn(b) || a.m.dist - b.m.dist : a.m.dist - b.m.dist || turn(a) - turn(b);
  });
  return list;
}

/** VTank's urgency for a monster (MOSS DebuffUrgency): +1 with the attack element's vuln on it, +2 with Imperil (weapon) or Magic Yield (magic) on it. */
function urgency(input: CombatInput, c: Candidate, weapon: PlanItem | undefined): number {
  let score = 0;
  const element = resolveElement(input, c.row.damage, weapon, c.m);
  const vuln = element ? input.families.vuln[element] : undefined;
  if (vuln && timeLeft(input, c.m.guid, vuln.category) > 0) score += 1;
  const physical = !!weapon && ((weapon.itemType ?? 0) & (IT_MELEE | IT_MISSILE)) !== 0;
  const second = input.families.debuff[physical ? 'I' : 'Y'];
  if (second && timeLeft(input, c.m.guid, second.category) > 0) score += 2;
  return score;
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
 * fighting monsters with high magic defense"). With `dist` (debuffs), only
 * levels that reach that far (inSpellRange).
 */
function bestSpell(input: CombatInput, fam: CombatFamily | undefined, debuff = false, dist?: number): PlanSpell | null {
  if (!fam) return null;
  const threshold = debuff && numSetting(input.settings, 'DebuffSelectionMethod') === 1 ? -Infinity : numSetting(input.settings, 'SpellDiffExcessThreshold-Hunt');
  const fudge = numSetting(input.settings, 'SpellRangeFudge');
  let best: PlanSpell | null = null;
  for (const s of input.spells) {
    if (!fam.ids.has(s.id) || s.self || s.buff) continue;
    const skill = schoolSkill(input, s.school);
    if (!skill || skill.training === 'untrained' || s.power + threshold > skill.buffed) continue;
    if (dist !== undefined && !inSpellRange(s, dist, fudge)) continue;
    if (!best || s.power > best.power) best = s;
  }
  return best;
}

/**
 * Whether a debuff reaches a monster `dist` metres away: its range for you
 * (the spell examine's Range: base + per-rank × your school ranks, at most
 * 75 m) less SpellRangeFudge, at most 75 m, is at least the distance. VTank
 * asks this of debuffs only (MOSS CombatItemDebuffPlanner: "the ONE place
 * the reference macro asks a spell how far it goes"); a spell whose range
 * isn't known is not held back.
 */
export function inSpellRange(s: PlanSpell, dist: number, fudge: number): boolean {
  if (s.range === undefined) return true;
  return Math.min(75, Math.max(0, s.range - fudge)) >= dist;
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

/**
 * A carried item by name, or (an Items-tab entry added from the pack) by its object id: two weapons of one
 * name are two items, and the id picks the one the row means. An id you no longer carry falls back to the name.
 */
const findItem = (input: CombatInput, name: string | undefined, id?: number): PlanItem | undefined =>
  (id !== undefined ? input.items.find((i) => (i.guid >>> 0) === (id >>> 0)) : undefined)
  ?? (name ? input.items.find((i) => i.name.toLowerCase() === name.toLowerCase()) : undefined);
/** In hand: equipped, or named as wielded, unless its same-named twin is the one equipped. */
const isWielded = (input: CombatInput, item: PlanItem, slot: 'weapon' | 'offhand'): boolean =>
  item.equipped === true || (input.wielded[slot]?.toLowerCase() === item.name.toLowerCase()
    && !input.items.some((o) => o !== item && o.equipped === true && o.name.toLowerCase() === item.name.toLowerCase()));
/** Two-handed: the Hands column says so, or (Auto) the item's slots include TwoHanded. Nothing goes in the offhand with it. */
export function isTwoHanded(input: Pick<CombatInput, 'hands'>, item: PlanItem | undefined): boolean {
  if (!item) return false;
  const h = input.hands?.(item);
  if (h !== undefined) return h === 2;
  return /(^|\+)TwoHanded(\+|$)/.test(item.fits ?? item.slot ?? '');
}
/** The row's offhand, unless its weapon takes both hands. */
const rowOffhand = (input: CombatInput, row: VtMonsterRow, weapon: PlanItem | undefined): PlanItem | undefined =>
  (isTwoHanded(input, weapon) ? undefined : findItem(input, row.offhand ?? undefined, row.offhandId));

/**
 * The weapon a row fights with. A named Weapon you carry is used; "Any Wand"
 * is a carried caster (the wielded one first). <AUTO> takes VTank's weapon
 * ladder over the Items tab for this monster (weaponLadder.ts: a slayer, then
 * the element it is already vulned to, an imbue or cleave, the best rated…).
 * With no weapon on the Items tab (or a named weapon you no longer carry) it
 * keeps what you wield; with nothing wielded, the first weapon / caster on
 * the Items tab that you carry.
 */
function rowWeapon(input: CombatInput, row: VtMonsterRow, m?: CombatMonster): PlanItem | undefined {
  if (row.weapon && row.weapon.toLowerCase() === 'any wand') {
    const casters = input.items.filter((i) => weaponKind(i) === 'caster');
    const w = casters.find((i) => isWielded(input, i, 'weapon')) ?? casters[0];
    if (w) return w;
  } else if (row.weapon) {
    const named = findItem(input, row.weapon, row.weaponId);
    if (named) return named;
  } else if (m) {
    const auto = ladderWeapon(input, row, m);
    if (auto) return auto;
  }
  const wieldedName = input.wielded.weapon?.toLowerCase();
  const current = input.items.find((i) => i.equipped && i.name.toLowerCase() === wieldedName) ?? findItem(input, input.wielded.weapon) ?? input.items.find((i) => i.equipped && isWeapon(i));
  if (current) return current;
  for (const n of input.itemNames) { const it = findItem(input, n); if (it && isWeapon(it)) return it; }
  return undefined;
}

/** VTank's weapon ladder for an <AUTO> row (weaponLadder.ts), over the Items-tab weapons you carry. */
function ladderWeapon(input: CombatInput, row: VtMonsterRow, m: CombatMonster): PlanItem | undefined {
  const listed: PlanItem[] = [];
  for (const n of input.itemNames) for (const it of input.items) if (it.name.toLowerCase() === n.toLowerCase() && !listed.includes(it)) listed.push(it);
  if (!listed.some(isWeapon)) return undefined;
  const fixed = VT_TO_ELEMENT[row.damage];
  const facts = input.monsterFacts?.(m.name);
  const wanted: CombatElement[] = fixed ? [fixed] : row.damage === VT_DAMAGE.Auto || row.damage === VT_DAMAGE.Prismatic ? (facts?.weak.length ? facts.weak : UNLISTED_ORDER) : [];
  const off = findItem(input, row.offhand ?? undefined);
  return pickLadderWeapon({
    items: listed, wanted, ...(facts?.species ? { species: facts.species } : {}),
    // Only a launcher can fail to deliver an element: for want of ammunition of it (MOSS CanDeliverElement).
    canDeliver: (item, el) => weaponKind(item) !== 'missile' || ammoOf(input, item, el as CombatElement, 'any') !== null,
    vulnerable: (el) => { const f = input.families.vuln[el as CombatElement]; return !!f && timeLeft(input, m.guid, f.category) > 0; },
    warTrained: trainedIn(input, 'War Magic'), voidTrained: trainedIn(input, 'Void Magic'),
    ...(off ? { exclude: off.guid } : {}),
  });
}

const ALL_ELEMENTS: CombatElement[] = ['pierce', 'bludgeon', 'slash', 'acid', 'lightning', 'cold', 'fire', 'nether'];
/** One Random pick per decision, so the V column's vuln and the attack agree. */
const randomPick = new WeakMap<CombatInput, CombatElement | null>();

/** VTank's element order for a monster its database doesn't list (MOSS VtankDamageDatabase.UnlistedElementOrder). */
const UNLISTED_ORDER: CombatElement[] = ['pierce', 'bludgeon', 'slash', 'acid', 'lightning', 'cold', 'fire'];
const TABLE_LETTER: Record<string, CombatElement> = { p: 'pierce', b: 'bludgeon', s: 'slash', a: 'acid', l: 'lightning', c: 'cold', f: 'fire' };

/**
 * One monster table row: [name, weak letters, max health, species (CreatureType), immunity letters, the weak letters'
 * Resist* multipliers comma-separated] (tools/build-monster-tables.ts).
 */
export type MonsterTableRow = [string, string, number, number?, string?, string?];

/** The era's monster table rows as a by-name lookup. */
export function indexMonsterTable(rows: MonsterTableRow[]): (name: string) => MonsterFacts | undefined {
  const map = new Map<string, MonsterFacts>();
  for (const [name, weak, maxHealth, species, immune, mults] of rows) {
    const els = [...weak].flatMap((c) => (TABLE_LETTER[c] ? [TABLE_LETTER[c]] : []));
    const ms = mults ? mults.split(',').map(Number) : [];
    const resist: Partial<Record<CombatElement, number>> = {};
    if (ms.length === els.length) els.forEach((el, i) => { if (Number.isFinite(ms[i])) resist[el] = ms[i]; });
    map.set(name.trim().toLowerCase(), {
      weak: els, maxHealth, ...(Object.keys(resist).length ? { resist } : {}),
      ...(species ? { species } : {}), ...(immune?.includes('m') ? { magicImmune: true } : {}), ...(immune?.includes('d') ? { drainImmune: true } : {}),
    });
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
  // The weapon's own element: a rend imbue, the resistance it cleaves, then its DamageType (MOSS VtankWeaponElement).
  const own = weapon ? weaponElement(weapon) : null;
  if (own) return own;
  const trained = (school: string) => { const s = schoolSkill(input, school); return !!s && s.training !== 'untrained'; };
  if (trained('Void Magic') && !trained('War Magic') && bestSpell(input, input.families.attack.nether?.bolt)) return 'nether';
  const facts = m ? input.monsterFacts?.(m.name) : undefined;
  const weak = facts?.weak ?? [];
  // Beyond VTank (WeighBoltsByDamage, on by default): a caster weighs each element by the bolt it can cast of it.
  if ((weaponKind(weapon) === 'caster' || !weapon) && weighBolts(input.settings)) {
    const best = strongestBolt(input, facts);
    if (best) return best;
  }
  for (const el of weak) if (canDeliver(input, el, weapon)) return el;
  for (const el of UNLISTED_ORDER) if (bestSpell(input, input.families.attack[el]?.bolt)) return el;
  return null;
}

/**
 * Beyond VTank (2026-10-18), the macro's WeighBoltsByDamage setting (on unless a profile sets it false): VTank's Auto
 * takes the first element of the monster's damage list a caster can bolt, whatever level that bolt is. A Dread Mu-miyah
 * takes fire and acid alike (×1; acid first in the unlisted order), so "Arcanist fights" cast Acid Stream I (16-31) at
 * them while she knew Flame Bolt V (68-136): about a quarter of the damage per cast, for an hour (Mountain Keep,
 * 2026-10-17 23:40Z–00:34Z). With it on, a caster takes the element whose best castable bolt does the most against
 * this monster: the bolt's mean damage (its description in this era's spell table) times the monster's multiplier for
 * the element (its Resist*: the era's monster table, 1 for an element it doesn't resist or a monster the table doesn't
 * list); ties go to the damage list's order (then VTank's unlisted order). When a bolt's damage isn't known (a table
 * without the descriptions), by the multiplier and then the bolt's level.
 */
function weighBolts(settings: CombatInput['settings']): boolean {
  for (const [k, v] of Object.entries(settings)) if (k.toLowerCase() === 'weighboltsbydamage') return !(v === false || v === 0 || (typeof v === 'string' && /^(false|0|no|off)$/i.test(v)));
  return true;
}

function strongestBolt(input: CombatInput, facts: MonsterFacts | undefined): CombatElement | null {
  // A damage list without its multipliers (an older table) can't be weighed: VTank's order decides.
  if (facts?.weak.length && !facts.resist) return null;
  const order = [...(facts?.weak ?? []), ...UNLISTED_ORDER.filter((el) => !facts?.weak.includes(el))];
  // A monster listed with nothing to prefer (weak '') or not listed takes every element alike.
  const mult = (el: CombatElement): number => facts?.resist?.[el] ?? 1;
  const options = order.flatMap((el) => {
    const fam = input.families.attack[el]?.bolt;
    const s = bestSpell(input, fam);
    return s ? [{ el, s, mult: mult(el), dmg: fam?.damage?.get(s.id) }] : [];
  });
  if (!options.length) return null;
  const known = options.every((o) => o.dmg !== undefined);
  let best = options[0];
  for (const o of options.slice(1)) {
    const better = known ? o.mult * o.dmg! > best.mult * best.dmg! : o.mult > best.mult || (o.mult === best.mult && o.s.power > best.s.power);
    if (better) best = o;
  }
  return best.el;
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
  const allowed = Math.trunc(Number(input.settings.UseSpecialAmmo) || 0);
  for (const a of input.items) {
    if (!isAmmo(a) || ammoTypeOf(a) !== type || (a.stack ?? 1) < 1 || !canWield(input, a)) continue;
    const special = input.specialAmmo?.(a.name) ?? 0;
    if (special && (special & allowed) === 0) continue; // VTank UseSpecialAmmo: None 0, Raider 1, SCurrency 2, Both 3
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

/**
 * The next debuff this monster needs, if any: a family member it lacks (or will lose within
 * DebuffPrecastSeconds; DoTs only when gone), from the best source (itemDebuffs.ts: your spell, an
 * Items-tab caster or cast-on-strike weapon, a Consumables-tab grenade). A monster immune to spells
 * that aren't projectiles (the era's monster table, or the server's "You fail to affect" at it) gets
 * none: before 2026-10-11 the macro recast at it for ever and never attacked. UseProjectileAwareness:
 * a source that flies (a grenade, a launcher's spell) is no good while the monster's line of fire is
 * blocked; with AllowDebuffFallback the next source is used, else that column waits (MOSS
 * CombatController: the winner stands and its column goes off for the pass).
 */
function nextDebuff(input: CombatInput, c: Candidate, weapon: PlanItem | undefined): { spell: PlanSpell; why: string; source: DebuffSource } | null {
  if (c.m.magicImmune || input.monsterFacts?.(c.m.name)?.magicImmune) return null;
  const precast = numSetting(input.settings, 'DebuffPrecastSeconds');
  const aware = boolSetting(input.settings, 'UseProjectileAwareness') && c.m.blocked === true;
  const fallback = boolSetting(input.settings, 'AllowDebuffFallback');
  const method = numSetting(input.settings, 'DebuffSelectionMethod');
  const consumables = input.consumableNames?.length ? input.items.filter((i) => input.consumableNames!.some((n) => n.toLowerCase() === i.name.toLowerCase())) : [];
  const listed = input.items.filter((i) => input.itemNames.some((n) => n.toLowerCase() === i.name.toLowerCase()));
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
    const left = timeLeft(input, c.m.guid, fam.category);
    if (fam.dot ? left > 0 : left > precast) continue;
    // Your own spell: only a level that reaches the monster (its range less SpellRangeFudge).
    const learned = bestSpell(input, fam, true, c.m.dist);
    const sources = !input.spellInfo && !consumables.length ? (learned ? [{ kind: 'spell' as const, spell: learned, skill: 0, flies: false }] : []) : debuffSources({
      ids: fam.ids, learned, learnedSkill: learned ? schoolSkill(input, learned.school)?.buffed ?? 0 : 0,
      items: listed, consumables, skills: input.skills, spellInfo: input.spellInfo ?? (() => undefined),
      canWield: (i) => canWield(input, i), method,
    });
    let source: DebuffSource | undefined;
    for (const src of sources) {
      if (src.flies && aware) { if (fallback) continue; break; }
      source = src;
      break;
    }
    if (!source) continue; // the era lacks it, nothing you have casts it, it doesn't reach, or its flight is blocked
    const label = col === 'X' ? 'Ex. Vuln' : col;
    const from = source.item ? ` from ${source.item.name}` : '';
    return { spell: source.spell, source, why: `${label} on ${c.m.name}${from}${left > 0 ? ` (${Math.round(left)} s left)` : ''}` };
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
  const off = rowOffhand(input, row, weapon);
  if (off && !isWielded(input, off, 'offhand')) return { kind: 'equip', item: off, why: `${row.name} offhand ${off.name}` };
  return null;
}

function cast(input: CombatInput, spell: PlanSpell, target: number, why: string, projectile = false): CombatAction {
  return needStance(input, 'magic', `to cast ${spell.name}`) ?? { kind: 'cast', spell, target, why, ...(projectile ? { projectile } : {}) };
}

/**
 * A debuff from an item (itemDebuffs.ts): a caster is wielded and used on the monster; a cast-on-strike
 * weapon is wielded and swung (melee) or shot (a launcher); a grenade is wielded and thrown, in missile
 * mode. The swing or throw carries the debuff, logged when the server says it went on.
 */
function itemDebuff(input: CombatInput, src: DebuffSource, target: number, why: string): CombatAction {
  const item = src.item!;
  if (!(item.equipped || isWielded(input, item, 'weapon'))) return { kind: 'equip', item, why: `${why}: wielding ${item.name}` };
  if (src.kind === 'caster') return { kind: 'use-item', item, target, spell: src.spell, why };
  const stance: Stance = src.kind === 'grenade' || weaponKind(item) === 'missile' ? 'missile' : 'melee';
  return needStance(input, stance, `${why}: ${stance} mode`) ?? { kind: 'attack', target, why, debuff: { spell: src.spell, item } };
}

/** UseProjectileAwareness: a bolt, arc, streak or arrow at this monster would hit something first. */
const flightBlocked = (input: CombatInput, m: CombatMonster): boolean => m.blocked === true && boolSetting(input.settings, 'UseProjectileAwareness');

const trainedIn = (input: CombatInput, school: string): boolean => { const s = schoolSkill(input, school); return !!s && s.training !== 'untrained'; };

/**
 * Harm: the best Harm Other you can cast. Fists: Tusker Fists (VTank leaves
 * the positioning to you and aims from .116, as our cast at the target does).
 * Drain Auto (also Auto with neither War nor Void Magic trained, FAQ .112):
 * the first step of the cheapest drain / martyr plan that finishes the monster
 * without your health dropping below the Vitals tab's Heal at (drainPlan.ts;
 * MOSS PlanDrain); `ring` (the R column's ring conditions) allows only ring
 * martyrs. A plan that starts with a heal casts nothing (the recharge rules
 * heal). Without the era's drain table (not loaded yet), the best Drain Health
 * Other. Before 2026-10-11 ours drained above half health and cast Harm Other
 * below it (our guess); VTank's Drain Auto never casts Harm.
 */
function magicModeAttack(input: CombatInput, top: Candidate, ring = false): { spell: PlanSpell; why: string; flies: boolean } | null {
  const d = top.row.damage;
  const name = top.m.name;
  if (d === VT_DAMAGE.Harm) { const s = bestSpell(input, input.families.harm); return s ? { spell: s, why: `harm at ${name}`, flies: false } : null; }
  if (d === VT_DAMAGE.Fists) { const s = bestSpell(input, input.families.fists); return s ? { spell: s, why: `fists at ${name}`, flies: true } : null; }
  const drainMode = d === VT_DAMAGE.DrainAuto || (d === VT_DAMAGE.Auto && !trainedIn(input, 'War Magic') && !trainedIn(input, 'Void Magic'));
  if (!drainMode) return null;
  const facts = input.monsterFacts?.(name);
  if (!input.drainTable || !input.vitals) {
    if (ring || facts?.magicImmune || facts?.drainImmune) return null;
    const drain = bestSpell(input, input.families.drain);
    return drain ? { spell: drain, why: `drain at ${name}`, flies: false } : null;
  }
  const { health, maxHealth } = input.vitals;
  if (!health || !maxHealth) return null;
  // One point below the health the recharge rule calls normal, so a plan landing on it still counts as safe.
  const floor = Math.ceil(maxHealth * Math.min(1, Math.max(0, numSetting(input.settings, 'Recharge-Norm-HitP') / 100))) - 1;
  const max = facts?.maxHealth ?? 0;
  const left = max > 0 ? Math.round((top.m.health ?? 1) * max) : Infinity;
  if (left === 0) return null;
  const threshold = numSetting(input.settings, 'SpellDiffExcessThreshold-Hunt');
  const known = (id: number): PlanSpell | undefined => input.spells.find((s) => s.id === id);
  const castable = (id: number): boolean => {
    const s = known(id);
    const sk = s ? schoolSkill(input, s.school) : undefined;
    return !!s && !!sk && sk.training !== 'untrained' && s.power + threshold <= sk.buffed;
  };
  const id = planDrain({
    health, maxHealth, floor, target: left, ring, rows: input.drainTable, castable,
    canDrain: !facts?.magicImmune && !facts?.drainImmune && !top.m.magicImmune && Number.isFinite(left),
  });
  const spell = id === null ? undefined : known(id);
  // A martyr is a Life projectile; a drain is not.
  const flies = input.drainTable.some((r) => r[0] === id && r[1] !== 'd');
  return spell ? { spell, flies, why: `drain plan at ${name}: ${spell.name} (${Number.isFinite(left) ? `${left} left` : 'health unknown'}, floor ${floor})` } : null;
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

export interface PetOptions {
  /** Pet range (metres): Monster Range, or Custom Pet Range. */
  range: number;
  /** Pet Min. Monsters. */
  minMonsters: number;
  /** The summoning essences on the Items tab you carry (examined), in the tab's order. */
  devices: PlanItem[];
  /** Your level and Summoning Mastery (PropertyInt 362), for the usable-essence check. */
  level?: number;
  mastery?: number;
}

/**
 * Whether an essence can be used now (MOSS PetAutomation.IsUsable): its level and Summoning skill
 * requirements met (itemUse.ts, the server's own check), charges left (Structure, PropertyInt 92; unknown
 * counts as some), and no other Summoning Mastery's (PropertyInt 362 against yours). Null when usable.
 */
export function petUnusable(device: PlanItem, skills: PlanSkill[], level?: number, mastery?: number): string | null {
  const req = useRequirementProblem(device, skills, level);
  if (req) return req;
  if (device.ints?.[PropertyInt.Structure] === 0) return `${device.name} has no charges left`;
  const needs = device.ints?.[PropertyInt.SummoningMastery];
  if (needs && mastery !== undefined && needs !== mastery) return `ignoring pet ${device.name}: you have the wrong summoning mastery`;
  return null;
}

/**
 * VirindiTank's Summon Pets choice (CHG .156/.157; facts from MOSS PetAutomation.SelectPet). Monsters
 * within pet range whose row is not priority -1 and whose PetDmg is not None want a pet; there must be
 * at least Pet Min. Monsters of them. The pet is for the nearest one that also outranks every nearer one.
 * Every usable essence is ranked for it, best first: with an element PetDmg, that element, then the
 * element your attack resolves to, then the monster's weak elements in order; PAuto: your attack's
 * element, then its weak elements; Auto: its weak elements; anything else ranks last but still counts.
 * A tie goes to the essence with the higher level requirement (UseRequiresLevel, PropertyInt 369). An
 * essence's element is its UiEffects glow; one without (the golems) strikes as a bludgeon. Before
 * 2026-10-11 an essence was picked by element alone, first of the tab, unusable ones included.
 */
export function planPet(input: CombatInput, opts: PetOptions): PetPlan | null {
  if (!opts.devices.length) return null;
  const ctx: MatchContext = { settings: input.settings };
  let chosen: { m: CombatMonster; row: VtMonsterRow } | null = null;
  let wanting = 0;
  for (const m of input.monsters) {
    if (m.dist > opts.range) continue;
    const row = matchMonsterRow(input.rows, m, ctx);
    if (row.priority < 0 || row.petDamage === VT_DAMAGE.None) continue;
    wanting++;
    // Both at once: a monster takes the pick only by being nearer AND ranked higher than the one holding it.
    if (!chosen || (m.dist < chosen.m.dist && row.priority > chosen.row.priority)) chosen = { m, row };
  }
  if (!chosen || wanting < Math.max(1, opts.minMonsters)) return null;
  const { m, row } = chosen;
  const attack = resolveElement(input, row.damage, rowWeapon(input, row, m), m);
  const prefs = input.monsterFacts?.(m.name)?.weak ?? [];
  const pref = (el: CombatElement): number => { const i = prefs.indexOf(el); return i < 0 ? Infinity : i + 10; };
  const pd = row.petDamage;
  const wanted = VT_TO_ELEMENT[pd];
  const rank = (el: CombatElement): number => {
    if (wanted && wanted !== 'nether') return el === wanted ? 0 : el === attack ? 1 : pref(el);
    if (pd === VT_PET_AUTO) return el === attack ? 0 : pref(el);
    if (pd === VT_DAMAGE.Auto) return pref(el);
    return Infinity;
  };
  let best: { d: PlanItem; rank: number; level: number } | null = null;
  for (const d of opts.devices) {
    if (petUnusable(d, input.skills, opts.level, opts.mastery)) continue;
    const r = rank(petDeviceElement(d) ?? 'bludgeon');
    const level = d.ints?.[PropertyInt.UseRequiresLevel] ?? 0;
    if (!best || r < best.rank || (r === best.rank && level > best.level)) best = { d, rank: r, level };
  }
  if (!best) return null;
  return { device: best.d, element: petDeviceElement(best.d), count: wanting, why: `${wanting} within ${Math.round(opts.range)} m, ${m.name} first: ${best.d.name}` };
}

/** planTarget's answer when the planned attack's flight is blocked: choose again from the next monster. */
const BLOCKED = Symbol('blocked');

/**
 * The plan: debuffs, then the attack, for the best target. UseProjectileAwareness (on by default; MOSS
 * CombatController): when the top monster's bolt, arc, streak, Tusker Fists, martyr or arrow would hit a
 * wall, the ground or an object first (the client's line-of-fire test, `blocked`), that monster's attack is
 * off for this pass and the next monster is planned for instead. Rings and melee have no flight to test;
 * blocked debuff sources are nextDebuff's. Off, nothing is tested here (the cast itself still refuses a
 * blocked bolt: AgentApi.cast).
 */
export function planCombat(input: CombatInput): CombatAction | null {
  // A monster with no debuff due and no attack column (A, R or S) is nothing to do: not a target, so
  // another monster's debuffs go out (VTank leaves it out; before 2026-10-11 a fully debuffed
  // debuff-only monster at the top stopped the fight).
  const list = candidates(input).filter((c) => c.needsDebuff || c.row.on.some((col) => col === 'A' || col === 'R' || col === 'S'));
  const top = list[0];
  if (!top) return null;
  const each = numSetting(input.settings, 'DebuffEachFirst');
  for (const c of list) {
    const a = planTarget(input, list, c, c === top ? each : 1);
    if (a !== BLOCKED) return a;
  }
  return null;
}

function planTarget(input: CombatInput, list: Candidate[], top: Candidate, each: number): CombatAction | null | typeof BLOCKED {
  const weapon = rowWeapon(input, top.row, top.m);
  const kind = weaponKind(weapon);

  // SwitchWandsToDebuff: a caster row weapon is wielded before debuffing too (ADV); otherwise weapons switch for the attack only.
  if (kind === 'caster' && boolSetting(input.settings, 'SwitchWandsToDebuff')) {
    const eq = equipFor(input, top.row, weapon);
    if (eq) return eq;
  }

  // Debuffs first, per DebuffEachFirst: 1 One (the target), 2 Priority (every monster of its priority), 3 All (CHG 0.3.0.19).
  const toDebuff = each === 3 ? list : each === 2 ? list.filter((c) => c.row.priority === top.row.priority) : [top];
  for (const c of toDebuff) {
    const d = nextDebuff(input, c, rowWeapon(input, c.row, c.m));
    if (d) return d.source.kind === 'spell' ? cast(input, d.spell, c.m.guid, d.why) : itemDebuff(input, d.source, c.m.guid, d.why);
  }

  const on = (col: VtMonsterColumn) => top.row.on.includes(col);
  if (!on('A') && !on('R') && !on('S')) return null; // debuff only (STD)

  const eq = equipFor(input, top.row, weapon);
  if (eq) return eq;

  const element = resolveElement(input, top.row.damage, weapon, top.m);
  const fams = element ? input.families.attack[element] : undefined;
  const blocked = flightBlocked(input, top.m);

  // Ring (STD): with A+R when ≥ MinimumRingTargets monsters are within RingDistance; with R only when any R monster is.
  const ringDist = numSetting(input.settings, 'RingDistance');
  const inRing = list.filter((c) => c.m.dist <= ringDist);
  const ringNow = on('R') && (on('A') ? inRing.length >= numSetting(input.settings, 'MinimumRingTargets') : inRing.some((c) => c.row.on.includes('R')));
  if (ringNow && fams?.ring) {
    const ring = bestSpell(input, fams.ring);
    if (ring) return cast(input, ring, top.m.guid, `ring: ${inRing.length} within ${ringDist} m`);
  }
  // R only: war on targets outside ring range; inside it, nothing more (STD).
  if (!on('A') && !on('S') && top.m.dist <= ringDist) {
    // Drain Auto's ring plan (ring martyrs only).
    const m = ringNow && (kind === 'caster' || !weapon) ? magicModeAttack(input, top, true) : null;
    if (m) return blocked && m.flies ? BLOCKED : cast(input, m.spell, top.m.guid, m.why, m.flies);
    return null;
  }

  if (kind === 'caster' || !weapon) {
    if (fams) {
      // S alone streaks every time; A with S streaks only as the finisher (MOSS CombatController: PlanStreak / IsFinishingBlow).
      const streak = on('S') ? bestSpell(input, fams.streak) : null;
      const useStreak = streak && (!on('A') || isFinishingBlow(input, top.m, streak));
      const bolt = bestSpell(input, fams.bolt);
      const useArcs = numSetting(input.settings, 'UseArcs');
      const arcOk = useArcs === 3 || (useArcs === 2 && top.m.dist >= numSetting(input.settings, 'ArcRange'));
      const arc = arcOk ? bestSpell(input, fams.arc) : null;
      if ((useStreak || arc || bolt) && blocked) return BLOCKED;
      if (useStreak && streak) return cast(input, streak, top.m.guid, on('A') ? `streak to finish ${top.m.name}` : `streak at ${top.m.name}`, true);
      // Arcs replace bolts when known at the best castable level (CHG 0.3.0.17).
      if (arc && (!bolt || arc.power >= bolt.power)) return cast(input, arc, top.m.guid, `arc at ${top.m.name}`, true);
      if (bolt) return cast(input, bolt, top.m.guid, `bolt at ${top.m.name}`, true);
    }
    // The Life Magic / Tusker Fists modes (FAQ: "Void Basic, Drain Auto or Harm"; Auto with neither War nor Void trained is Drain Auto).
    const m = magicModeAttack(input, top, ringNow);
    if (m) return blocked && m.flies ? BLOCKED : cast(input, m.spell, top.m.guid, m.why, m.flies);
    if (kind === 'caster') return null; // a caster with no castable attack: nothing to do
  }
  // A launcher shoots the row's ammunition (VTank swaps arrows per monster).
  if (kind === 'missile') {
    if (blocked) return BLOCKED;
    const ammo = ammoFor(input, top.row, weapon, top.m);
    if (ammo && !(ammo.equipped && /MissileAmmo/.test(ammo.slot ?? 'MissileAmmo'))) return { kind: 'equip', item: ammo, why: `${top.row.name} shoots ${ammo.name}` };
  }
  const stance: Stance = kind === 'missile' ? 'missile' : 'melee';
  return needStance(input, stance, `to attack with ${weapon?.name ?? 'bare hands'}`) ?? { kind: 'attack', target: top.m.guid, why: `${top.row.name === '<DEFAULT>' ? 'default' : top.row.name} p${top.row.priority}`, element };
}

/**
 * The attack spell a caster fights ONE monster with outside the macro (a routine's pull and attack-nearest, ac_attack):
 * the macro's own choice (planCombat) for its <DEFAULT> Monsters row (Auto damage, A and S on), with VTank's default
 * settings, the monster as the only candidate and you already in magic mode. So the element (the era's monster table,
 * else VTank's unlisted order), bolt / arc / streak finisher and the Drain Auto fallback for a mage with neither War
 * nor Void trained are exactly the macro's; the spells, their families and your skills come from the era's tables.
 * Null: nothing you know and can cast attacks it. Before 2026-10-13 a wand wielder's attack only ever asked for magic
 * mode and swung at nothing (Sparring Golem: "no swing or shot landed in 25 s; not pulled").
 */
export function casterAttackSpell(
  input: Omit<CombatInput, 'monsters' | 'rows' | 'stance' | 'castLog' | 'now' | 'selectedGuid'> & { castLog?: CombatInput['castLog']; now?: number },
  m: CombatMonster,
): { spell: PlanSpell; why: string; projectile: boolean } | null {
  const a = planCombat({
    ...input, rows: [VT_DEFAULT_MONSTER], monsters: [m], stance: 'magic', castLog: input.castLog ?? [], now: input.now ?? 0, selectedGuid: m.guid,
    // The one monster asked about is the target, wherever it stands (the macro's AttackDistance is the macro's own reach).
    settings: { ...input.settings, AttackDistance: Number.MAX_SAFE_INTEGER, AttackMinimumDistance: 0 },
  });
  return a?.kind === 'cast' ? { spell: a.spell, why: a.why, projectile: !!a.projectile } : null;
}
