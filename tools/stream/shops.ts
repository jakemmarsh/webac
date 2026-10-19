/**
 * `./world-query sells "<item>"`: which shops sell an item, for how much, and where. A real player asks around or
 * reads a wiki; stream players had nothing (2026-10-15: Claude Arcanist trained Item Enchantment, tried the Holtburg
 * healer and an Archmage for Impenetrability scrolls, gave up, and never learned one, while Holtburg's Journeyman
 * Scrivener of Item Magic sells them).
 *
 * The SQL runs in world-query.ts (read-only, like every query there); everything here is pure: the two reads
 * (shopOfferSql, shopVendorSql), their tab-separated rows → offers / vendors (parseShopRows), and the text
 * (formatShops).
 *
 * Sources (ACE): a vendor's stock = its create list with DestinationType.Shop (4) exactly (Vendor.LoadInventory);
 * the price a player pays = Vendor.GetSellCost: max(1, ceil(SellPrice (PropertyFloat 38) × Value (PropertyInt 19)
 * − 0.1)), at 1.15 for a PromissoryNote (ItemType 0x40000), in AlternateCurrency (PropertyDataId 57) when the vendor
 * has one; a scroll's spell = PropertyDataId 28; reading it (Scroll.ActOnUse → Player.CanReadScroll): a spell of power
 * under 50 or 300 and up anyone learns, else the school trained and its current skill ≥ power − 50.
 * Map coordinates: the retail map readout (renderer ui/MapMarkers.ts, the same text the agent's observe prints);
 * building interiors and dungeons are framed in their landblock like the outdoors, so the formula is the same.
 */
import { CELL_LENGTH, mapCoordinateText, mapCoordsOfCell, type MapCoords } from '../../packages/renderer/src/ui/MapMarkers.ts';
import { escapeSqlLike } from './lore.ts';

export const SHOP_DESTINATION = 4;
const PROMISSORY_NOTE = 0x40000;
const SCROLL_MARGIN = 50;
export const SHOPS_MAX_LINES = 25;

export interface ShopOffer {
  vendor: number;
  item: number;
  name: string;
  value?: number;
  itemType?: number;
  spell?: number;
}

export interface ShopPlace { cell: number; x: number; y: number; viaGenerator: boolean }

export interface ShopVendor {
  wcid: number;
  name: string;
  sellRate?: number;
  currency?: string;
  places: ShopPlace[];
}

/** What the DAT says about a scroll's spell (SpellTable power and school) and a cell (EnvCell flags). */
export interface ShopDatInfo {
  spell?: (id: number) => { power: number; school: number } | undefined;
  /** EnvCell flags for an interior cell id (0x01 SeenOutside), undefined when unknown. */
  envCellFlags?: (cell: number) => number | undefined;
}

const SCHOOL_NAME: Record<number, string> = { 1: 'War Magic', 2: 'Life Magic', 3: 'Item Enchantment', 4: 'Creature Enchantment', 5: 'Void Magic' };

/** Every shop offer (vendor, item) whose item name contains `query`, with the item's value, type and spell. */
export function shopOfferSql(query: string): string {
  const intProp = (t: number) => `(SELECT value FROM weenie_properties_int x WHERE x.object_Id = c.weenie_Class_Id AND x.type = ${t} LIMIT 1)`;
  return `SELECT DISTINCT c.object_Id, c.weenie_Class_Id, s.value, ${intProp(19)}, ${intProp(1)}, `
    + `(SELECT value FROM weenie_properties_d_i_d x WHERE x.object_Id = c.weenie_Class_Id AND x.type = 28 LIMIT 1) `
    + `FROM weenie_properties_create_list c JOIN weenie_properties_string s ON s.object_Id = c.weenie_Class_Id AND s.type = 1 `
    + `WHERE c.destination_Type = ${SHOP_DESTINATION} AND LOWER(s.value) LIKE LOWER('%${escapeSqlLike(query.trim())}%') LIMIT 5000`;
}

