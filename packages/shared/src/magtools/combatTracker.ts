/**
 * Mag-Tools' combat tracker (docs/plugin-specs/magtools.md §5.2): chat lines in, per-opponent and
 * total stats out — the monster list and the detail grid with their percentages, and DPS
 * windows. Clean room from the spec's facts; the list headers and row labels are verbatim.
 *
 * The chat it reads is OUR client's: hit lines from @ac/shared formatAttackerChat /
 * formatDefenderChat (the same in every era: the client formats them), evades from
 * ServerMessageText, and the server's own resist / war-magic / killing-blow lines. The killing
 * blows come from the servers' death-message tables, not Mag-Tools' list (spec §5.2 asks for
 * that): ACE's Strings.cs (end of retail, ClassicACE Dark Majesty worlds) and GDLE's
 * WeenieObject.cpp (GDL-Classic Dark Majesty worlds and the AC1999 server, which share it).
 */
import { mtN, mtRoundTo, mtShortNumber } from './format.js';

export type MtAttackType = 'MeleeMissile' | 'Magic' | 'Unknown';
export type MtElement = 'Typeless' | 'Slash' | 'Pierce' | 'Bludge' | 'Fire' | 'Cold' | 'Acid' | 'Electric' | 'None';

export interface MtAttackEvent {
  kind: 'attack';
  source: string;
  target: string;
  attackType: MtAttackType;
  element: MtElement;
  failed: boolean;
  crit: boolean;
  killingBlow: boolean;
  damage: number;
}
export interface MtSurgeEvent { kind: 'aetheriaSurge' | 'cloakSurge'; source: string; target: string }
export type MtCombatEvent = MtAttackEvent | MtSurgeEvent;

// ─── Killing-blow templates (killer's view; {0} = the victim) ───────────

/** ACE ACE.Server/Entity/Strings.cs death messages, the killer's line ("{0} died!" left out: it names no killer). */
export const MT_KILL_TEMPLATES_ACE: readonly string[] = [
  'You split {0} apart!', 'You cleave {0} in twain!', '{0} is torn to ribbons by your assault!',
  'Your killing blow nearly turns {0} inside-out!', 'You run {0} through!', '{0} is fatally punctured!',
  "{0}'s perforated corpse falls before you!", "{0}'s death is preceded by a sharp, stabbing pain!",
  'You beat {0} to a lifeless pulp!', '{0} is shattered by your assault!', "You flatten {0}'s body with the force of your assault!",
  'The thunder of crushing {0} is followed by the deafening silence of death!', 'You bring {0} to a fiery end!',
  '{0} is reduced to cinders!', '{0} is incinerated by your assault!', "{0}'s seared corpse smolders before you!",
  'Your attack stops {0} cold!', 'Your assault sends {0} to an icy death!', '{0} suffers a frozen fate!',
  '{0} is liquified by your attack!', "{0}'s last strength dissolves before you!", 'You reduce {0} to a sizzling, oozing mass!',
  'Blistered by lightning, {0} falls!', 'Electricity tears {0} apart!', "Your lightning coruscates over {0}'s mortal remains!",
  '{0} is dessicated by your attack!', "{0}'s last strength withers before you!", 'You reduce {0} to a drained, twisted corpse!',
  'You obliterate {0}!', 'You smite {0} mightily!', 'You knock {0} into next Morningthaw!', '{0} is utterly destroyed by your attack!',
  '{0} catches your attack, with dire consequences!', 'You slay {0} viciously enough to impart death several times over!',
  "The deadly force of your attack is so strong that {0}'s ancestors feel it!",
  'You send {0} to death so violently that even the lifestone flinches!', 'You killed {0}!',
];

/**
 * GDLE's killer lines (reference/classic/ClassicDereth and reference/ac1999 WeenieObject.cpp
 * GetDeathMessage; identical in both). Two differ from ACE: "{0}'s body is shattered by your
 * assault!" and "You reduced {0} to cinders!".
 */
