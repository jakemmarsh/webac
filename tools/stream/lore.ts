/**
 * `./world-query lore "<monster>"`: a wiki-style monster lookup for stream players (tools/stream/brief.md). A real
 * player knows a monster's weaknesses from experience or a wiki; AC's creature appraisal doesn't show them, and a
 * brief line pointing at "weenie_properties_float 64–70" was ignored at decision time (Jake 2026-10-14: Claude
 * Arcanist kept casting Flame Bolt at Olthoi, which take 75% fire but 100% pierce/bludgeon).
 *
 * The SQL lives in world-query.ts (read-only, like every other query there); everything here is pure: which names a
 * query means (pickLoreNames), the tagged result rows → creatures (parseLoreRows), and creatures → text (formatLore).
 *
 * Sources (ACE): PropertyInt Level 25 / XpOverride 146; PropertyFloat ResistSlash 64, ResistPierce 65, ResistBludgeon
 * 66, ResistFire 67, ResistCold 68, ResistAcid 69, ResistElectric 70 (absent = 1.0, Creature_Properties
 * GetResistanceMod); max health = MaxHealth (attribute_2nd 1) init + ranks + round(Endurance / 2) (CreatureVital.Base,
 * AttributeFormula); a spellbook probability p casts with chance p − 2 when p > 2, else p / 100 (Monster_Magic
 * TryRollSpell); body-part damage types are DamageType flags; wielded WeenieType 3/4 (MissileLauncher / Missile) =
 * a missile attacker.
 */

export const ELEMENTS = ['slash', 'pierce', 'bludgeon', 'fire', 'cold', 'acid', 'electric'] as const;
export type Element = (typeof ELEMENTS)[number];

/** PropertyFloat id (ACE PropertyFloat.cs) → element. */
export const RESIST_PROPERTY: Record<number, Element> = { 64: 'slash', 65: 'pierce', 66: 'bludgeon', 67: 'fire', 68: 'cold', 69: 'acid', 70: 'electric' };

/** The war-magic bolt line for each element (spell table: Whirling Blade I, Force Bolt I, Shock Wave I …). */
export const WAR_SPELL: Record<Element, string> = {
  slash: 'Whirling Blade', pierce: 'Force Bolt', bludgeon: 'Shock Wave', fire: 'Flame Bolt', cold: 'Frost Bolt', acid: 'Acid Stream', electric: 'Lightning Bolt',
};

/** DamageType flags (ACE DamageType.cs) for body-part attacks. */
const DAMAGE_FLAGS: [number, Element][] = [[0x1, 'slash'], [0x2, 'pierce'], [0x4, 'bludgeon'], [0x8, 'cold'], [0x10, 'fire'], [0x20, 'acid'], [0x40, 'electric']];

export interface LoreCreature {
  wcid: number;
  className: string;
  name: string;
  level?: number;
  xp?: number;
  /** MaxHealth vital: init + ranks (attribute_2nd type 1). */
  healthInit?: number;
  /** Endurance: init + ranks (attribute type 2). */
  endurance?: number;
  /** Share of damage taken per element, from PropertyFloat 64–70 (absent = 1). */
  resist: Partial<Record<Element, number>>;
  spells: LoreSpell[];
  /** The body parts that hit (d_Val > 0): DamageType flags, max damage, variance. */
  bodyAttacks: { flags: number; dVal: number; dVar: number }[];
  /** Wielded gear (create list or wielded-treasure table): name, WeenieType, and its Damage (int 44), DamageType
   *  (int 45) and DamageVariance (float 22) when set. */
  wielded: { name: string; weenieType: number; damage?: number; damageType?: number; variance?: number }[];
  /** Placements (landblock_instance) + generator slots that make it: 0 = not in the world as such. */
  spawns: number;
  /** The interior cells (dungeon or building rooms) it is placed in (landblock_instance obj_Cell_Id), when any. */
  cells?: number[];
}

export interface LoreSpell {
  name: string;
  /** Spellbook probability (castChance turns it into a chance per attack). */
  probability: number;
  id?: number;
  /** A projectile's DamageType (spell e_Type) and damage (base_Intensity + variance / 2). */
  element?: number;
  damage?: number;
  /** A health boost's average (|boost| + |boost_Variance| / 2) when it harms (boost < 0, damage_Type Health). */
  harm?: number;
  /** SpellBase.bitfield from the DAT SpellTable (0x4 Beneficial, 0x8 SelfTargeted), when it was read. */
  flags?: number;
}