/** The tagged rows for `vendors`: name + sell rate + currency ('v'), placements ('p'), placements of a generator that makes it ('g'). */
export function shopVendorSql(vendors: number[]): string[] {
  const ids = [...new Set(vendors.map((n) => Math.trunc(n)).filter((n) => Number.isFinite(n) && n > 0))].join(',') || '0';
  return [
    `SELECT 'v', w.class_Id, COALESCE(s.value, w.class_Name), (SELECT value FROM weenie_properties_float f WHERE f.object_Id = w.class_Id AND f.type = 38 LIMIT 1), `
      + `(SELECT COALESCE(cs.value, CONCAT('wcid ', d.value)) FROM weenie_properties_d_i_d d LEFT JOIN weenie_properties_string cs ON cs.object_Id = d.value AND cs.type = 1 WHERE d.object_Id = w.class_Id AND d.type = 57 LIMIT 1) `
      + `FROM weenie w LEFT JOIN weenie_properties_string s ON s.object_Id = w.class_Id AND s.type = 1 WHERE w.class_Id IN (${ids})`,
    `SELECT 'p', weenie_Class_Id, obj_Cell_Id, origin_X, origin_Y FROM landblock_instance WHERE weenie_Class_Id IN (${ids})`,
    `SELECT DISTINCT 'g', g.weenie_Class_Id, li.obj_Cell_Id, li.origin_X, li.origin_Y FROM weenie_properties_generator g JOIN landblock_instance li ON li.weenie_Class_Id = g.object_Id WHERE g.weenie_Class_Id IN (${ids})`,
  ];
}

const num = (x: string | undefined) => (x === undefined || x === '' || x === 'NULL' ? undefined : Number(x));

/** `mysql -N --batch` rows of shopOfferSql → offers (one per vendor + item). */
export function parseShopOffers(tsv: string): ShopOffer[] {
  const seen = new Set<string>();
  const out: ShopOffer[] = [];
  for (const line of tsv.split('\n')) {
    if (!line.trim()) continue;
    const [v, i, name = '', value, itemType, spell] = line.split('\t');
    const vendor = Number(v), item = Number(i);
    if (!Number.isFinite(vendor) || !Number.isFinite(item) || seen.has(`${vendor}:${item}`)) continue;
    seen.add(`${vendor}:${item}`);
    const o: ShopOffer = { vendor, item, name: name.trim() };
    const val = num(value), t = num(itemType), sp = num(spell);
    if (val !== undefined) o.value = val;
    if (t !== undefined) o.itemType = t;
    if (sp) o.spell = sp;
    out.push(o);
  }
  return out;
}

/** Rows of shopVendorSql → vendors by wcid. */
export function parseShopVendors(tsv: string): Map<number, ShopVendor> {
  const by = new Map<number, ShopVendor>();
  const get = (wcid: number) => {
    let v = by.get(wcid);
    if (!v) { v = { wcid, name: '', places: [] }; by.set(wcid, v); }
    return v;
  };
  for (const line of tsv.split('\n')) {
    if (!line.trim()) continue;
    const [tag, idS, a = '', b, c] = line.split('\t');
    const wcid = Number(idS);
    if (!Number.isFinite(wcid)) continue;
    const v = get(wcid);
    if (tag === 'v') {
      v.name = a.trim();
      const rate = num(b);
      if (rate !== undefined) v.sellRate = rate;
      if (c && c !== 'NULL') v.currency = c.trim();
    } else if (tag === 'p' || tag === 'g') {
      const cell = aceCellOf(Number(a), Number(b), Number(c));
      if (!v.places.some((p) => p.cell === cell && p.x === Number(b) && p.y === Number(c))) v.places.push({ cell, x: Number(b), y: Number(c), viaGenerator: tag === 'g' });
    }
  }
  return by;
}

/** Vendor.GetSellCost: what the player pays. */
export function shopPrice(value: number | undefined, sellRate: number | undefined, itemType?: number): number {
  const rate = itemType !== undefined && (itemType & PROMISSORY_NOTE) !== 0 ? 1.15 : (sellRate ?? 1);
  return Math.max(1, Math.ceil(Math.fround(rate) * (value ?? 0) - 0.1));
}

/**
 * The cell ACE puts an object in when the DB gives only its landblock: an outdoor `obj_Cell_Id` of XXYY0000 (40,069 of
 * the end-of-retail world's 365,184 landblock_instance rows, among them the Mountain Keep portal, wcid 1364, at
 * 0xA8C30000 105.357 154.166). ACE's Position(blockCellID, x, y, z, …) calls SetPosition when `blockCellID & 0xFFFF` is
 * 0, and SetLandCell takes the outdoor cell under the origin: cellX × 8 + cellY + 1, cellX / cellY = origin / 24
 * (ACE.Entity/Position.cs). So 0xA8C30000 at (105.4, 154.2) is 0xA8C30027. Any other id (an outdoor or interior cell,
 * or 0: no place) is returned as it is.
 */
