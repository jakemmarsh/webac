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
  if (o.outOfSight) bits.push('OUT OF SIGHT: only where it was last seen (it may have moved, died or gone)');
  if (o.otherFloor !== undefined) bits.push(`ON ANOTHER FLOOR, ${Math.abs(o.otherFloor)} m ${o.otherFloor > 0 ? 'up' : 'down'}: no walk or melee reaches it from this floor, and a bolt or arrow only through an opening`);
  if (o.attackingYou) bits.push(`ATTACKING YOU (${o.attackingYou}× in 10 s)`);
  else if (o.comingAtYou) bits.push(`COMING AT YOU (${o.comingAtYou})`);
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

/** "buffs (3): Strength Other II 2m10s, …" soonest to expire first, or "buffs: none (ac_spells / ac_cast to buff yourself or others)". */
export function formatBuffs(buffs: ReadonlyArray<{ name: string; remaining: number }>): string {
  if (!buffs.length) return 'buffs: none (ac_spells finds buffs you know; ac_cast casts them on yourself or another player)';
  const left = (s: number): string => (s < 0 ? 'permanent' : s >= 60 ? `${Math.floor(s / 60)}m${Math.floor(s % 60) ? `${Math.floor(s % 60)}s` : ''}` : `${Math.max(0, Math.floor(s))}s`);
  const sorted = [...buffs].sort((a, b) => (a.remaining < 0 ? Infinity : a.remaining) - (b.remaining < 0 ? Infinity : b.remaining));
  const shown = sorted.slice(0, 16).map((b) => `${b.name} ${left(b.remaining)}`);
  return `buffs (${buffs.length}): ${shown.join(', ')}${buffs.length > shown.length ? `, +${buffs.length - shown.length} more` : ''}`;
}