export const MT_KILL_TEMPLATES_GDLE: readonly string[] = [
  '{0} is utterly destroyed by your attack!', 'You knock {0} into next Morningthaw!', 'You obliterate {0}!',
  'You slay {0} viciously enough to impart death several times over!', '{0} catches your attack, with dire consequences!',
  'You smite {0} mightily!', 'You send {0} to death so violently that even the lifestone flinches!',
  "The deadly force of your attack is so strong that {0}'s ancestors feel it!", "{0}'s body is shattered by your assault!",
  "You flatten {0}'s body with the force of your assault!", 'You beat {0} to a lifeless pulp!',
  'The thunder of crushing {0} is followed by the deafening silence of death!', "{0}'s seared corpse smolders before you!",
  'You bring {0} to a fiery end!', 'You reduced {0} to cinders!', '{0} is incinerated by your assault!',
  "{0}'s perforated corpse falls before you!", "{0}'s death is preceded by a sharp, stabbing pain!", '{0} is fatally punctured!',
  'You run {0} through!', 'You split {0} apart!', 'You cleave {0} in twain!', '{0} is torn to ribbons by your assault!',
  'Your killing blow nearly turns {0} inside-out!', 'You reduce {0} to a drained, twisted corpse!', '{0} is dessicated by your attack!',
  "{0}'s last strength withers before you!", 'You reduce {0} to a sizzling, oozing mass!', "{0}'s last strength dissolves before you!",
  '{0} is liquified by your attack!', 'Your attack stops {0} cold!', 'Your assault sends {0} to an icy death!',
  '{0} suffers a frozen fate!', "Your lightning coruscates over {0}'s mortal remains!", 'Blistered by lightning, {0} falls!',
  'Electricity tears {0} apart!', 'You killed {0}!',
];

/** Both families: a client can meet either kind of server, so the default parser knows every line. */
export const MT_KILL_TEMPLATES: readonly string[] = [...new Set([...MT_KILL_TEMPLATES_ACE, ...MT_KILL_TEMPLATES_GDLE])];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Longest wording first, so "{0}'s body is shattered …" wins over "{0} is shattered …". */
function compileKills(templates: readonly string[]): RegExp[] {
  return [...templates].sort((a, b) => b.length - a.length).map((t) => new RegExp(`^${t.split('{0}').map(escapeRe).join('(.+)')}$`));
}

// ─── Element keywords (spec §5.2, first match wins) ─────────────────────

const ELEMENT_KEYWORDS: ReadonlyArray<[MtElement, readonly string[]]> = [
  ['Slash', ['slash', ' cut', ' scratch', ' mangle']],
  ['Pierce', ['pierc', ' gore', ' impale', ' nick', ' stab']],
  ['Bludge', ['bludge', ' smash', ' bash', ' graze', ' crush']],
  ['Fire', ['fire', ' burn', ' singe', ' scorch', ' incinerate']],
  ['Cold', ['cold', ' frost', ' chill', ' numb', ' freeze']],
  ['Acid', ['acid', ' blister', ' sear', ' corrode', ' dissolve']],
  ['Electric', ['electric', ' lightning', ' jolt', ' shock', ' spark', ' blast']],
  ['Typeless', [' eradicate', ' wither', ' scar', ' twist']],
  ['Typeless', [' deplete', ' siphon', ' exhaust', ' drain', ' lose ', ' health ']],
];

/** The element a hit's words name (the names in the line are left out, so a "Fire Golem" is not fire damage). */
export function mtElementOf(words: string): MtElement | null {
  const t = words.toLowerCase();
  for (const [el, keys] of ELEMENT_KEYWORDS) if (keys.some((k) => t.includes(k))) return el;
  return null;
}

// ─── The parser ──────────────────────────────────────────────────────────