export function aceCellOf(cell: number, x: number, y: number): number {
  const c = cell >>> 0;
  if ((c & 0xffff) !== 0 || c < 0x10000 || !Number.isFinite(x) || !Number.isFinite(y)) return c;
  const cx = Math.min(7, Math.max(0, Math.floor(x / CELL_LENGTH)));
  const cy = Math.min(7, Math.max(0, Math.floor(y / CELL_LENGTH)));
  return ((c & 0xffff0000) | (cx * 8 + cy + 1)) >>> 0;
}

/** A placement → the retail map readout's coordinates (the agent's own "42.1N, 33.6E"), from its landblock + origin. */
export function placeMapCoords(cell: number, x: number, y: number): MapCoords {
  const gx = ((cell >>> 24) & 0xff) * 192 + x;
  const gy = ((cell >>> 16) & 0xff) * 192 + y;
  return mapCoordsOfCell(Math.floor(gx / CELL_LENGTH), Math.floor(gy / CELL_LENGTH));
}

export { MAP_TOWNS, nearestTownOf } from '../../packages/renderer/src/agent/towns.ts';
import { nearestTownOf } from '../../packages/renderer/src/agent/towns.ts';

export function nearestTown(c: MapCoords): string | undefined {
  return nearestTownOf(c)?.text;
}

const SEEN_OUTSIDE = 0x1;

/** One placement as text: "42.0N, 33.5E (Holtburg)", "… inside a building", "… underground (a dungeon or cellar)". */
export function formatPlace(p: ShopPlace, dat: ShopDatInfo = {}): string {
  const coords = placeMapCoords(p.cell, p.x, p.y);
  const parts = [mapCoordinateText(coords)];
  if ((p.cell & 0xffff) >= 0x100) {
    const flags = dat.envCellFlags?.(p.cell);
    parts.push(flags === undefined ? 'indoors' : flags & SEEN_OUTSIDE ? 'inside a building' : 'underground (a dungeon or cellar)');
  }
  const town = nearestTown(coords);
  return `${parts.join(' ')}${town ? ` (${town})` : ''}${p.viaGenerator ? ', spawned there' : ''}`;
}

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8 };

/** By name, with spell tiers ("… II" < "… X") in order. */
export function compareItemNames(a: string, b: string): number {
  const ra = /^(.*) (I|II|III|IV|V|VI|VII|VIII)$/.exec(a), rb = /^(.*) (I|II|III|IV|V|VI|VII|VIII)$/.exec(b);
  if (ra && rb && ra[1] === rb[1]) return ROMAN[ra[2]] - ROMAN[rb[2]];
  return a.localeCompare(b);
}

const tierOf = (name: string) => /^(.*) (I|II|III|IV|V|VI|VII|VIII)$/.exec(name);

/** Names in order with a spell family's later tiers cut to the numeral: "Scroll of Impenetrability III, IV". */
export function shortNames(names: string[]): string[] {
  let base = '';
  return names.map((n) => {
    const m = tierOf(n);
    const b = m ? m[1] : n;
    const out = base === b && m ? m[2] : n;
    base = b;
    return out;
  });
}

/** Who can learn a scroll's spell (Player.CanReadScroll), or undefined when the item teaches none / its spell is unknown. */
export function learnRule(o: ShopOffer, dat: ShopDatInfo): { anyone: true } | { school: string; min: number } | undefined {
  if (!o.spell) return undefined;
  const s = dat.spell?.(o.spell);
  if (!s) return undefined;
  if (s.power < SCROLL_MARGIN || s.power >= 300) return { anyone: true };
  return { school: SCHOOL_NAME[s.school] ?? 'its school', min: s.power - SCROLL_MARGIN };
}

/** "anyone", "Item Enchantment trained", "Item Enchantment trained, skill 100+"; the school said once while it repeats. */
function learnText(rules: NonNullable<ReturnType<typeof learnRule>>[]): string[] {
  let last = '';
  return rules.map((r) => {
    if ('anyone' in r) return 'anyone';
    const school = r.school === last ? '' : `${r.school} trained`;
    last = r.school;
    return [school, r.min > 0 ? `skill ${r.min}+` : ''].filter(Boolean).join(', ');
  });
}