export function escapeSqlLike(s: string): string {
  // A literal backslash in a LIKE pattern is four in the SQL text (string literal, then LIKE's own escape).
  return s.replace(/\\/g, '\\\\\\\\').replace(/'/g, "''").replace(/[%_]/g, (m) => `\\${m}`);
}

/** Every creature (weenie type 10) whose name contains `query`, case-insensitively. */
export function loreNameSql(query: string): string {
  return `SELECT w.class_Id, s.value FROM weenie w JOIN weenie_properties_string s ON s.object_Id = w.class_Id AND s.type = 1 WHERE w.type = 10 AND LOWER(s.value) LIKE LOWER('%${escapeSqlLike(query.trim())}%') LIMIT 2000`;
}

/** A wielded item's Damage (int 44), DamageType (int 45) and DamageVariance (float 22). */
const WEAPON_COLS = [
  '(SELECT value FROM weenie_properties_int x WHERE x.object_Id = iw.class_Id AND x.type = 44 LIMIT 1)',
  '(SELECT value FROM weenie_properties_int x WHERE x.object_Id = iw.class_Id AND x.type = 45 LIMIT 1)',
  '(SELECT value FROM weenie_properties_float x WHERE x.object_Id = iw.class_Id AND x.type = 22 LIMIT 1)',
].join(', ');

/** The tagged detail rows for `wcids` (one statement each; parseLoreRows reads them back). */
export function loreDetailSql(wcids: number[]): string[] {
  const ids = wcids.map((n) => Math.trunc(n)).filter((n) => Number.isFinite(n) && n > 0).join(',') || '0';
  return [
    `SELECT 'n', w.class_Id, w.class_Name, s.value FROM weenie w JOIN weenie_properties_string s ON s.object_Id = w.class_Id AND s.type = 1 WHERE w.class_Id IN (${ids})`,
    `SELECT 'i', object_Id, type, value FROM weenie_properties_int WHERE object_Id IN (${ids}) AND type IN (25, 146)`,
    `SELECT 'f', object_Id, type, value FROM weenie_properties_float WHERE object_Id IN (${ids}) AND type BETWEEN 64 AND 70`,
    `SELECT 'a', object_Id, type, init_Level + level_From_C_P FROM weenie_properties_attribute WHERE object_Id IN (${ids}) AND type = 2`,
    `SELECT 'v', object_Id, type, init_Level + level_From_C_P FROM weenie_properties_attribute_2nd WHERE object_Id IN (${ids}) AND type = 1`,
    `SELECT 's', b.object_Id, b.probability, COALESCE(sp.name, CONCAT('spell #', b.spell)), b.spell, sp.e_Type, sp.base_Intensity, sp.variance, sp.damage_Type, sp.boost, sp.boost_Variance FROM weenie_properties_spell_book b LEFT JOIN spell sp ON sp.id = b.spell WHERE b.object_Id IN (${ids})`,
    `SELECT 'b', object_Id, d_Type, d_Val, d_Var FROM weenie_properties_body_part WHERE object_Id IN (${ids}) AND d_Val > 0`,
    `SELECT 'w', c.object_Id, iw.type, COALESCE(s.value, iw.class_Name), ${WEAPON_COLS} FROM weenie_properties_create_list c JOIN weenie iw ON iw.class_Id = c.weenie_Class_Id LEFT JOIN weenie_properties_string s ON s.object_Id = iw.class_Id AND s.type = 1 WHERE c.object_Id IN (${ids}) AND (c.destination_Type & 2) <> 0`,
    `SELECT DISTINCT 'w', d.object_Id, iw.type, COALESCE(s.value, iw.class_Name), ${WEAPON_COLS} FROM weenie_properties_d_i_d d JOIN treasure_wielded t ON t.treasure_Type = d.value JOIN weenie iw ON iw.class_Id = t.weenie_Class_Id LEFT JOIN weenie_properties_string s ON s.object_Id = iw.class_Id AND s.type = 1 WHERE d.object_Id IN (${ids}) AND d.type = 32`,
    `SELECT 'p', weenie_Class_Id, COUNT(*), 0 FROM landblock_instance WHERE weenie_Class_Id IN (${ids}) GROUP BY weenie_Class_Id`,
    `SELECT DISTINCT 'c', weenie_Class_Id, obj_Cell_Id, 0 FROM landblock_instance WHERE weenie_Class_Id IN (${ids}) AND (obj_Cell_Id & 0xFFFF) >= 0x100 ORDER BY obj_Cell_Id LIMIT 300`,
    `SELECT 'p', weenie_Class_Id, COUNT(*), 0 FROM weenie_properties_generator WHERE weenie_Class_Id IN (${ids}) GROUP BY weenie_Class_Id`,
  ];
}

export interface LorePick {
  /** The distinct names to look up (empty when none or too many). */
  names: string[];
  /** The wcids carrying those names. */
  wcids: number[];
  /** A line for the reader: what matched how, or the list to choose from. */
  note?: string;
}

const LORE_MAX_NAMES = 3;

/**
 * Which creature names `query` means, from every (wcid, name) containing it: an exact name (case-insensitive) wins,
 * else names starting with it, else names containing it. More than LORE_MAX_NAMES distinct names → list them instead.
 */
export function pickLoreNames(query: string, rows: { wcid: number; name: string }[], maxNames = LORE_MAX_NAMES): LorePick {
  const q = query.trim().toLowerCase();
  if (!q) return { names: [], wcids: [], note: 'give a monster name: ./world-query lore "Olthoi Gardener"' };
  const byName = new Map<string, { name: string; wcids: number[] }>();
  for (const r of rows) {
    const k = r.name.trim().toLowerCase();
    if (!k.includes(q)) continue;
    const e = byName.get(k) ?? { name: r.name.trim(), wcids: [] };
    if (!e.wcids.includes(r.wcid)) e.wcids.push(r.wcid);
    byName.set(k, e);
  }
  const all = [...byName.entries()];
  if (!all.length) return { names: [], wcids: [], note: `no creature called "${query.trim()}" (try a shorter part of the name)` };
  const exact = all.filter(([k]) => k === q);
  const prefix = all.filter(([k]) => k.startsWith(q));
  const tier = exact.length ? exact : prefix.length ? prefix : all;
  const how = exact.length ? 'exact' : prefix.length ? 'starting with' : 'containing';
  const sorted = tier.map(([, e]) => e).sort((a, b) => a.name.localeCompare(b.name));
  if (sorted.length > maxNames) {
    const shown = sorted.slice(0, 40).map((e) => e.name);
    return {
      names: [], wcids: [],
      note: `${sorted.length} creatures ${how} "${query.trim()}": ${shown.join(', ')}${sorted.length > shown.length ? `, … (${sorted.length - shown.length} more)` : ''}. Give more of the name.`,
    };
  }
  const others = exact.length ? prefix.filter(([k]) => k !== q).map(([, e]) => e.name) : [];
  const notes: string[] = [];
  if (sorted.length > 1) notes.push(`${sorted.length} creatures ${how} "${query.trim()}": ${sorted.map((e) => e.name).join(', ')}.`);
  else if (!exact.length) notes.push(`(nothing called exactly "${query.trim()}"; showing ${sorted[0].name})`);
  if (others.length) notes.push(`Also: ${others.slice(0, 10).join(', ')}${others.length > 10 ? ', …' : ''}.`);
  return { names: sorted.map((e) => e.name), wcids: sorted.flatMap((e) => e.wcids), note: notes.join(' ') || undefined };
}

/** Tab-separated `mysql -N --batch` rows from loreDetailSql → creatures, in wcid order. */
export function parseLoreRows(tsv: string): LoreCreature[] {
  const by = new Map<number, LoreCreature>();
  const get = (wcid: number) => {
    let c = by.get(wcid);
    if (!c) { c = { wcid, className: '', name: '', resist: {}, spells: [], bodyAttacks: [], wielded: [], spawns: 0 }; by.set(wcid, c); }
    return c;
  };
  for (const line of tsv.split('\n')) {
    if (!line.trim()) continue;
    const [tag, idS, a = '', b = '', ...more] = line.split('\t');
    const n = (x: string | undefined) => (x === undefined || x === '' || x === 'NULL' ? undefined : Number(x));
    const wcid = Number(idS);
    if (!Number.isFinite(wcid)) continue;
    const c = get(wcid);
    switch (tag) {
      case 'n': c.className = a; c.name = b; break;
      case 'i': if (Number(a) === 25) c.level = Number(b); else if (Number(a) === 146) c.xp = Number(b); break;
      case 'f': { const el = RESIST_PROPERTY[Number(a)]; if (el) c.resist[el] = Number(b); break; }
      case 'a': c.endurance = Number(b); break;
      case 'v': c.healthInit = Number(b); break;
      case 's': {
        const [id, eType, base, variance, damageType, boost, boostVar] = more.map(n);
        const sp: LoreSpell = { name: b, probability: Number(a) };
        if (id !== undefined) sp.id = id;
        if (eType) { sp.element = eType; sp.damage = (base ?? 0) + (variance ?? 0) / 2; }
        if (damageType === 0x80 && boost !== undefined && boost < 0) sp.harm = Math.abs(boost) + Math.abs(boostVar ?? 0) / 2;
        c.spells.push(sp);
        break;
      }
      case 'b': c.bodyAttacks.push({ flags: Number(a), dVal: Number(b), dVar: n(more[0]) ?? 0 }); break;
      case 'w': if (!c.wielded.some((w) => w.name === b)) {
        const [damage, damageType, variance] = more.map(n);
        c.wielded.push({ name: b, weenieType: Number(a), ...(damage !== undefined && { damage }), ...(damageType !== undefined && { damageType }), ...(variance !== undefined && { variance }) });
      } break;
      case 'p': c.spawns += Number(a); break;
      case 'c': { const cell = Number(a) >>> 0; if (Number.isFinite(Number(a)) && !(c.cells ??= []).includes(cell)) c.cells.push(cell); break; }
    }
  }
  return [...by.values()].filter((c) => c.name).sort((x, y) => x.wcid - y.wcid);
}

const LORE_ROOM_LANDBLOCKS = 6;
const LORE_ROOM_CELLS = 4;
const hexCell = (n: number): string => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

/**
 * "  placed in rooms: 0x0185: 0x01850114, 0x01850148, 0x0185014E; …" for the dungeon / building cells a creature is
 * placed in, by landblock, with how walk_to takes one. Null when none. Bulwark read the Horrible Mu-miyahs' cells from a
 * hand query as decimals, converted them wrongly and never walked there (Daiklos, 2026-10-16).
 */
export function placedRooms(cells: number[]): string | null {
  const by = new Map<number, number[]>();
  for (const c of [...new Set(cells.map((x) => x >>> 0))].sort((a, b) => a - b)) {
    if ((c & 0xffff) < 0x100) continue;
    const lb = c >>> 16;
    by.set(lb, [...(by.get(lb) ?? []), c]);
  }
  if (!by.size) return null;
  const lbs = [...by.entries()].slice(0, LORE_ROOM_LANDBLOCKS).map(([lb, cs]) =>
    `0x${lb.toString(16).toUpperCase().padStart(4, '0')}: ${cs.slice(0, LORE_ROOM_CELLS).map(hexCell).join(', ')}${cs.length > LORE_ROOM_CELLS ? ` +${cs.length - LORE_ROOM_CELLS} more` : ''}`);
  const first = [...by.values()][0][0];
  return `  placed in rooms (landblock: cells): ${lbs.join('; ')}${by.size > LORE_ROOM_LANDBLOCKS ? `; +${by.size - LORE_ROOM_LANDBLOCKS} more landblocks` : ''}. From inside that dungeon, \`walk_to target=${hexCell(first)}\` walks to the room`;
}

/** Max health as ACE computes it (CreatureVital.Base): MaxHealth init + ranks + round(Endurance / 2). */
export function maxHealth(c: LoreCreature): number | undefined {
  if (c.healthInit === undefined) return undefined;
  return c.healthInit + (c.endurance !== undefined ? Math.round(c.endurance / 2) : 0);
}

/** Damage taken per element (absent = 100%), best-first (most damage taken first), ties in enum order. */
export function damageTaken(resist: Partial<Record<Element, number>>): { element: Element; pct: number }[] {
  return ELEMENTS.map((element, i) => ({ element, pct: Math.round((resist[element] ?? 1) * 100), i }))
    .sort((a, b) => b.pct - a.pct || a.i - b.i)
    .map(({ element, pct }) => ({ element, pct }));
}

/** The war spell lines that hurt most (all tied for the top) and those to avoid (all tied for the bottom, when lower). */
export function bestWarElements(resist: Partial<Record<Element, number>>): { best: Element[]; bestPct: number; worst: Element[]; worstPct: number } {
  const t = damageTaken(resist);
  const bestPct = t[0].pct;
  const worstPct = t[t.length - 1].pct;
  return {
    best: t.filter((x) => x.pct === bestPct).map((x) => x.element),
    bestPct,
    worst: worstPct < bestPct ? t.filter((x) => x.pct === worstPct).map((x) => x.element) : [],
    worstPct,
  };
}

/** Monster_Magic.TryRollSpell: p > 2 → p − 2, else p / 100. */
export function castChance(p: number): number {
  return p > 2 ? p - 2 : p / 100;
}

function attackLine(c: LoreCreature): string {
  // A wielded melee weapon replaces its body-part attacks (defenseFor counts it the same way).
  const weapons = c.wielded.filter((w) => w.weenieType === 6);
  const typed = weapons.filter((w) => w.damageType);
  const meleeFlags = typed.length ? typed.map((w) => w.damageType!) : c.bodyAttacks.map((b) => b.flags);
  const melee = new Set(meleeFlags.flatMap(splitFlags));
  const missile = c.wielded.filter((w) => w.weenieType === 3 || w.weenieType === 4);
  const parts: string[] = [];
  const types = melee.size ? ` (${ELEMENTS.filter((e) => melee.has(e)).join(', ')})` : '';
  if (weapons.length) parts.push(`melee${types} with ${listClip(weapons.map((w) => w.name), 4)}`);
  else if (melee.size) parts.push(`melee${types}`);
  if (missile.length) parts.push(`MISSILE: ${listClip(missile.map((w) => w.name), 4)} (it shoots from range)`);
  const spells = [...c.spells].sort((a, b) => castChance(b.probability) - castChance(a.probability) || a.name.localeCompare(b.name));
  if (spells.length) {
    const shown = spells.slice(0, 8).map((s) => `${s.name} ${Math.round(castChance(s.probability) * 100)}%`);
    parts.push(`CASTS (chance per attack): ${shown.join(', ')}${spells.length > shown.length ? `, +${spells.length - shown.length} more` : ''}`);
  } else parts.push('casts nothing');
  return parts.join('; ');
}

function listClip(xs: string[], n: number): string {
  return xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} +${xs.length - n} more`;
}

function body(c: LoreCreature): string[] {
  const head = [
    c.level !== undefined ? `level ${c.level}` : 'level ?',
    c.xp !== undefined ? `${c.xp.toLocaleString('en-US')} XP per kill` : 'XP per kill not set',
  ];
  const hp = maxHealth(c);
  if (hp !== undefined) head.push(`${hp} health`);
  const t = damageTaken(c.resist);
  const w = bestWarElements(c.resist);
  const war = w.worst.length
    ? `war magic: ${w.best.map((e) => WAR_SPELL[e]).join(' / ')} (${w.bestPct}%) hurts most; ${w.worst.map((e) => WAR_SPELL[e]).join(' / ')} (${w.worstPct}%) least`
    : `war magic: every element does the same (${w.bestPct}%)`;
  return [
    head.join(', '),
    `  takes ${t.map((x) => `${x.pct}% ${x.element}`).join(', ')}`,
    `  ${war}`,
    `  attacks: ${attackLine(c)}`,
    ...defenseLines(c),
  ];
}

/**
 * One compact block per distinct version of each name (versions with identical stats share a block, their wcids
 * listed with how many placements / generator slots make each, so the one actually in the world is plain).
 */
export function formatLore(pick: LorePick, creatures: LoreCreature[]): string {
  const out: string[] = [];
  if (pick.note) out.push(pick.note);
  for (const name of pick.names) {
    const mine = creatures.filter((c) => c.name.toLowerCase() === name.toLowerCase());
    const groups = new Map<string, LoreCreature[]>();
    for (const c of mine) {
      const k = body(c).join('\n');
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    const blocks = [...groups.entries()].map(([text, cs]) => ({ text, cs, spawns: cs.reduce((n, c) => n + c.spawns, 0), level: cs[0].level ?? 0 }))
      .sort((a, b) => Number(b.spawns > 0) - Number(a.spawns > 0) || a.level - b.level);
    if (blocks.length > 1) out.push(`${name}: ${blocks.length} versions`);
    const split = blocks.map((b) => {
      const where = b.cs.map((c) => `${c.wcid} ${c.spawns ? `${c.spawns} spawn point${c.spawns === 1 ? '' : 's'}` : 'no spawns found'}`).join(', ');
      const [first, ...rest] = b.text.split('\n');
      return { head: `${name}: ${first}  [wcid ${where}]`, rest };
    });
    // A line every version has alike (their weaknesses, usually) is said once, after the versions.
    // When the versions differ in more than level / XP / health, the shared lines come first, under the count.
    const shared = split[0].rest.map((l, i) => split.every((x) => x.rest[i] === l));
    const common = split[0].rest.filter((_, i) => shared[i]);
    const own = (x: (typeof split)[number]) => x.rest.filter((_, i) => !shared[i]);
    if (split.some((x) => own(x).length)) out.push(...common);
    for (const x of split) out.push(x.head, ...own(x));
    if (!split.some((x) => own(x).length)) out.push(...common);
    const rooms = placedRooms(mine.flatMap((c) => c.cells ?? []));
    if (rooms) out.push(rooms);
  }
  return out.join('\n');
}

// ---- What to put up against it ---------------------------------------------------------------------------------

/**
 * The protection spells per element, by their spell-table names (DAT SpellTable 0x0E00000E: "<X> Protection Self I" /
 * "… Other I" are Life Magic, "<X> Bane I" Item Enchantment; tests/verify-stream-lore.ts checks every name and school
 * against the DAT).
 */
export const PROTECTION: Record<Element, string> = {
  slash: 'Blade Protection', pierce: 'Piercing Protection', bludgeon: 'Bludgeoning Protection', fire: 'Fire Protection',
  cold: 'Cold Protection', acid: 'Acid Protection', electric: 'Lightning Protection',
};
export const BANE: Record<Element, string> = {
  slash: 'Blade Bane', pierce: 'Piercing Bane', bludgeon: 'Bludgeon Bane', fire: 'Flame Bane', cold: 'Frost Bane', acid: 'Acid Bane', electric: 'Lightning Bane',
};
/** The general buffs and their schools: Armor (Life), Invulnerability / Impregnability / Magic Resistance (Creature:
 *  Melee / Missile / Magic Defense), Impenetrability (Item: the armor's own AL). */
export const DEFENSE_SCHOOL: Record<string, 'Life' | 'Creature' | 'Item'> = {
  ...Object.fromEntries(Object.values(PROTECTION).map((n) => [n, 'Life'])),
  Armor: 'Life', Invulnerability: 'Creature', Impregnability: 'Creature', 'Magic Resistance': 'Creature',
};

const SPELL_BENEFICIAL = 0x4;
const DEFENSE_MIN_PCT = 10;

/** Does the monster cast `s` at you? From the DAT flags (ACE CastSpell: not Beneficial); without them, a
 *  projectile, a harm, or an "… Other" spell. */
export function castsAtYou(s: LoreSpell): boolean {
  if (s.flags !== undefined) return (s.flags & SPELL_BENEFICIAL) === 0;
  return s.element !== undefined || s.harm !== undefined || /\bOther\b/.test(s.name);
}

export interface Defense {
  /** Buffs with the share of its expected damage per attack each one covers, most first. */
  buffs: { name: string; school: 'Life' | 'Creature'; pct: number }[];
  /** Hostile spells that do no damage (debuffs, drains): Magic Resistance helps against them. */
  debuffs: string[];
  /** Item Enchantment for your armor: banes for its elements, Impenetrability when it hits physically. */
  item: string[];
}

function splitFlags(flags: number): Element[] {
  return DAMAGE_FLAGS.filter(([bit]) => flags & bit).map(([, el]) => el);
}

/**
 * Its expected damage per attack, by element and by kind, and so what each protection covers. A physical attack is
 * one of its options (a wielded melee weapon replaces its body parts; a thrown weapon is another option), each worth
 * its average (max × (1 − variance / 2), split across a multi-type attack); a spell replaces a physical attack with
 * its cast chance, worth its projectile's average damage or a harm's.
 */
export function defenseFor(c: LoreCreature): Defense {
  const avg = (max: number, v = 0) => max * (1 - v / 2);
  const meleeW = c.wielded.filter((w) => w.weenieType === 6 && w.damage && w.damageType);
  const melee = meleeW.length
    ? meleeW.map((w) => ({ flags: w.damageType!, dmg: avg(w.damage!, w.variance) }))
    : c.bodyAttacks.map((b) => ({ flags: b.flags, dmg: avg(b.dVal, b.dVar) }));
  const missile = c.wielded.filter((w) => w.weenieType === 4 && w.damage && w.damageType).map((w) => ({ flags: w.damageType!, dmg: avg(w.damage!, w.variance) }));
  const groups = [melee, missile].filter((g) => g.length);
  const byElement = (g: { flags: number; dmg: number }[]) => {
    const out: Partial<Record<Element, number>> = {};
    for (const o of g) { const els = splitFlags(o.flags); for (const e of els) out[e] = (out[e] ?? 0) + o.dmg / els.length / g.length; }
    return out;
  };
  const castAny = 1 - c.spells.reduce((p, s) => p * (1 - Math.min(1, castChance(s.probability))), 1);
  const physShare = groups.length ? (1 - castAny) / groups.length : 0;
  const el: Partial<Record<Element, number>> = {};
  const add = (e: Element, v: number) => { el[e] = (el[e] ?? 0) + v; };
  let meleeDmg = 0, missileDmg = 0;
  for (const g of groups) {
    const per = byElement(g);
    for (const [e, v] of Object.entries(per) as [Element, number][]) {
      add(e, v * physShare);
      if (g === melee) meleeDmg += v * physShare; else missileDmg += v * physShare;
    }
  }
  let spellDmg = 0, harmDmg = 0;
  const debuffs: string[] = [];
  for (const s of c.spells.filter(castsAtYou)) {
    const ch = Math.min(1, castChance(s.probability));
    if (s.element && s.damage) {
      const els = splitFlags(s.element);
      for (const e of els) add(e, (ch * s.damage) / els.length);
      spellDmg += ch * s.damage;
    } else if (s.harm) { harmDmg += ch * s.harm; spellDmg += ch * s.harm; }
    else debuffs.push(s.name);
  }
  const total = Object.values(el).reduce((a, b) => a + (b ?? 0), 0) + harmDmg;
  const pct = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 0);
  const buffs: Defense['buffs'] = [];
  for (const e of ELEMENTS) if ((el[e] ?? 0) > 0) buffs.push({ name: PROTECTION[e], school: 'Life', pct: pct(el[e]!) });
  if (meleeDmg + missileDmg > 0) buffs.push({ name: 'Armor', school: 'Life', pct: pct(meleeDmg + missileDmg) });
  if (meleeDmg > 0) buffs.push({ name: 'Invulnerability', school: 'Creature', pct: pct(meleeDmg) });
  if (missileDmg > 0) buffs.push({ name: 'Impregnability', school: 'Creature', pct: pct(missileDmg) });
  if (spellDmg > 0 || debuffs.length) buffs.push({ name: 'Magic Resistance', school: 'Creature', pct: pct(spellDmg) });
  const order = (b: Defense['buffs'][number]) => buffs.indexOf(b);
  buffs.sort((a, b) => b.pct - a.pct || order(a) - order(b));
  const item = ELEMENTS.filter((e) => pct(el[e] ?? 0) >= DEFENSE_MIN_PCT).sort((a, b) => el[b]! - el[a]!).map((e) => BANE[e]);
  if (meleeDmg + missileDmg > 0) item.push('Impenetrability');
  return { buffs, debuffs, item };
}

function defenseLines(c: LoreCreature): string[] {
  const d = defenseFor(c);
  if (!d.buffs.length) return [];
  // One or two lines: what covers at least a tenth of its damage (the top one always), most first.
  const shown = d.buffs.filter((b, i) => i === 0 || b.pct >= DEFENSE_MIN_PCT).slice(0, 7);
  const hidden = d.buffs.length - shown.length;
  const parts = shown.map((b, i) => {
    const next = shown[i + 1];
    const tag = !next || next.school !== b.school ? ` (${b.school})` : '';
    return `${b.name} ${b.pct}%${tag}`;
  });
  const lines = [`  defend with (share of its damage each covers): ${parts.join(', ')}${hidden ? `, +${hidden} under ${DEFENSE_MIN_PCT}%` : ''}`
    + `${d.debuffs.length ? `; Magic Resistance also resists its ${listClip(d.debuffs, 2)}` : ''}`];
  if (d.item.length) lines.push(`  Item Enchantment on your armor: ${d.item.join(', ')}`);
  return lines;
}