export function formatObservation(obs: AgentObservation): string {
  const out: string[] = [];
  const me = obs.me;
  if (obs.screen !== 'world' || !me) {
    out.push(`screen: ${obs.screen}${me ? '' : ' (not in world)'}`);
    if (!me) return out.join('\n');
  }
  const v = (x: { cur: number; max: number }): string => `${x.cur}/${x.max}`;
  out.push(`${me.name} (L${me.level})${me.dead ? '  ** DEAD **' : ''}  HP ${v(me.health)}  ST ${v(me.stamina)}  MA ${v(me.mana)}  mode ${me.combatMode}`);
  out.push(`at ${me.coords ?? 'indoors'}  cell ${me.cell}  facing ${Math.round(me.heading)}° (${compassPoint(me.heading)})${me.task ? `  task: ${me.task}` : ''}`);
  // ACE Player_Death.GetNumCoinsDropped: above level 5 a death takes half your coins (onto the corpse, or destroyed
  // outright where the server sets corpse_destroy_pyreals, ACE's default); trade notes are not coins.
  const coinRisk = me.pyreals !== undefined && me.pyreals >= 1000 && me.level > 5 ? ' (half are lost if you die; trade notes, bought from most vendors, aren\'t coins)' : '';
  if (me.pyreals !== undefined || me.burden || me.xp) out.push(`pyreals ${me.pyreals ?? '?'}${coinRisk}${me.burden ? `  burden ${me.burden}` : ''}${me.xp ? `  unassigned xp ${me.xp.unassigned.toLocaleString('en-US')}${me.xp.unassigned >= 1000 ? ' (spend it: ac_raise)' : ''}` : ''}`);
  if (me.packSlots) out.push(packSlotsText(me.packSlots));
  for (const [i, d] of obs.dialogs.entries()) out.push(`DIALOG ${i} [${d.buttons.join(' / ')}]: ${d.text.replace(/\s+/g, ' ')}`);
  if (obs.dialogs.length) out.push('  (answer or dismiss each with ac_dialog, e.g. button=OK; a dialog stays up until you do)');
  out.push(formatBuffs((obs.buffs ?? []).filter((b) => b.beneficial !== false)));
  const bad = (obs.buffs ?? []).filter((b) => b.beneficial === false);
  if (bad.length) out.push(formatBuffs(bad).replace(/^buffs/, 'debuffs'));
  if (obs.buffsMissing?.length) out.push(`  buffs you know that aren't up: ${obs.buffsMissing.slice(0, 10).join(', ')}${obs.buffsMissing.length > 10 ? ` +${obs.buffsMissing.length - 10} more` : ''} (ac_cast; "… Other" ones go on a fellow with target=)`);
  if (obs.deaths) out.push(obs.deaths);
  if (obs.fellowshipAlone) out.push('fellowship: only you are in it, so /f reaches no one (a fellow who logs out leaves it): recruit your partner (in sight), or quit it (ac_fellowship action=quit) if they lead one');
  if (obs.fellows?.length) out.push(`fellows: ${obs.fellows.map((f) => `${f.name} ${f.healthPct}% HP, ${f.dist !== undefined && f.bearing !== undefined ? `${Math.round(f.dist)} m ${compassPoint(f.bearing)}${f.dz !== undefined ? `, ${f.dz > 0 ? 'up' : 'down'} ${Math.abs(f.dz).toFixed(0)} m` : ''}${f.threats ? `, MONSTERS AT THEM: ${f.threats}` : ''}` : f.lastSeen ? `out of sight, last seen ${f.lastSeen} (walk_to ${f.name} goes there; they may have moved on)` : 'out of sight (far away: go to them, or ask where they are)'}`).join('; ')}`);
  if (obs.gearEmpty?.slots.length) out.push(`gear: ${emptySlotsText(obs.gearEmpty.slots)}${obs.gearEmpty.packFits.length ? `; in your pack that would cover one: ${obs.gearEmpty.packFits.slice(0, 4).join(', ')}` : ''} (ac_inventory / ac_gear show every gear slot)`);
  if (obs.windows?.length) out.push(`windows open: ${obs.windows.join(', ')}  (ac_close name=… or all, when done with them)`);
  out.push(`target: ${obs.target ? formatObject(obs.target) : obs.targetLeftBehind ? `none (your last target, ${obs.targetLeftBehind}, was left behind in another place: you went through a portal or far away since; pick a new one)` : 'none'}`);
  const attackers = obs.nearby.filter((o) => o.attackingYou && o.guid !== obs.target?.guid);
  if (attackers.length) out.push(`under attack by: ${attackers.map((o) => `${o.name} #${o.guid.toString(16)} ${o.dist.toFixed(1)}m (${o.attackingYou}× in 10 s)`).join(', ')}${obs.target ? ' (not your target)' : ''}`);
  if (obs.attackersUnplaced?.length) out.push(`hit by, but not placed: ${obs.attackersUnplaced.map((u) => `${u.name} (${u.count}× in 10 s)`).join(', ')} (none of that name in sight within reach: a monster in a cell yours can't see is not shown to you, yet its melee reaches through a wall or shut door (the server checks distance only); step away from the wall, or into its room)`);
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
  return events.map((e) => `  [${e.seq}] ${e.type}: ${e.text}`).join('\n');
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
        school ? (it.where === 'pack slots' || it.where === 'main pack' ? `${school} focus: in use` : `${school} focus: NOT in use inside ${it.where}; it counts only in your own pack slots`) : '',
        packs.includes(it) ? (held(it) ? `holds ${held(it)}, listed under it` : 'empty') : '',
      ].filter(Boolean).join(', ');
      const note = gearNote(it, items);
      out.push(`  #${it.guid.toString(16)} ${it.name}${extra ? `  (${extra})` : ''}${note ? `\n      wear: ${note}` : ''}`);
    }
  }
  return out.join('\n');
}

/** Free item slots at or under which the packs read LOW (a loot warns first: AgentApi.PACK_SLOTS_LOW). */
export const PACK_SLOTS_LOW = 5;

/**
 * "pack slots: main pack 98/102, Sack 20/24 (8 free)", and LOW with what to do when few are left: a loot that finds
 * no slot is refused per item ("… is completely full!") whatever the burden (Bulwark at 60%, 2026-10-16).
 */
export function packSlotsText(p: AgentPackSlots): string {
  const each = p.packs.map((x) => `${x.name} ${x.used}/${x.capacity}${x.used >= x.capacity ? ' FULL' : ''}`).join(', ');
  const head = `pack slots: ${each ? `${each} (${p.free} free)` : `${p.free} free in the main pack`}`;
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
  if (it.where === 'equipped') return false;
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
  junk: 'junk = carried, worth nothing to any vendor (ACE refuses Value 0: "has no value and cannot be sold") and not money, a key, gem, writable, pack, component, mana stone or salvage. Such an item can still be a quest or crafting piece: ac_appraise one before dropping it if unsure (an attuned one cannot be dropped)',
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
  return shown.map((s) => `  ${s.id}  ${s.name}  [${s.school}${s.level ? ` L${s.level}` : ''}]${s.range ? `  range ${s.range} m` : ''}`).join('\n')
    + (more > 0 ? `\n  … ${more} more match (${spells.length} in all): narrow the filter or pass max=${spells.length}` : '');
}