const PLACES_PER_LINE = 3;

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** Distance between two map spots, in map units (0.1 = 24 m). */
export const mapDist = (a: MapCoords, b: MapCoords): number => Math.hypot(a.ns - b.ns, a.ew - b.ew);
/** "2.3 SW of you" in map units (0.1 = 24 m), from `from` to `to`; "here" under 0.05. */
export function fromYouText(from: MapCoords, to: MapCoords): string {
  const dn = to.ns - from.ns, de = to.ew - from.ew;
  const d = Math.hypot(dn, de);
  if (d < 0.05) return 'here';
  return `${d.toFixed(1)} ${COMPASS[Math.round(((Math.atan2(de, dn) * 180) / Math.PI + 360) / 45) % 8]} of you`;
}

/**
 * The answer, grouped by vendor + place: each kind of shop (a vendor name with the same stock and prices) once, with
 * what it sells of the match and its price, then everywhere it stands (by nearest town). Ordered by the first item
 * it sells (spell tiers in order), so a family reads lowest tier first.
 */
export function formatShops(query: string, offers: ShopOffer[], vendors: Map<number, ShopVendor>, dat: ShopDatInfo = {}, maxLines = SHOPS_MAX_LINES, near?: MapCoords): string {
  const q = query.trim();
  if (!q) return 'give part of an item name: ./world-query sells "Scroll of Impenetrability"';
  // Only vendors that stand somewhere in the world.
  const placed = offers.filter((o) => vendors.get(o.vendor)?.places.length);
  if (!placed.length) {
    return offers.length
      ? `${offers.length} shop listing${offers.length === 1 ? '' : 's'} name "${q}", but none of those vendors is placed in this world.`
      : `no shop sells anything called "${q}" (try a shorter part of the name)`;
  }
  // vendor wcid → its matching items, in name order.
  const stock = new Map<number, ShopOffer[]>();
  for (const o of placed) stock.set(o.vendor, [...(stock.get(o.vendor) ?? []), o]);
  const groups = new Map<string, { vendor: string; items: { name: string; price: string }[]; places: Map<string, string> }>();
  for (const [wcid, os] of stock) {
    const v = vendors.get(wcid)!;
    os.sort((a, b) => compareItemNames(a.name, b.name));
    const items = os.map((o) => ({ name: o.name, price: `${shopPrice(o.value, v.sellRate, o.itemType).toLocaleString('en-US')}` }));
    const currency = v.currency ?? 'pyreals';
    const key = `${v.name}|${currency}|${items.map((i) => `${i.name}=${i.price}`).join(',')}`;
    const g = groups.get(key) ?? { vendor: `${v.name}${v.currency ? ` (prices in ${v.currency})` : ''}`, items, places: new Map() };
    for (const p of v.places) {
      // Sort key: the town's name, then nearest first; places far from any town last. With `near`: nearest to it first,
      // with how far (spawns' near). Arcanist's `sells "…" near 54.7N 32.9E` listed by town, the near ignored (2026-10-19).
      const at = placeMapCoords(p.cell, p.x, p.y);
      const town = nearestTownOf(at);
      const text = `${formatPlace(p, dat)}${near ? `, ${fromYouText(near, at)}` : ''}`;
      g.places.set(text, near ? `${mapDist(near, at).toFixed(2).padStart(8, '0')}\t${text}` : `${town ? `${town.name}\t${town.distance.toFixed(1).padStart(5, '0')}` : '\uffff'}\t${text}`);
    }
    groups.set(key, g);
  }
  const placeList = (g: { places: Map<string, string> }) => [...g.places.values()].sort((a, b) => a.localeCompare(b));
  const sorted = [...groups.values()].sort((a, b) => (near ? placeList(a)[0].localeCompare(placeList(b)[0]) : 0) || compareItemNames(a.items[0].name, b.items[0].name) || a.items.length - b.items.length
    || placeList(a)[0].localeCompare(placeList(b)[0]) || a.vendor.localeCompare(b.vendor));
  const itemNames = [...new Set(placed.map((o) => o.name))].sort(compareItemNames);
  const shopCount = sorted.reduce((n, g) => n + g.places.size, 0);
  const lines = [`${shopCount} shop${shopCount === 1 ? '' : 's'} sell ${itemNames.length} item${itemNames.length === 1 ? '' : 's'} matching "${q}"${near ? `, nearest to ${mapCoordinateText(near)} first` : ''}; prices are what you pay${placed.some((o) => o.spell) ? '; use a scroll to learn its spell' : ''}.`];
  // Who can learn each scroll, once.
  const rules = itemNames.map((n) => ({ n, r: learnRule(placed.find((o) => o.name === n)!, dat) })).filter((x): x is { n: string; r: NonNullable<typeof x.r> } => !!x.r);
  if (rules.length) {
    const short = shortNames(rules.map((x) => x.n));
    const text = learnText(rules.map((x) => x.r));
    lines.push(`To learn: ${rules.map((_, i) => `${short[i]}: ${text[i]}`).join('; ')}.`);
  }
  let hidden = 0;
  for (const g of sorted) {
    const places = placeList(g).map((s) => s.split('\t').pop()!);
    const short = shortNames(g.items.map((i) => i.name));
    const head = `${g.vendor}: ${g.items.map((it, i) => `${short[i]} ${it.price}`).join(', ')}${g.vendor.includes('(prices in') ? '' : ' pyreals'}, at`;
    // One place: one line.
    if (places.length === 1) {
      if (lines.length + 1 > maxLines) { hidden++; continue; }
      lines.push(`${head} ${places[0]}`);
      continue;
    }
    const placeLines: string[] = [];
    for (let i = 0; i < places.length; i += PLACES_PER_LINE) placeLines.push(`  ${places.slice(i, i + PLACES_PER_LINE).join('; ')}`);
    if (lines.length + 1 + Math.min(placeLines.length, 1) > maxLines) { hidden += places.length; continue; }
    lines.push(`${head}:`);
    const room = Math.max(1, maxLines - lines.length);
    const shown = placeLines.slice(0, room);
    lines.push(...shown);
    if (shown.length < placeLines.length) {
      const left = places.length - shown.length * PLACES_PER_LINE;
      hidden += left;
      lines[lines.length - 1] += ` (+${left} more)`;
    }
  }
  if (hidden) lines.push(`… ${hidden} more shop${hidden === 1 ? '' : 's'} not shown; give more of the name (e.g. "${itemNames[itemNames.length - 1]}")${near ? '' : ', or add "near <your coords>" for the nearest first'}.`);
  return lines.join('\n');
}