const FLAG_RE = /^((?:(?:Critical hit|Overpower|Sneak Attack|Recklessness|Reckless)!\s+)*)/;
const BODY_PARTS = '(?:head|chest|abdomen|upper arm|lower arm|hand|upper leg|lower leg|foot)';
const RECEIVED_MELEE = new RegExp(`^(.+) (\\S+) (?:your ${BODY_PARTS}|you) for ([\\d,]+) points? of (.*?)damage!`);
const GIVEN_MELEE = /^You (\S+) (.+?) for ([\d,]+) points? of (.*?)damage!/;
const RECEIVED_MAGIC = /^(.+) (\S+) you for ([\d,]+) points? with (.+?)\.?$/;
const GIVEN_MAGIC = /^You (\S+) (.+?) for ([\d,]+) points? with (.+?)\.?$/;
const LOSE_HEALTH = /^(?:Magical energies|You) lose ([\d,]+) points? of health due to (.+?) casting /;
const CASTS_DRAINS = /^(.+?) casts .+ and drains ([\d,]+) points? /;
const SURGE = /^Aetheria surges on (.+) with the power of (.+)!$/;
const CASTER_SURGES = new Set(['Surge of Destruction', 'Surge of Protection', 'Surge of Regeneration']);

const num = (s: string): number => Number(s.replace(/,/g, ''));

export interface MtCombatParserOptions {
  /** Your character's name. */
  me: () => string;
  /** The killing-blow lines to know (default: every server family's). */
  killTemplates?: readonly string[];
  /**
   * Where "Unable to parse …" diagnostics go. Spec §12 #14 (fixed): upstream prints them in the
   * player's chat; ours go to a debug log only.
   */
  debug?: (message: string) => void;
}

/** Player or NPC speech: never combat. */
function isSpeech(line: string): boolean {
  return line.startsWith('You say, ') || line.includes(' says, "') || line.includes(' tells you, ') || line.startsWith('You tell ');
}

export class MtCombatParser {
  private readonly kills: RegExp[];
  constructor(private readonly opts: MtCombatParserOptions) {
    this.kills = compileKills(opts.killTemplates ?? MT_KILL_TEMPLATES);
  }

  /** The combat event a chat line reports, or null. Only events where you are the source or the target come back. */
  parse(raw: string): MtCombatEvent | null {
    const line = raw.trim();
    if (!line || isSpeech(line)) return null;
    const me = this.opts.me();
    const ev = this.parseLine(line, me);
    if (!ev) return null;
    return ev.source === me || ev.target === me ? ev : null;
  }

  private attack(source: string, target: string, attackType: MtAttackType, element: MtElement, damage: number, flags: string, extra: Partial<MtAttackEvent> = {}): MtAttackEvent {
    return { kind: 'attack', source, target, attackType, element, failed: false, crit: flags.includes('Critical hit!'), killingBlow: false, damage, ...extra };
  }

  private element(words: string, line: string): MtElement | null {
    const el = mtElementOf(words);
    if (!el) this.opts.debug?.(`Unable to parse damage element from: ${line}`);
    return el;
  }

