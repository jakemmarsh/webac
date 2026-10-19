/**
 * Compact text renderings of agent API results — what an LLM player reads.
 * Text, not JSON: a dozen nearby objects as JSON is ~3× the tokens and
 * harder to scan. Pure functions; the CLI and the MCP server both use them.
 */
import { emptySlotsText, formatGear, gearNote, hasGearData } from './gear.ts';
import type { AgentChatLine, AgentEvent, AgentItem, AgentObject, AgentObservation, AgentPackSlots, AgentSpell, AgentTracePoint } from './types.ts';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** 0..360 compass bearing → "N" / "NE" / … */
export function compassPoint(bearing: number): string {
  const b = ((bearing % 360) + 360) % 360;
  return COMPASS[Math.round(b / 45) % 8];
}

/**
 * An attacker your client hasn't placed where it could reach you, said plainly (observe and the attackers-up event).
 * ACE: a monster's melee lands on distance alone (Monster_Navigation.IsMeleeInRange: CylinderDistance <= MaxMeleeRange
 * 0.75 m, no line-of-sight test), so it swings through a wall or shut door; its war bolts need a clear line from it to
 * you when it picks the spell (Monster_Combat.GetMaxRange → IsDirectVisible, else it rerolls or falls back to melee),
 * and fly as objects that walls stop (SpellProjectile.OnCollideEnvironment). Your client shows only creatures in the
 * cells yours can see (the cell's VisibleCells), so a bolt that reaches you came through an opening into a room your
 * client doesn't show, or from the creature at your body.
 */
export function unplacedText(u: { name: string; count: number; unseen?: { dist: number; bearing: number; dz: number } }): string {
  const art = /^the /i.test(u.name) ? '' : /^[aeiou]/i.test(u.name) ? 'an ' : 'a ';
  const where = u.unseen
    ? `it's in a room out of your sight, ${u.unseen.dist.toFixed(0)} m ${compassPoint(u.unseen.bearing)}${Math.abs(u.unseen.dz) >= 2 ? `, ${Math.abs(u.unseen.dz).toFixed(0)} m ${u.unseen.dz > 0 ? 'up' : 'down'}` : ''} by the server's last placement`
    : `none of that name is in sight within reach of you, and your client knows of none in the rooms out of your sight`;
  return `${art}${u.name} you can't see (${u.count}× in 10 s): ${where}. Its melee reaches through a wall or shut door (the server checks distance only); its bolts need a clear line from it, so they come through an opening into its room. Step away from the wall, or go into its room to fight it`;
}

/** Relative bearing → "ahead" / "ahead-left" / "left" / "behind-right" / … */
export function relativeDirection(rel: number): string {
  const a = Math.abs(rel);
  const side = rel < 0 ? 'left' : 'right';
  if (a <= 20) return 'ahead';
  if (a <= 70) return `ahead-${side}`;
  if (a <= 110) return side;
  if (a <= 160) return `behind-${side}`;
  return 'behind';
}

const pct = (f: number): string => `${Math.round(f * 100)}%`;