// ── the scrolls that teach given spells, for the readiness block ──

/** Every shop offer whose item teaches one of `spellIds` (a scroll's spell, PropertyDataId 28); the columns of shopOfferSql. */
export function shopScrollOfferSql(spellIds: readonly number[]): string {
  const ids = [...new Set(spellIds.map((n) => Math.trunc(n)).filter((n) => Number.isFinite(n) && n > 0))].join(',') || '0';
  const intProp = (t: number) => `(SELECT value FROM weenie_properties_int x WHERE x.object_Id = c.weenie_Class_Id AND x.type = ${t} LIMIT 1)`;
  return `SELECT DISTINCT c.object_Id, c.weenie_Class_Id, s.value, ${intProp(19)}, ${intProp(1)}, d.value `
    + `FROM weenie_properties_create_list c JOIN weenie_properties_d_i_d d ON d.object_Id = c.weenie_Class_Id AND d.type = 28 `
    + `JOIN weenie_properties_string s ON s.object_Id = c.weenie_Class_Id AND s.type = 1 `
    + `WHERE c.destination_Type = ${SHOP_DESTINATION} AND d.value IN (${ids}) LIMIT 5000`;
}

/** A spell family's Self levels to buy, highest first (spellGaps.ts SelfBuffGap.upgrades), with the family's name. */
export interface ScrollWant { display: string; upgrades: ReadonlyArray<{ level: number; name: string; ids: readonly number[] }> }

/** How many Self levels per family the scroll line names: the highest sold and the next one sold below it. */
export const SCROLL_LEVELS_SHOWN = 2;
const ROMAN_OF = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * "- Self V scrolls: Scroll of Self Strength V and Scroll of Quickness Self V, 10,000 pyreals each, from Master Scrivener
 * of Creature Magic at 8.0S, 73.1E (Dryreach), the nearest, 12.3 SE of you": for each family the highest level it
 * wants that a placed vendor sells and the next one sold below it, each from the seller nearest `near` (map coordinates; without them the vendor with the
 * most places and three of its towns). The scrolls and prices are the world DB's (Vendor.GetSellCost); a family no
 * shop sells at any of its levels is said so.
 */