  private parseLine(line: string, me: string): MtCombatEvent | null {
    // Surges first: their lines can start "You cast".
    if (line.startsWith('You cast ') || line.startsWith('Your cloak ')) {
      const shroud = /^You cast Shroud of Darkness \((?:Melee|Missile|Magic)\) on (.+?)(?:,.*)?$/.exec(line);
      if (shroud) return { kind: 'cloakSurge', source: me, target: shroud[1]! };
      if (line.startsWith('You cast ') && line.includes('Cloaked in Skill')) return { kind: 'cloakSurge', source: me, target: me };
      if (/^Your cloak reduced the damage from \d+ down to \d+!$/.test(line)) return { kind: 'cloakSurge', source: me, target: me };
    }
    if (!line.startsWith('You cast') && !line.includes('has expired.')) {
      const s = SURGE.exec(line);
      if (s) {
        // Destruction / Protection / Regeneration land on their caster; Affliction and Festering have no known source.
        if (!CASTER_SURGES.has(s[2]!)) return null;
        return { kind: 'aetheriaSurge', source: s[1]!, target: s[1]! };
      }
    }

    // 1. failed attacks
    let m = /^You evaded (.+)!$/.exec(line);
    if (m) return this.attack(m[1]!, me, 'MeleeMissile', 'None', 0, '', { failed: true });
    m = /^(.+) evaded your attack\.$/.exec(line);
    if (m) return this.attack(me, m[1]!, 'MeleeMissile', 'None', 0, '', { failed: true });
    m = /^You resist the spell cast by (.+?)!?$/.exec(line);
    if (m) return this.attack(m[1]!, me, 'Magic', 'None', 0, '', { failed: true });
    m = /^(.+) resists your spell!?$/.exec(line);
    if (m) return this.attack(me, m[1]!, 'Magic', 'None', 0, '', { failed: true });

    // 2. killing blows
    for (const re of this.kills) {
      const k = re.exec(line);
      if (k) return this.attack(me, k[1]!, 'Unknown', 'None', 0, '', { killingBlow: true });
    }

    const flags = FLAG_RE.exec(line)![1]!;
    const body = line.slice(flags.length);

    // 4. (before 3: a line that starts "You" is yours) melee / missile given
    m = GIVEN_MELEE.exec(body);
    if (m) {
      const el = this.element(` ${m[1]} ${m[4]}`, line);
      return el ? this.attack(me, m[2]!, 'MeleeMissile', el, num(m[3]!), flags) : null;
    }
    // 6. magic given
    m = GIVEN_MAGIC.exec(body);
    if (m) {
      const el = this.element(` ${m[1]} with ${m[4]}`, line);
      return el ? this.attack(me, m[2]!, 'Magic', el, num(m[3]!), flags) : null;
    }
    // 3. melee / missile received
    m = RECEIVED_MELEE.exec(body);
    if (m) {
      const el = this.element(` ${m[2]} ${m[4]}`, line);
      return el ? this.attack(m[1]!, me, 'MeleeMissile', el, num(m[3]!), flags) : null;
    }
    // 5. magic received
    m = LOSE_HEALTH.exec(body);
    if (m) return this.attack(m[2]!, me, 'Magic', 'Typeless', num(m[1]!), flags);
    m = CASTS_DRAINS.exec(body);
    if (m) return this.attack(m[1]!, me, 'Magic', 'Typeless', num(m[2]!), flags);
    m = RECEIVED_MAGIC.exec(body);
    if (m && m[1] !== 'You') {
      const el = this.element(` ${m[2]} with ${m[4]}`, line);
      return el ? this.attack(m[1]!, me, 'Magic', el, num(m[3]!), flags) : null;
    }
    // 7. a debuff "attack"
    m = /^You cast Gossamer Flesh on (.+?)(?:,.*)?$/.exec(line);
    if (m) return this.attack(me, m[1]!, 'Magic', 'None', 0, '');
    return null;
  }
}

// ─── Aggregation ─────────────────────────────────────────────────────────

export interface MtAttackStats {
  totalAttacks: number; failedAttacks: number; crits: number;
  totalNormalDamage: number; maxNormalDamage: number; totalCritDamage: number; maxCritDamage: number;
}
const emptyStats = (): MtAttackStats => ({ totalAttacks: 0, failedAttacks: 0, crits: 0, totalNormalDamage: 0, maxNormalDamage: 0, totalCritDamage: 0, maxCritDamage: 0 });

/** One source → target pair's record (upstream's CombatInfo). */
export interface MtCombatInfo {
  source: string;
  target: string;
  killingBlows: number;
  /** attack type → element → stats. */
  stats: Partial<Record<MtAttackType, Partial<Record<MtElement, MtAttackStats>>>>;
  aetheriaSurges: number;
  cloakSurges: number;
}