/** "45s", "12m", "3h", "2d": how long ago a remembered place was seen. */
export function seenAgoText(s: number): string {
  if (s < 120) return `${Math.round(s)}s`;
  if (s < 2 * 3600) return `${Math.round(s / 60)}m`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function formatObject(o: AgentObject): string {
  const bits = [
    `#${o.guid.toString(16)}`,
    o.name,
    `[${o.kind}${o.level ? ` L${o.level}` : ''}]`,
    `${o.dist.toFixed(1)}m ${relativeDirection(o.relBearing)} (${compassPoint(o.bearing)})`,
  ];
  if (Math.abs(o.dz) >= 2) bits.push(`${o.dz > 0 ? 'up' : 'down'} ${Math.abs(o.dz).toFixed(0)}m`);
  if (o.health !== undefined && !o.dying) bits.push(`hp ${pct(o.health)}`);
  if (o.stack && o.stack > 1) bits.push(`x${o.stack}`);
  if (o.open) bits.push('open');
  else if (o.open === false) bits.push('closed');
  if (o.notByHand) bits.push('opened by a lever or switch, not by hand');
  if (o.dying) bits.push('DYING (dead: not a target)');
  if (o.outOfSight) bits.push(o.foeAgoS !== undefined
    ? `OUT OF SIGHT: only where it was last seen, but it attacked ${o.foeAgoS ? `${o.foeAgoS} s ago` : 'just now'} (ac_attack goes to where it was last seen and fights it there)`
    : 'OUT OF SIGHT: only where it was last seen (it may have moved, died or gone)');
  if (o.otherFloor !== undefined) {
    // Whether a walk gets there is the walk planner's answer (the doorway route walk_to takes), not the height's.
    const w = o.otherFloorWay;
    const way = w === 'none' ? 'no walk reaches it from here (no doorway route from your floor)'
      : w && 'locked' in w ? `no walk reaches it from here but through ${w.locked}`
      : w ? `a walk gets there by the doorways (about ${Math.round(w.len)} m${w.drops ? `, ${w.drops === 1 ? 'a drop' : `${w.drops} drops`}` : ''}${w.leaps ? `, ${w.leaps === 1 ? 'a jump across a gap' : `${w.leaps} jumps across gaps`}` : ''}), not a step`
        : 'not a step from this floor (walk_to finds out whether a way gets there)';
    bits.push(`ON ANOTHER FLOOR, ${Math.abs(o.otherFloor)} m ${o.otherFloor > 0 ? 'up' : 'down'}: no melee from here; ${way}; a bolt or arrow only through an opening`);
  }
  if (o.attackingYou) bits.push(`ATTACKING YOU (${o.attackingYou}× in 10 s)`);
  else {
    if (o.castingAtYou) bits.push(`CASTING AT YOU from ${o.dist.toFixed(1)} m (${o.castingAtYou})`);
    if (o.comingAtYou) bits.push(o.comingAtYouStuck ? `AIMED AT YOU BUT NOT REACHING YOU (${o.comingAtYou})` : `COMING AT YOU (${o.comingAtYou})`);
  }
  if (o.seen) bits.push(`seen: ${o.seen}`);
  if (o.lineOfFireBlockedAt !== undefined) bits.push(`no line of fire: blocked ${o.lineOfFireBlockedAt.toFixed(1)} m along it${o.lineOfFireBlocker ? ` by ${o.lineOfFireBlocker}` : ''} (${o.lineOfFireArc ? 'your arrow\'s arc would hit that' : 'a bolt or arrow would hit that'})`);
  if (o.seenAgo !== undefined) bits.push(`last seen ${seenAgoText(o.seenAgo)} ago`);
  return bits.join('  ');
}

/** Chat lines, with a run of identical lines collapsed to one "(×N)". */
export function formatChat(lines: AgentChatLine[]): string {
  const out: string[] = [];
  let prev = '';
  let n = 0;
  const flush = (): void => { if (n) out.push(`${prev}${n > 1 ? ` (×${n})` : ''}`); };
  for (const l of lines) {
    const s = `  (${l.kind}) ${l.text}`;
    if (s === prev) { n++; continue; }
    flush();
    prev = s;
    n = 1;
  }
  flush();
  return out.join('\n');
}

/** A buff with this little left (s) is running low: said apart on the observe, and in a buff-expired event. */
export const BUFF_LOW_S = 120;

/** "1m10s", "45s", "permanent" (negative). */
export function buffTimeText(s: number): string {
  return s < 0 ? 'permanent' : s >= 60 ? `${Math.floor(s / 60)}m${Math.floor(s % 60) ? `${Math.floor(s % 60)}s` : ''}` : `${Math.max(0, Math.floor(s))}s`;
}

/** A buff that landed on you (new, or refreshed) this recently (s) is listed first, newest first, said "just landed". */
export const BUFF_NEW_S = 120;

/** "77m" from half an hour up (a long buff's seconds are noise in a list read every look), else buffTimeText's "11m41s". */
function buffListTime(s: number): string {
  return s >= 1800 ? `${Math.floor(s / 60)}m` : buffTimeText(s);
}

/**
 * A buff name's family wording and the part that differs: "Incantation of Fire Protection Other" → ["Incantation of …
 * Other", "Fire Protection"], "Fire Protection Other V" → ["… Other V", "Fire Protection"]; null for a name of no such
 * shape (Heritage Bonus).
 */
function buffFamily(name: string): [string, string] | null {
  const inc = /^(Incantation of|Aura of) (.+) (Self|Other)$/.exec(name);
  if (inc) return [`${inc[1]} … ${inc[3]}`, inc[2]];
  const lv = /^(.+) (Self|Other) ([IVX]+)$/.exec(name);
  if (lv) return [`… ${lv[2]} ${lv[3]}`, lv[1]];
  return null;
}

/**
 * Buffs as a compact list: one entry per name (two casters' layers of one spell are one buff, ACE
 * EnchantmentManager.Add keeps a layer per caster), soonest to end first, and the names of one wording written once:
 * "Incantation of … Other: Armor 77m, Fire Protection 77m". Every buff is named: none folds into a count.
 */
function compactBuffs(rows: ReadonlyArray<{ name: string; remaining: number; until?: string }>, keepOrder = false): string {
  const order = (r: { remaining: number }): number => (r.remaining < 0 ? Infinity : r.remaining);
  const sorted = keepOrder ? [...rows] : [...rows].sort((a, b) => order(a) - order(b));
  const groups = new Map<string, string[]>();
  const out: Array<{ key: string | null; text: string }> = [];
  for (const r of sorted) {
    const t = r.until ?? buffListTime(r.remaining);
    const fam = r.until ? null : buffFamily(r.name);
    if (!fam) { out.push({ key: null, text: `${r.name} ${t}` }); continue; }
    const g = groups.get(fam[0]);
    if (g) { g.push(`${fam[1]} ${t}`); continue; }
    groups.set(fam[0], [`${fam[1]} ${t}`]);
    out.push({ key: fam[0], text: r.name + ' ' + t });
  }
  return out.map((o) => {
    const g = o.key !== null ? groups.get(o.key)! : null;
    return g && g.length > 1 ? `${o.key}: ${g.join(', ')};` : o.text + ',';
  }).join(' ').replace(/[;,]$/, '');
}

/**
 * "buffs (3): Strength Other II 2m10s, …": any that landed in the last BUFF_NEW_S first ("just landed 8s ago: …"),
 * then the rest soonest to expire first, each name written once and every one named (compactBuffs). Or "buffs: none (…)".
 * Lightning Protection Other III, cast on Bulwark at 07:4xZ, was 15 minutes from its end and so folded into "+6 more"
 * (a count alone), and he couldn't tell it had landed (Aerbax Haven, 2026-10-18). Later the cut hid that Arcanist's 51
 * Incantations had no Fire Protection among them, and he died to fire golems (Crystal Core, 2026-10-18 17:46Z): the
 * list names all of them now, compactly, and the observe's protections line says which are not up.
 */
export function formatBuffs(buffs: ReadonlyArray<{ name: string; remaining: number; until?: string; landedAgoS?: number }>): string {
  if (!buffs.length) return 'buffs: none (ac_spells finds buffs you know; ac_cast casts them on yourself or another player)';
  const { rows, fresh, rest } = buffRows(buffs);
  const parts: string[] = [];
  if (fresh.length) parts.push(justLandedText(fresh));
  if (rest.length) parts.push(compactBuffs(rest));
  return `buffs (${rows.length}): ${parts.join('; ')}`;
}

type BuffRow = { name: string; remaining: number; until?: string; landedAgoS?: number };

/** One row per name (the longest time left, the latest landing), split into those just landed (newest first) and the rest. */
function buffRows(buffs: ReadonlyArray<BuffRow>): { rows: BuffRow[]; fresh: BuffRow[]; rest: BuffRow[] } {
  const byName = new Map<string, BuffRow>();
  for (const b of buffs) {
    const was = byName.get(b.name);
    if (!was) { byName.set(b.name, { ...b }); continue; }
    if (b.remaining < 0 || (was.remaining >= 0 && b.remaining > was.remaining)) was.remaining = b.remaining;
    if (b.landedAgoS !== undefined && (was.landedAgoS === undefined || b.landedAgoS < was.landedAgoS)) was.landedAgoS = b.landedAgoS;
  }
  const rows = [...byName.values()];
  const isNew = (b: BuffRow): boolean => b.landedAgoS !== undefined && b.landedAgoS <= BUFF_NEW_S;
  return { rows, fresh: rows.filter(isNew).sort((a, b) => a.landedAgoS! - b.landedAgoS!), rest: rows.filter((b) => !isNew(b)) };
}

function justLandedText(fresh: BuffRow[]): string {
  const lo = fresh[0].landedAgoS!, hi = fresh[fresh.length - 1].landedAgoS!;
  return `just landed ${lo === hi ? `${buffTimeText(lo)} ago` : `${buffTimeText(lo)}–${buffTimeText(hi)} ago`}${fresh.length > 1 ? ' (newest first)' : ''}: ${compactBuffs(fresh, true)}`;
}

/** The short buff line names this many of the soonest to end (every one under BUFF_LOW_S is named on the RUNNING LOW line too). */
export const BUFF_BRIEF_SOONEST = 4;

/**
 * The buff list short, for a look soon after one that listed them all (AgentObservation.brief): how many, the
 * BUFF_BRIEF_SOONEST soonest to end by name, when the rest end, every one that just landed, and every one gone since
 * your last look. A 40-buff list on every look made a quick check slow to read (Bulwark, Aerbax Haven, 2026-10-18
 * 19:28Z report); what matters is still said: a missing protection (the protections line), what ends soon (RUNNING
 * LOW), what landed and what dropped. `ac_observe full=true` lists them all.
 */
export function formatBuffsBrief(buffs: ReadonlyArray<BuffRow>, gone?: readonly string[]): string {
  const goneText = gone?.length ? `; GONE since your last look: ${gone.join(', ')}` : '';
  if (!buffs.length) return `buffs: none${goneText}`;
  const { rows, fresh, rest } = buffRows(buffs);
  const timed = rest.filter((b) => b.remaining >= 0 && !b.until).sort((a, b) => a.remaining - b.remaining);
  const lasting = rest.filter((b) => b.remaining < 0 || b.until);
  const parts: string[] = [];
  if (fresh.length) parts.push(justLandedText(fresh));
  const soon = timed.slice(0, BUFF_BRIEF_SOONEST);
  if (soon.length) parts.push(`soonest to end: ${compactBuffs(soon, true)}`);
  const later = timed.slice(BUFF_BRIEF_SOONEST);
  if (later.length) {
    const lo = buffListTime(later[0].remaining), hi = buffListTime(later[later.length - 1].remaining);
    parts.push(`the other ${later.length} end in ${lo === hi ? lo : `${lo} to ${hi}`}`);
  }
  if (lasting.length) parts.push(`${lasting.length} with no end time (${lasting.map((b) => b.name).join(', ')})`);
  return `buffs (${rows.length}; every one: ac_observe full=true): ${parts.join('; ')}${goneText}`;
}

/**
 * The seven damage types a protection spell covers (its enchantment's StatModKey: ACE PropertyFloat ResistSlash 64 …
 * ResistElectric 70, an EnchantmentTypeFlags.Float multiplier under 1), in the names the spells use.
 */
export const PROTECTION_KEYS: ReadonlyArray<[number, string]> = [[64, 'Blade'], [65, 'Piercing'], [66, 'Bludgeoning'], [67, 'Fire'], [68, 'Cold'], [69, 'Acid'], [70, 'Lightning']];

/**
 * "protections on you (damage taken ×): Blade ×0.32, …; NOT on you: Fire" from your enchantments' stat mods. A
 * multiplier over 1 on a key is a vulnerability (a debuff) and is said so. Null when no enchantment carries stat mods
 * (an older host): no claim is made.
 */
export function protectionsLine(enchantments: ReadonlyArray<{ statModType?: number; statModKey?: number; statModValue?: number }>): string | null {
  if (!enchantments.some((e) => e.statModType !== undefined)) return null;
  const best = new Map<number, number>();
  const worst = new Map<number, number>();
  for (const e of enchantments) {
    if (!((e.statModType ?? 0) & 0x8) || e.statModKey === undefined || e.statModValue === undefined) continue;
    if (!PROTECTION_KEYS.some(([k]) => k === e.statModKey)) continue;
    if (e.statModValue < 1) best.set(e.statModKey, Math.min(best.get(e.statModKey) ?? 1, e.statModValue));
    else if (e.statModValue > 1) worst.set(e.statModKey, Math.max(worst.get(e.statModKey) ?? 1, e.statModValue));
  }
  const fmt = (v: number): string => `×${Math.round(v * 100) / 100}`;
  const vals = new Set([...best.values()].map(fmt));
  const on = PROTECTION_KEYS.filter(([k]) => best.has(k)).map(([k, n]) => `${n} ${fmt(best.get(k)!)}`);
  const off = PROTECTION_KEYS.filter(([k]) => !best.has(k)).map(([, n]) => n);
  const vuln = PROTECTION_KEYS.filter(([k]) => worst.has(k)).map(([k, n]) => `${n} ${fmt(worst.get(k)!)}`);
  // All seven at one multiplier (a full set of one level): said once, not seven times.
  const head = !off.length && vals.size === 1 ? `all seven up, ${[...vals][0]} each` : `${on.length ? on.join(', ') : 'none'}${off.length ? `; NOT on you: ${off.join(', ')}` : '; all seven up'}`;
  return `protections on you (damage of that kind taken ×): ${head}${vuln.length ? `; vulnerabilities on you: ${vuln.join(', ')}` : ''} (banes on your armour count apart)`;
}

export function formatObservation(obs: AgentObservation): string {
  const out: string[] = [];
  const me = obs.me;
  if (obs.screen !== 'world' || !me) {
    // Portal space lasts until the world has faded in at the far end (the client's LoginComplete): the place below may
    // already be the destination. Said, so it doesn't read as a second trip (Bulwark, Holtburg, 2026-10-16).
    out.push(`screen: ${obs.screen}${me ? (obs.screen === 'portal-space' ? ' (until the world has faded in where you arrive: ac_wait types=portal for the arrival)' : '') : ' (not in world)'}`);
    if (!me) return out.join('\n');
  }
  const v = (x: { cur: number; max: number }): string => `${x.cur}/${x.max}`;
  // Sections the player's last look printed in full and that are the same now (AgentApi.playerObserve): short here.
  const brief = new Set(obs.brief ?? []);
  // Stamina 0 is ACE's IsExhausted: no defense (every attack at you lands) and a crawl for a run (AgentApi's exhausted alarm).
  const exhausted = !me.dead && me.stamina.max > 0 && me.stamina.cur === 0 ? ' (EXHAUSTED: no defense, every attack lands; a crawl for a run)' : '';
  out.push(`${me.name} (L${me.level})${me.dead ? '  ** DEAD **' : ''}  HP ${v(me.health)}  ST ${v(me.stamina)}${exhausted}  MA ${v(me.mana)}  mode ${me.combatMode}`);
  out.push(`at ${me.coords ?? 'indoors'}  cell ${me.cell}  facing ${Math.round(me.heading)}° (${compassPoint(me.heading)})${me.task ? `  task: ${me.task}` : ''}`);
  if (obs.vitae) out.push(obs.vitae);
  // Coins and trade notes together (moneyLine: what a death takes, what a vendor takes as payment).
  if (me.pyreals !== undefined || me.tradeNotes || me.burden || me.xp) out.push(`${moneyLine(me.pyreals, me.tradeNotes, me.level, brief.has('money'))}${me.burden ? `  burden ${me.burden}` : ''}${me.xp ? `  unassigned xp ${me.xp.unassigned.toLocaleString('en-US')}${me.xp.unassigned >= 1000 ? ' (spend it: ac_raise)' : ''}` : ''}`);
  if (me.packSlots) out.push(packSlotsText(me.packSlots));
  for (const [i, d] of obs.dialogs.entries()) out.push(`DIALOG ${i} [${d.buttons.join(' / ')}]: ${d.text.replace(/\s+/g, ' ')}`);
  if (obs.dialogs.length) out.push('  (answer or dismiss each with ac_dialog, e.g. button=OK; a dialog stays up until you do)');
  const good = (obs.buffs ?? []).filter((b) => b.beneficial !== false);
  out.push(brief.has('buffs') ? formatBuffsBrief(good, obs.buffsGone) : `${formatBuffs(good)}${obs.buffsGone?.length ? `; GONE since your last look: ${obs.buffsGone.join(', ')}` : ''}`);
  const prot = protectionsLine(obs.buffs ?? []);
  if (prot) out.push(`  ${prot}`);
  const bad = (obs.buffs ?? []).filter((b) => b.beneficial === false);
  if (bad.length) out.push(formatBuffs(bad).replace(/^buffs/, 'debuffs'));
  if (obs.vitalsLowered) out.push(`  ${obs.vitalsLowered}`);
  const low = (obs.buffs ?? []).filter((b) => b.beneficial !== false && b.remaining >= 0 && b.remaining <= BUFF_LOW_S).sort((a, b) => a.remaining - b.remaining);
  if (low.length) out.push(`  BUFFS RUNNING LOW (${BUFF_LOW_S / 60} min or less left): ${low.map((b) => `${b.name} ${buffTimeText(b.remaining)}`).join(', ')}: recast before they end (ac_wait types=buff-expired wakes when one does)`);
  if (obs.gearSpells?.length) {
    const one = (x: NonNullable<AgentObservation['gearSpells']>[number]): string => `${x.spell} on ${x.items} item${x.items === 1 ? '' : 's'}, cast ${buffTimeText(x.castAgoS)} ago${x.leftS !== undefined ? ` (${x.leftS <= BUFF_LOW_S ? 'RUNNING LOW: ' : ''}about ${buffTimeText(x.leftS)} left by its duration)` : ''}`;
    if (brief.has('gearSpells')) {
      // Short: how many, the soonest to end, and every one running low by name.
      const byLeft = [...obs.gearSpells].sort((a, b) => (a.leftS ?? Infinity) - (b.leftS ?? Infinity));
      const named = byLeft.filter((x, i) => i === 0 || (x.leftS !== undefined && x.leftS <= BUFF_LOW_S));
      out.push(`  spells on your gear: ${obs.gearSpells.length}, as at your last look${named.length ? `; ${named.map(one).join(', ')}` : ''} (every one: ac_observe full=true)`);
    } else out.push(`  spells on your gear (no timer for them reaches you: reckoned from your casts): ${obs.gearSpells.map(one).join(', ')}`);
  }
  if (obs.buffsMissing?.length) {
    out.push(brief.has('buffsMissing')
      ? `  buffs you know that aren't up: the same ${obs.buffsMissing.length} as at your last look (every one: ac_observe full=true)`
      : `  buffs you know that aren't up: ${obs.buffsMissing.slice(0, 10).join(', ')}${obs.buffsMissing.length > 10 ? ` +${obs.buffsMissing.length - 10} more` : ''} (ac_cast; "… Other" ones go on a fellow with target=)`);
  }
  if (obs.deaths) out.push(obs.deaths);
  if (obs.corpses) out.push(obs.corpses);
  if (obs.fellowshipAlone) out.push('fellowship: only you are in it, so /f reaches no one (a fellow who logs out leaves it): recruit your partner (in sight), or quit it (ac_fellowship action=quit) if they lead one');
  if (obs.fellows?.length) out.push(`fellows: ${obs.fellows.map((f) => `${f.name} ${f.healthPct}% HP, ${f.dist !== undefined && f.bearing !== undefined ? `${Math.round(f.dist)} m ${compassPoint(f.bearing)}${f.dz !== undefined ? `, ${f.dz > 0 ? 'up' : 'down'} ${Math.abs(f.dz).toFixed(0)} m` : ''}${f.coords ? `, at ${f.coords}` : ''}${f.threats ? `, MONSTERS AT THEM: ${f.threats}` : ''}${f.stuckThreats ? `, AIMED AT THEM BUT NOT REACHING THEM: ${f.stuckThreats}` : ''}` : f.lastSeen ? `out of sight, last seen ${f.lastSeen} (walk_to ${f.name} goes there; they may have moved on)` : f.elsewhere ? `not here: ${f.elsewhere}` : f.arriving ? `not placed here yet (${f.arriving})` : 'out of sight (far away: go to them, or ask where they are)'}`).join('; ')}`);
  if (obs.gearManaOut?.length) {
    out.push(`gear out of mana (its spells are off): ${obs.gearManaOut.map((m) => `${m.name} #${m.guid.toString(16)}${m.mana ? ` (mana ${m.mana.cur}/${m.mana.max})` : ''}`).join(', ')}: ac_use_on a charged mana stone on an empty one, then ac_unequip and ac_equip it (the server turns its spells back on only on a wield with mana in it)${obs.manaStones ? `; ${obs.manaStones}` : ''}`);
  }
  if (obs.gearManaLow?.items.length) {
    const it = obs.gearManaLow.items.map((m) => `${m.name} #${m.guid.toString(16)} (${m.leftS !== undefined ? `about ${buffTimeText(m.leftS)} of mana left` : 'the server says it is low on mana: under 2 min left'}${m.mana ? `, ${m.mana.cur}/${m.mana.max} when last read` : ''})`);
    out.push(`gear running out of mana (its spells go off when it does): ${it.join(', ')}; ${obs.gearManaLow.refill}`);
  }
  if (obs.routineSupplies) out.push(`routine supplies: ${obs.routineSupplies}`);
  if (obs.gearEmpty?.slots.length) out.push(`gear: ${emptySlotsText(obs.gearEmpty.slots)}${obs.gearEmpty.packFits.length ? `; in your pack that would cover one: ${obs.gearEmpty.packFits.slice(0, 4).join(', ')}` : ''} (ac_inventory / ac_gear show every gear slot)`);
  if (obs.casterGap) out.push(`gear: ${obs.casterGap}`);
  if (obs.windows?.length) out.push(`windows open: ${obs.windows.join(', ')}  (ac_close name=… or all, when done with them)`);
  out.push(`target: ${obs.target ? formatObject(obs.target) : obs.targetLeftBehind ? `none (your last target, ${obs.targetLeftBehind}, was left behind in another place: you went through a portal or far away since; pick a new one)` : 'none'}`);
  const attackers = obs.nearby.filter((o) => o.attackingYou && o.guid !== obs.target?.guid);
  if (attackers.length) out.push(`under attack by: ${attackers.map((o) => `${o.name} #${o.guid.toString(16)} ${o.dist.toFixed(1)}m (${o.attackingYou}× in 10 s)`).join(', ')}${obs.target ? ' (not your target)' : ''}`);
  // Said plainly, with where the server last placed it (unplacedText): "hit by, but not placed: Dark Marionette"
  // left Arcanist guessing what hit him through the walls of 0x029E0112 (2026-10-18 06:14Z).
  for (const u of obs.attackersUnplaced ?? []) out.push(`hit by ${unplacedText(u)}`);
  out.push(`nearby (${obs.nearby.length}${obs.nearbyTotal > obs.nearby.length ? ` of ${obs.nearbyTotal}` : ''}, nearest first):`);
  for (const o of obs.nearby) out.push(`  ${formatObject(o)}`);
  if (obs.unseen?.length) {
    out.push(`also in range, in rooms out of sight of yours (${obs.unseen.length}; where the server last placed them, they may have moved):`);
    for (const o of obs.unseen) out.push(`  ${formatObject(o)}`);
  }
  if (obs.remembered?.length) {
    out.push('remembered, out of view (walk_to / use them by name):');
    for (const o of obs.remembered) out.push(`  ${formatObject(o)}`);
  }
  if (obs.chat.length) {
    out.push('chat/log since last look:');
    out.push(formatChat(obs.chat));
  }
  out.push(`seq ${obs.seq}`);
  return out.join('\n');
}

export function formatEvents(events: AgentEvent[]): string {
  if (!events.length) return '(no events)';
  // A wait's "now" head is the state as of the read, not an event: no seq of its own.
  return events.map((e) => (e.type === 'now' ? `  NOW: ${e.text}` : `  [${e.seq}] ${e.type}: ${e.text}`)).join('\n');
}

/**
 * The magic foci (ACE Player_Spells.FociWCIDs): one lets you cast its school with fewer components, but only
 * while it is in your own inventory (Player.HasFoci reads the top-level Inventory, not a side pack's). A focus is
 * RequiresBackpackSlot (PropertyBool 81), so at the top level it takes one of the side pack slots.
 */
export const FOCI_WCIDS: ReadonlyMap<number, string> = new Map([
  [15268, 'Creature Enchantment'], [15269, 'Item Enchantment'], [15270, 'Life Magic'], [15271, 'War Magic'], [43173, 'Void Magic'],
]);

export function formatInventory(items: AgentItem[]): string {
  if (!items.length) return '(empty)';
  // A side pack's contents are listed under it (by its guid: two Sacks are two packs), right after the pack slots,
  // and each pack says how much it holds: "inventory never lists the Sack's contents" (Arcanist, 2026-10-12).
  const key = (it: AgentItem): string => (it.inside !== undefined ? `${it.where} #${it.inside.toString(16)}` : it.where);
  const groups = new Map<string, AgentItem[]>();
  for (const it of items) {
    const g = groups.get(key(it)) ?? [];
    g.push(it);
    groups.set(key(it), g);
  }
  const packs = items.filter((it) => it.where === 'pack slots' && it.itemType !== undefined && (it.itemType & 0x200) !== 0);
  const held = (pack: AgentItem): number => items.filter((x) => x.inside === pack.guid).length;
  const order = [...groups.keys()].filter((k) => !packs.some((p) => k.endsWith(` #${p.guid.toString(16)}`)));
  const at = order.indexOf('pack slots');
  order.splice(at < 0 ? order.length : at + 1, 0, ...packs.map((p) => `${p.name} #${p.guid.toString(16)}`).filter((k) => groups.has(k)));
  // The paperdoll first: every slot, worn or EMPTY ("he doesn't even have gloves!", Jake 2026-10-14).
  const out: string[] = hasGearData(items) ? [formatGear(items, { packList: false }), ''] : [];
  for (const where of order) {
    const list = groups.get(where)!;
    out.push(`${where.replace(/ #([0-9a-f]+)$/, ' (side pack #$1)')}:`);
    for (const it of list) {
      const school = it.wcid !== undefined ? FOCI_WCIDS.get(it.wcid) : undefined;
      const extra = [
        it.slot, it.stack && it.stack > 1 ? `x${it.stack}` : '', it.type,
        it.fits && it.where !== 'equipped' ? `fits ${it.fits}` : '',
        // The public description's Value is already the whole stack's (ACE sets Value = StackUnitValue × StackSize).
        it.value ? `value ${it.value.toLocaleString('en-US')}` : '',
        it.unsellable ? 'unsellable: no vendor buys it' : '',
        itemMarks(it),
        school ? (it.where === 'pack slots' || it.where === 'main pack' ? `${school} focus: in use` : `${school} focus: NOT in use inside ${it.where}; it counts only in your own pack slots`) : '',
        packs.includes(it) ? (held(it) ? `holds ${held(it)}, listed under it` : 'empty') : '',
      ].filter(Boolean).join(', ');
      const note = gearNote(it, items);
      out.push(`  #${it.guid.toString(16)} ${it.name}${extra ? `  (${extra})` : ''}${note ? `\n      wear: ${note}` : ''}`);
    }
  }
  return out.join('\n');
}

/**
 * An item's binding and mana, as its appraisal (or the server's refusal) showed them: "attuned: can't be dropped, given
 * or traded", "bonded: kept when you die", "mana 288/1089". The Pathwarden Helm was listed as junk to drop and refused
 * three times (Arcanist, 2026-10-16).
 */
export function itemMarks(it: AgentItem): string {
  return [
    it.attuned ? "attuned: can't be dropped, given or traded" : '',
    it.bonded ? 'bonded: kept when you die' : '',
    it.manaStone ? manaStoneText(it.manaStone) : it.mana ? `mana ${it.mana.cur.toLocaleString('en-US')}/${it.mana.max.toLocaleString('en-US')}${it.mana.cur <= 0 && it.where === 'equipped' ? ' OUT: its spells are off' : ''}` : '',
  ].filter(Boolean).join(', ');
}

/** How a stone charges: ACE ManaStone.HandleActionUseOnTarget, an empty stone used on an item. */
export const MANA_STONE_CHARGING = 'charge it by using it on an item you don\'t need that holds mana (ac_use_on the stone with target= that item): it drains the item and the item is DESTROYED; a retained item refuses';

/**
 * A mana stone's charge as the inventory and gear show it: "charged: 4,496 mana (ac_use_on it with target=self fills
 * your worn items)", or "EMPTY: …" with how to charge one (ACE ManaStone: an empty stone used on an item with mana
 * drains Efficiency × that mana into itself and destroys the item; used on an empty item it answers "That item doesn't
 * have enough Mana").
 */
export function manaStoneText(st: NonNullable<AgentItem['manaStone']>): string {
  if (!st.charged) return `EMPTY mana stone: holds no mana, so it fills nothing; ${MANA_STONE_CHARGING}${st.efficiency !== undefined ? ` (it keeps ${Math.round(st.efficiency * 100)}% of the item's mana)` : ''}`;
  return `charged: ${st.mana !== undefined ? `${st.mana.toLocaleString('en-US')} mana` : 'holds mana (appraise it for how much)'}; ac_use_on it with target=self shares it among your worn items that need mana, or target= one item`;
}

/** Free item slots at or under which the packs read LOW (a loot warns first: AgentApi.PACK_SLOTS_LOW). */
export const PACK_SLOTS_LOW = 5;

/**
 * "pack slots: main pack 98/102, Sack 20/24 (8 free)", and LOW with what to do when few are left: a loot that finds
 * no slot is refused per item ("… is completely full!") whatever the burden (Bulwark at 60%, 2026-10-16).
 */
export function packSlotsText(p: AgentPackSlots): string {
  const each = p.packs.map((x) => `${x.name} ${x.used}/${x.capacity}${x.used >= x.capacity ? ' FULL' : ''}`).join(', ');
  const main = p.packs.find((x) => x.main);
  const roomy = p.packs.filter((x) => !x.main && x.used < x.capacity);
  // A full main pack beside an empty side pack: Bulwark's main pack sat at 109/102 the whole segment with his Pack
  // at 0/24 and no tool to move anything into it (stream, 2026-10-17 06:14Z report).
  const move = main && main.used >= main.capacity && roomy.length
    ? `  main pack FULL: ac_move_item moves items into your ${roomy.map((x) => x.name).join(' / ')} (filter=junk, filter=salvage or item=…)`
    : '';
  const head = `pack slots: ${each ? `${each} (${p.free} free)` : `${p.free} free in the main pack`}${move}`;
  if (p.free > PACK_SLOTS_LOW) return head;
  return `${head}  LOW: an item with no slot left is refused ("… is completely full!") whatever your burden; drop or sell some first (ac_inventory filter=junk lists what no vendor buys, filter=sell what they do)`;
}

/**
 * ac_inventory filter= kinds, by the item's ItemType bits (ACE ItemType: MeleeWeapon 0x1, Armor 0x2, Clothing 0x4,
 * Jewelry 0x8, Food 0x20, Money 0x40, Misc 0x80, MissileWeapon 0x100, Container 0x200, Useless 0x400, Gem 0x800,
 * SpellComponents 0x1000, Writable 0x2000, Key 0x4000, Caster 0x8000, PromissoryNote 0x40000, ManaStone 0x80000,
 * TinkeringMaterial 0x40000000) and, where a type covers several kinds, its name.
 */
export const INVENTORY_KINDS: Readonly<Record<string, (it: AgentItem) => boolean>> = {
  weapon: (it) => ((it.itemType ?? 0) & (0x1 | 0x100 | 0x8000)) !== 0,
  armor: (it) => ((it.itemType ?? 0) & 0x2) !== 0,
  clothing: (it) => ((it.itemType ?? 0) & 0x4) !== 0,
  jewelry: (it) => ((it.itemType ?? 0) & 0x8) !== 0,
  scroll: (it) => /^scroll of /i.test(it.name),
  book: (it) => ((it.itemType ?? 0) & 0x2000) !== 0 && !/^scroll of /i.test(it.name),
  kit: (it) => /\bkit\b/i.test(it.name),
  potion: (it) => /\b(potion|draught|elixir|tonic|philter|brew)\b/i.test(it.name),
  food: (it) => ((it.itemType ?? 0) & 0x20) !== 0 && !/\b(potion|draught|elixir|tonic|philter|brew)\b/i.test(it.name),
  salvage: (it) => ((it.itemType ?? 0) & 0x40000000) !== 0 || /^salvage(d)?\b|\bsalvage$/i.test(it.name),
  junk: (it) => isJunk(it),
  sell: (it) => isSellable(it),
  gem: (it) => ((it.itemType ?? 0) & 0x800) !== 0,
  key: (it) => ((it.itemType ?? 0) & 0x4000) !== 0,
  component: (it) => ((it.itemType ?? 0) & 0x1000) !== 0,
  pack: (it) => ((it.itemType ?? 0) & 0x200) !== 0,
  manastone: (it) => ((it.itemType ?? 0) & 0x80000) !== 0,
  money: (it) => ((it.itemType ?? 0) & (0x40 | 0x40000)) !== 0,
  worn: (it) => it.where === 'equipped',
};
/**
 * Item kinds a player keeps whatever a vendor says: money and trade notes (Money 0x40, PromissoryNote 0x40000), keys
 * and lockpicks (0x4000), gems (portal gems and quest stones are Gems: 0x800), books, notes and scrolls (Writable
 * 0x2000), packs (0x200), spell components (0x1000), mana stones (0x80000) and salvage (0x40000000).
 */
const KEEP_TYPES = 0x40 | 0x40000 | 0x4000 | 0x800 | 0x2000 | 0x200 | 0x1000 | 0x80000 | 0x40000000;

/**
 * Junk: what no vendor will buy, so it only takes a slot and burden. ACE's sale (Player_Commerce
 * VerifySellItems) refuses an item of Value < 1 ("The X has no value and cannot be sold"), and the client knows an
 * item's Value from its public description (no Value there = 0). So: in a pack (not worn), worth nothing, and not a
 * kind players keep anyway (KEEP_TYPES); plus anything the server types Useless (0x400). The Undead Arm / Leg /
 * Thighbone and Skeletal Torso a Lich drops are Misc with Value 0 (ACE weenies 22028 / 22032 / 7041 / 22047);
 * a value-0 Misc can still be a quest or crafting piece (an attuned one can't be dropped at all), so the list says so.
 */
export function isJunk(it: AgentItem): boolean {
  // Attuned: the server won't let it be dropped (or given, or traded), so it is no junk to clear out.
  if (it.where === 'equipped' || it.attuned) return false;
  const t = it.itemType ?? 0;
  if (t & 0x400) return true;
  if (!t || (t & KEEP_TYPES)) return false;
  return !(it.value && it.value > 0);
}

/**
 * Sellable: what a vendor pays for (Value ≥ 1, not money or trade notes, not a pack, not Retained: ACE refuses a
 * Retained item, ObjectDescriptionFlags 0x01000000), in a pack (worn gear is not offered). A vendor still buys only
 * its own trades' kinds (ac_vendor shows what one buys).
 */
export function isSellable(it: AgentItem): boolean {
  if (it.where === 'equipped' || !(it.value && it.value > 0) || it.unsellable) return false;
  const t = it.itemType ?? 0;
  if (t & (0x40 | 0x40000 | 0x200)) return false;
  return ((it.objectDescFlags ?? 0) & 0x01000000) === 0;
}

const KIND_ALIASES: Readonly<Record<string, string>> = {
  weapons: 'weapon', armour: 'armor', scrolls: 'scroll', kits: 'kit', 'healing kit': 'kit', potions: 'potion', comps: 'component',
  components: 'component', comp: 'component', gems: 'gem', keys: 'key', packs: 'pack', 'mana stone': 'manastone', 'mana stones': 'manastone',
  equipped: 'worn', wielded: 'worn', coins: 'money', pyreals: 'money', notes: 'money', books: 'book',
  trash: 'junk', useless: 'junk', sellable: 'sell', 'to sell': 'sell', vendor: 'sell',
};

/** What a filtered list adds about its kind. */
const KIND_NOTES: Readonly<Record<string, string>> = {
  junk: 'junk = carried, worth nothing to any vendor (ACE refuses Value 0: "has no value and cannot be sold") and not money, a key, gem, writable, pack, component, mana stone or salvage. Such an item can still be a quest or crafting piece: ac_appraise one before dropping it if unsure. Attuned items (bound to you: the server refuses dropping, giving or trading them) are left out',
  sell: 'sell = carried, not worn, a vendor pays its value (not money, trade notes, packs, Retained items or ones an appraisal or a vendor showed unsellable); each vendor buys only its own trades\' kinds: ac_vendor shows them. Most valuable first',
};

/** The items an ac_inventory filter= keeps: a kind word (INVENTORY_KINDS), else those whose name holds the text. */
export function filterInventory(items: AgentItem[], filter: string): { items: AgentItem[]; kind: string | null } {
  const f = filter.trim().toLowerCase();
  if (!f) return { items, kind: null };
  const kind = INVENTORY_KINDS[f] ? f : KIND_ALIASES[f] ?? null;
  if (kind) return { items: items.filter(INVENTORY_KINDS[kind]), kind };
  return { items: items.filter((it) => it.name.toLowerCase().includes(f)), kind: null };
}

/** ac_inventory filter=: the matching items, each with where it is (no paperdoll), or what was looked for. */
export function formatInventoryFiltered(items: AgentItem[], filter: string): string {
  const { items: hit, kind } = filterInventory(items, filter);
  const what = kind ? `${kind} items` : `items named like "${filter.trim()}"`;
  if (!hit.length) return `no ${what} in your inventory (kinds: ${Object.keys(INVENTORY_KINDS).join(', ')}; any other text matches names)${KIND_NOTES[kind ?? ''] ? `\n(${KIND_NOTES[kind!]})` : ''}`;
  // To sell: the most valuable first, each with its value per burden unit (a light, dear item is the one to keep
  // carrying to a vendor; heavy cheap ones free the most burden).
  const shown = kind === 'sell' ? [...hit].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)) : hit;
  const lines = shown.map((it) => {
    const extra = [it.where === 'equipped' ? `worn${it.slot ? `: ${it.slot}` : ''}` : `in ${it.where}${it.inside !== undefined ? ` #${it.inside.toString(16)}` : ''}`,
      it.stack && it.stack > 1 ? `x${it.stack}` : '', it.type, it.value ? `value ${it.value.toLocaleString('en-US')}` : kind === 'junk' ? 'no value' : '',
      it.unsellable ? 'unsellable: no vendor buys it' : '',
      itemMarks(it),
      it.burden ? `burden ${it.burden.toLocaleString('en-US')}` : ''].filter(Boolean).join(', ');
    return `  #${it.guid.toString(16)} ${it.name}  (${extra})`;
  });
  const total = kind === 'sell' ? `, worth ${hit.reduce((t, it) => t + (it.value ?? 0), 0).toLocaleString('en-US')} in all` : '';
  return [`${hit.length} ${what}${total}:`, ...lines, ...(KIND_NOTES[kind ?? ''] ? [`(${KIND_NOTES[kind!]})`] : [])].join('\n');
}

export function formatTrace(points: AgentTracePoint[]): string {
  if (!points.length) return '(no trace yet)';
  return points.map((p) => `  -${p.ago.toFixed(1)}s  ${p.cell}  (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, z ${p.z.toFixed(2)})  facing ${p.heading}°  ${p.mode}${p.camera ? `  camera ${p.camera[0].toFixed(2)}${p.camera[1] - p.camera[0] > 0.005 ? `–${p.camera[1].toFixed(2)}` : ''}m` : ''}${p.task ? `  [${p.task}]` : ''}`).join('\n');
}

/** The spell list, the first `max` of them, then how many more matched (a silent cut hid spells, 2026-10-16). */
export function formatSpells(spells: AgentSpell[], max = Infinity): string {
  if (!spells.length) return '(no matching spells)';
  const shown = spells.slice(0, Math.max(1, max));
  const more = spells.length - shown.length;
  // A spell your skill makes a gamble says its odds (the fizzle formula; 90% or better says nothing).
  const odds = (s: AgentSpell): string => (s.castChance !== undefined && s.castChance < 0.9
    ? `  ${s.castChance < 0.01 ? 'under 1%' : `${Math.round(s.castChance * 100)}%`} to cast (your skill ${s.schoolSkill ?? '?'} vs difficulty ${s.power ?? '?'})` : '');
  return shown.map((s) => `  ${s.id}  ${s.name}  [${s.school}${s.level ? ` L${s.level}` : ''}]${s.range ? `  range ${s.range} m` : ''}${odds(s)}`).join('\n')
    + (more > 0 ? `\n  … ${more} more match (${spells.length} in all): narrow the filter or pass max=${spells.length}` : '');
}

// ── money: coins and trade notes ──

/** ACE ItemType Money (0x40: coin stacks, WeenieType Coin) and PromissoryNote (0x40000: trade notes). */
const ITEM_MONEY = 0x40;
const ITEM_PROMISSORY_NOTE = 0x40000;

/** Trade notes carried: their worth in all (each row's Value: a stack's is its units × face value), how many, and rows with no Value known. */
export interface TradeNotes { value: number; count: number; unpriced: number }

/**
 * The trade notes in every pack and side pack (an inventory row's ItemType PromissoryNote 0x40000), counted by each
 * row's Value (PropertyInt 19), never by name. ACE keeps a stack's Value at its units × the note's face value
 * (SetStackSize; GameMessageSetStackSize carries it), so a stack of 70 Trade Note (500) is worth 35,000. Claude Bulwark
 * carried about 405,000 in notes while observe showed only his 1,781 coins, and acted broke (Jake, 2026-10-18: "do
 * they not have trade notes? why are they so broke").
 */
export function tradeNotesOf(items: readonly AgentItem[]): TradeNotes {
  const n: TradeNotes = { value: 0, count: 0, unpriced: 0 };
  for (const it of items) {
    if (((it.itemType ?? 0) & ITEM_PROMISSORY_NOTE) === 0) continue;
    n.count += it.stack ?? 1;
    if (it.value !== undefined && it.value > 0) n.value += it.value; else n.unpriced += it.stack ?? 1;
  }
  return n;
}

/** The coins in the packs (ItemType Money 0x40 rows' Value: a coin stack's Value is its count, ACE UpdateCoinValue), or null when the rows carry no type bits. */
export function coinsOf(items: readonly AgentItem[]): number | null {
  if (!items.some((it) => it.itemType !== undefined)) return null;
  return items.reduce((t, it) => t + ((((it.itemType ?? 0) & ITEM_MONEY) !== 0 && ((it.itemType ?? 0) & ITEM_PROMISSORY_NOTE) === 0) ? (it.value ?? 0) : 0), 0);
}

/**
 * "money: 1,781 in coins + 405,500 in trade notes (124 notes) = 407,281 (…)": coins and notes, and the facts that
 * matter about each, from ACE:
 * - a vendor takes only coins (Vendor.BuyItems_ValidateTransaction checks CoinValue, the sum of the Coin stacks, or
 *   the vendor's AlternateCurrency; Player.FinalizeBuyTransaction spends coin stacks), so a note pays for nothing;
 * - a vendor buys a note at its face value (Vendor.GetBuyCost: buy rate 1.0 for a PromissoryNote; 1,107 of the
 *   end-of-retail world's 1,179 vendors list PromissoryNote among the kinds they buy) and sells one at 115%
 *   (GetSellCost);
 * - above level 5 a death drops half your coins (Player_Death.GetNumCoinsDropped), but every Trade Note weenie is
 *   Bonded (PropertyInt 33 = 1), and CalculateDeathItems leaves bonded items out: notes stay with you.
 * `level` gates the death fact (level 5 and under drops no coins). `brief`: the sums alone (the facts were said at a
 * look a moment ago).
 */
export function moneyLine(coins: number | null | undefined, notes: TradeNotes | null | undefined, level?: number, brief = false): string {
  const fmt = (x: number): string => x.toLocaleString('en-US');
  const c = coins ?? null;
  const n = notes && notes.count ? notes : null;
  const coinText = c === null ? '? in coins' : `${fmt(c)} in coins`;
  const deathRisk = c !== null && c >= 1000 && (level === undefined || level > 5);
  if (!n) {
    return `money: ${coinText}, no trade notes${deathRisk && !brief ? ' (half your coins are lost if you die; trade notes, bought from most vendors, are kept on death)' : ''}`;
  }
  const unpriced = n.unpriced ? `, ${n.unpriced} of unknown value` : '';
  const total = c !== null ? ` = ${fmt(c + n.value)}${n.unpriced ? '+' : ''}` : '';
  const facts = [
    ...(deathRisk ? ['half your coins are lost if you die, notes are kept'] : ['notes are kept on death']),
    'vendors take only coins as payment: sell a note to a vendor (most buy them) for its face value in coins',
  ];
  // `brief`: the facts were said at a look a moment ago (AgentObservation.brief), the sums only now.
  return `money: ${coinText} + ${fmt(n.value)} in trade notes (${n.count} note${n.count === 1 ? '' : 's'}${unpriced})${total}${brief ? '' : ` (${facts.join('; ')})`}`;
}