export function scrollSellerLines(wants: readonly ScrollWant[], offers: readonly ShopOffer[], vendors: Map<number, ShopVendor>, near?: MapCoords | null, dat: ShopDatInfo = {}): string[] {
  const dist = (a: MapCoords, b: MapCoords) => Math.hypot(a.ns - b.ns, a.ew - b.ew);
  type Pick = { level: number; scroll: string; price: number; vendor: string; currency?: string; where: string; key: string; from?: string };
  const pickOf = (u: ScrollWant['upgrades'][number]): Pick | null => {
    const os = offers.filter((o) => o.spell !== undefined && u.ids.includes(o.spell) && vendors.get(o.vendor)?.places.length);
    if (!os.length) return null;
    if (near) {
      let best: { o: ShopOffer; p: ShopPlace; d: number } | null = null;
      for (const o of os) for (const p of vendors.get(o.vendor)!.places) {
        const d = dist(near, placeMapCoords(p.cell, p.x, p.y));
        if (!best || d < best.d) best = { o, p, d };
      }
      const { o, p, d } = best!;
      const v = vendors.get(o.vendor)!;
      const at = placeMapCoords(p.cell, p.x, p.y);
      const from = d < 0.05 ? 'here' : `${d.toFixed(1)} ${COMPASS_8[Math.round(((Math.atan2(at.ew - near.ew, at.ns - near.ns) * 180) / Math.PI + 360) / 45) % 8]} of you`;
      const where = formatPlace({ ...p, viaGenerator: false }, dat);
      return { level: u.level, scroll: o.name, price: shopPrice(o.value, v.sellRate, o.itemType), vendor: v.name, currency: v.currency, where, key: `${v.name}|${where}`, from };
    }
    const o = [...os].sort((a, b) => vendors.get(b.vendor)!.places.length - vendors.get(a.vendor)!.places.length)[0];
    const v = vendors.get(o.vendor)!;
    const towns = [...new Set(v.places.map((p) => nearestTown(placeMapCoords(p.cell, p.x, p.y))).filter((t): t is string => !!t))].sort();
    const where = towns.length ? `${towns.slice(0, 3).join(', ')}${towns.length > 3 ? ` and ${towns.length - 3} more towns` : ''}` : formatPlace({ ...v.places[0], viaGenerator: false }, dat);
    return { level: u.level, scroll: o.name, price: shopPrice(o.value, v.sellRate, o.itemType), vendor: v.name, currency: v.currency, where, key: `${v.name}|${where}` };
  };
  // Each family's highest level a shop sells and the next one sold below it (a cheaper step, often nearer).
  const picks: Array<{ want: ScrollWant; picks: Pick[] }> = wants.map((w) => {
    const got: Pick[] = [];
    for (const u of w.upgrades) {
      const p = pickOf(u);
      if (p) got.push(p);
      if (got.length === SCROLL_LEVELS_SHOWN) break;
    }
    return { want: w, picks: got };
  });
  const lines: string[] = [];
  const byLevel = new Map<number, Map<string, Pick[]>>();
  for (const pick of picks.flatMap((x) => x.picks)) {
    const m = byLevel.get(pick.level) ?? new Map<string, Pick[]>();
    m.set(pick.key, [...(m.get(pick.key) ?? []), pick]);
    byLevel.set(pick.level, m);
  }
  for (const [level, groups] of [...byLevel].sort((a, b) => b[0] - a[0])) {
    const parts = [...groups.values()].map((ps) => {
      const p = ps[0];
      const cur = p.currency ?? 'pyreals';
      const same = ps.every((x) => x.price === p.price);
      const names = ps.map((x) => x.scroll);
      const list = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      const price = same ? `${p.price.toLocaleString('en-US')} ${cur}${ps.length > 1 ? ' each' : ''}` : ps.map((x) => `${x.scroll} ${x.price.toLocaleString('en-US')}`).join(', ') + ` ${cur}`;
      return `${list}, ${price}, from ${p.vendor} at ${p.where}${p.from ? `, the nearest, ${p.from}` : ''}`;
    });
    lines.push(`- Self ${ROMAN_OF[level]} scrolls: ${parts.join('; ')}`);
  }
  const unsold = picks.filter((x) => !x.picks.length).map((x) => x.want.display);
  if (unsold.length) lines.push(`- no shop in this world sells a higher Self scroll of ${unsold.length <= 1 ? unsold.join('') : `${unsold.slice(0, -1).join(', ')} or ${unsold[unsold.length - 1]}`}`);
  return lines;
}