/** The monster list's header and the detail grid's labels (verbatim). */
export const MT_COMBAT_MONSTER_HEADER = ['', '', "KB's", 'Dmg Rcvd', 'Dmg Givn'] as const;
export const MT_COMBAT_MONSTER_WIDTHS = [5, 111, 37, 55, 77] as const;
export const MT_COMBAT_DETAIL_WIDTHS = [40, 52, 52, 45, 96] as const;
const DETAIL_ELEMENTS: ReadonlyArray<[string, MtElement]> = [
  ['Typeless', 'Typeless'], ['Slash', 'Slash'], ['Pierce', 'Pierce'], ['Bludge', 'Bludge'], ['Fire', 'Fire'],
  ['Cold', 'Cold'], ['Acid', 'Acid'], ['Electric', 'Electric'],
];

export interface MtCombatSnapshot { infos: MtCombatInfo[]; order: string[] }

/** One tracker instance (Mag-Tools runs two: Current Session and Persistent). */
export class MtCombatTracker {
  private infos = new Map<string, MtCombatInfo>();
  /** Opponents, first seen first. */
  private order: string[] = [];
  private dmgOut: Array<{ at: number; damage: number }> = [];
  private dmgIn: Array<{ at: number; damage: number }> = [];
  private firstAt: number | null = null;

  constructor(private readonly me: () => string, private readonly now: () => number = () => Date.now()) {}

  private info(source: string, target: string): MtCombatInfo {
    const key = `${source}\u0000${target}`;
    let i = this.infos.get(key);
    if (!i) {
      i = { source, target, killingBlows: 0, stats: {}, aetheriaSurges: 0, cloakSurges: 0 };
      this.infos.set(key, i);
    }
    const me = this.me();
    for (const n of [source, target]) if (n !== me && !this.order.includes(n)) this.order.push(n);
    return i;
  }

  record(ev: MtCombatEvent): void {
    const i = this.info(ev.source, ev.target);
    if (ev.kind !== 'attack') {
      if (ev.kind === 'aetheriaSurge') i.aetheriaSurges++;
      else i.cloakSurges++;
      return;
    }
    if (ev.killingBlow) i.killingBlows++;
    const byEl = (i.stats[ev.attackType] ??= {});
    const st = (byEl[ev.element] ??= emptyStats());
    st.totalAttacks++;
    if (ev.failed) st.failedAttacks++;
    else if (ev.crit) { st.crits++; st.totalCritDamage += ev.damage; st.maxCritDamage = Math.max(st.maxCritDamage, ev.damage); }
    else { st.totalNormalDamage += ev.damage; st.maxNormalDamage = Math.max(st.maxNormalDamage, ev.damage); }
    if (ev.damage > 0) {
      const at = this.now();
      this.firstAt ??= at;
      (ev.source === this.me() ? this.dmgOut : this.dmgIn).push({ at, damage: ev.damage });
      this.prune(at);
    }
  }

  /** Spec §12 #10 (fixed): upstream's value series never prune; ours keep the last hour, the longest window used. */
  private prune(now: number): void {
    const cut = now - 3_600_000;
    while (this.dmgOut.length && this.dmgOut[0]!.at < cut) this.dmgOut.shift();
    while (this.dmgIn.length && this.dmgIn[0]!.at < cut) this.dmgIn.shift();
  }

  clear(): void {
    this.infos.clear(); this.order = []; this.dmgOut = []; this.dmgIn = []; this.firstAt = null;
  }

  /**
   * Damage per second over the last `windowMs`. Spec §12 #6 (fixed): upstream divides by the age
   * of the oldest event in the window (one fresh hit reads as a huge DPS); we divide by the
   * window, or by the time since the first event when that is shorter (at least 1 s).
   */
  dps(direction: 'out' | 'in', windowMs: number): number {
    const now = this.now();
    const series = direction === 'out' ? this.dmgOut : this.dmgIn;
    const sum = series.filter((e) => e.at > now - windowMs).reduce((t, e) => t + e.damage, 0);
    if (!sum || this.firstAt === null) return 0;
    const span = Math.max(1000, Math.min(windowMs, now - this.firstAt));
    return sum / (span / 1000);
  }

  /** Opponents in list order: first seen first, or by ordinal name. */
  opponents(sortAlphabetically = false): string[] {
    const list = [...this.order];
    return sortAlphabetically ? list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : list;
  }

  private involving(name: string | null): MtCombatInfo[] {
    const me = this.me();
    return [...this.infos.values()].filter((i) => (name === null
      ? i.source === me || i.target === me
      : (i.source === me && i.target === name) || (i.source === name && i.target === me) || (i.source === name && i.target === name)));
  }

  private static sum(infos: MtCombatInfo[], types: readonly MtAttackType[] = ['MeleeMissile', 'Magic', 'Unknown'], el?: MtElement): MtAttackStats {
    const t = emptyStats();
    for (const i of infos) {
      for (const ty of types) {
        for (const [e, s] of Object.entries(i.stats[ty] ?? {}) as Array<[MtElement, MtAttackStats]>) {
          if (el && e !== el) continue;
          t.totalAttacks += s.totalAttacks; t.failedAttacks += s.failedAttacks; t.crits += s.crits;
          t.totalNormalDamage += s.totalNormalDamage; t.totalCritDamage += s.totalCritDamage;
          t.maxNormalDamage = Math.max(t.maxNormalDamage, s.maxNormalDamage); t.maxCritDamage = Math.max(t.maxCritDamage, s.maxCritDamage);
        }
      }
    }
    return t;
  }
  private static dmg(s: MtAttackStats): number { return s.totalNormalDamage + s.totalCritDamage; }

  /**
   * The monster list (spec §5.2): the header row, `All`, then one row per opponent. Column 0 holds
   * `*` on the selected row (`selected` null = All). Cells stay blank at 0.
   */
  monsterRows(selected: string | null = null, sortAlphabetically = false): string[][] {
    const me = this.me();
    const cell = (n: number, cap: number) => (n === 0 ? '' : mtShortNumber(n, cap));
    const row = (label: string, name: string | null): string[] => {
      const infos = this.involving(name);
      const kbs = infos.filter((i) => i.source === me).reduce((t, i) => t + i.killingBlows, 0);
      const rcvd = MtCombatTracker.dmg(MtCombatTracker.sum(infos.filter((i) => i.target === me)));
      const givn = MtCombatTracker.dmg(MtCombatTracker.sum(infos.filter((i) => i.source === me)));
      return [selected === name ? '*' : '', label, cell(kbs, 99_999), cell(rcvd, 9_999_999), cell(givn, 99_999_999)];
    };
    return [[...MT_COMBAT_MONSTER_HEADER], row('All', null), ...this.opponents(sortAlphabetically).map((n) => row(n, n))];
  }

  /** The detail grid (11 rows × 5 columns, spec §5.2) for the selection (null = All). */
  detailRows(selected: string | null = null): string[][] {
    const me = this.me();
    const infos = this.involving(selected);
    const incoming = infos.filter((i) => i.target === me);
    const outgoing = infos.filter((i) => i.source === me);
    const n0 = (v: number) => (v === 0 ? '' : mtN(v, 0));
    const pct = (v: number, d: number) => { const r = mtRoundTo(Number.isFinite(v) ? v : 0, d); return (Object.is(r, -0) ? 0 : r).toFixed(d); };

    // Left block: damage received, melee/missile vs magic by element. Spec §12 #4 (fixed): upstream
    // writes the Typeless melee cell twice and never shows Typeless magic damage.
    const left = DETAIL_ELEMENTS.map(([label, el]) => [label,
      n0(MtCombatTracker.dmg(MtCombatTracker.sum(incoming, ['MeleeMissile'], el))),
      n0(MtCombatTracker.dmg(MtCombatTracker.sum(incoming, ['Magic'], el)))]);
    const totalMelee = MtCombatTracker.dmg(MtCombatTracker.sum(incoming, ['MeleeMissile']));
    const totalMagic = MtCombatTracker.dmg(MtCombatTracker.sum(incoming, ['Magic']));

    // Right block. Spec §12 #5 (kept): killing blows and Gossamer Flesh casts count as attacks, as upstream.
    const out = MtCombatTracker.sum(outgoing);
    const kbs = outgoing.reduce((t, i) => t + i.killingBlows, 0);
    const melee = MtCombatTracker.sum(incoming, ['MeleeMissile']);
    const magic = MtCombatTracker.sum(incoming, ['Magic']);
    const aSurges = infos.reduce((t, i) => t + (i.source === me ? i.aetheriaSurges : 0), 0);
    const cSurges = infos.reduce((t, i) => t + (i.source === me ? i.cloakSurges : 0), 0);
    const counted = (n: number, p: number, d: number) => (n === 0 ? '' : `${mtShortNumber(n, 999_999)} (${pct(p, d)}%)`);
    const attacks = counted(out.totalAttacks, ((out.totalAttacks - out.failedAttacks) / out.totalAttacks) * 100, 0);
    const evades = counted(melee.totalAttacks, (melee.failedAttacks / melee.totalAttacks) * 100, 0);
    const resists = counted(magic.totalAttacks, (magic.failedAttacks / magic.totalAttacks) * 100, 0);
    const aText = counted(aSurges, (aSurges / out.totalAttacks) * 100, 1);
    const hitsTaken = (melee.totalAttacks - melee.failedAttacks) + (magic.totalAttacks - magic.failedAttacks);
    const cText = cSurges === 0 ? '' : `${mtN(cSurges, 0)} (${pct((cSurges / hitsTaken) * 100, 1)}%)`;
    const normals = out.totalAttacks - out.failedAttacks - out.crits - kbs;
    const avg = normals > 0 ? Math.floor(out.totalNormalDamage / normals) : 0;
    const avgMax = avg === 0 ? '' : `${mtN(avg, 0)} / ${mtN(out.maxNormalDamage, 0)}`;
    const crits = counted(out.crits, (out.crits / (out.totalAttacks - out.failedAttacks - kbs)) * 100, 1);
    const critAvg = out.crits > 0 ? Math.floor(out.totalCritDamage / out.crits) : 0;
    const critAvgMax = critAvg === 0 ? '' : `${mtN(critAvg, 0)} / ${mtN(out.maxCritDamage, 0)}`;
    const given = MtCombatTracker.dmg(out);

    const right: Array<[string, string]> = [
      ['Evades', evades], ['Resists', resists], ['A.Surges', aText], ['C.Surges', cText], ['', ''],
      ['Av/Mx', avgMax], ['Crits', crits], ['Av/Mx', critAvgMax],
    ];
    const rows: string[][] = [['', 'Mel/Msl', 'Magic', 'Attacks', attacks]];
    for (let r = 0; r < 8; r++) rows.push([...left[r]!, ...right[r]!]);
    rows.push(['', '', '', '', '']);
    rows.push(['Total', n0(totalMelee), n0(totalMagic), 'Total', n0(given)]);
    return rows;
  }

  /** The records, for persistence (per character, in the automation layer's store). */
  snapshot(): MtCombatSnapshot {
    return { infos: JSON.parse(JSON.stringify([...this.infos.values()])) as MtCombatInfo[], order: [...this.order] };
  }
  restore(s: MtCombatSnapshot): void {
    this.clear();
    for (const i of s.infos) this.infos.set(`${i.source}\u0000${i.target}`, JSON.parse(JSON.stringify(i)) as MtCombatInfo);
    this.order = [...s.order];
  }
}
