/**
 * `./world-query spawns "<monster>"`: where a creature is placed or generated. Bulwark joined landblock_instance with
 * weenie_properties_generator for the landblocks round 0xA3AD and found nothing, though monsters spawn there all day
 * (2026-10-16): the outdoors is mostly filled by landscape encounters, and a generator is often picked by another one.
 *
 * How ACE spawns a creature (the sources this follows):
 * - placed directly: a `landblock_instance` row with the creature's wcid (Landblock.CreateWorldObjects);
 * - by a generator: a weenie whose `weenie_properties_generator` profiles name the creature; the generator itself is a
 *   `landblock_instance` row, or is picked by another generator's profile (a chain: "… Mix Generator" → "… Camp
 *   Generator" → the creature);
 * - landscape encounters: the `encounter` table (landblock, cell_X, cell_Y → a generator wcid), spawned at
 *   (cell_X × 24, cell_Y × 24) of that landblock when it loads, skipped on a cell with a building (Landblock.SpawnEncounters).
 * A generator's profiles are rolled in id order with cumulative probabilities; a profile's share is its probability less
 * the one before (reset when it drops), −1 = always (WorldObject_Generators GetAdjustedProbability / GetTotalProbability).
 * A profile with its own obj_Cell_Id puts the creature at that spot rather than round the generator.
 *
 * The SQL runs in world-query.ts (read-only); everything here is pure.
 */
import { isMapCoordsText, parseMapCoordsText } from '../../packages/shared/src/mapCoordsText.ts';
import { aceCellOf, formatPlace, fromYouText, mapDist, nearestTownOf, placeMapCoords, type ShopDatInfo, type ShopPlace } from './shops.ts';
import type { MapCoords } from '../../packages/renderer/src/ui/MapMarkers.ts';
import type { LorePick } from './lore.ts';

/** How many generator levels up a chain is followed. */
export const SPAWN_MAX_DEPTH = 5;
export const SPAWNS_MAX_LINES = 30;
/** How many distinct creature names one `spawns` answers for (more: give more of the name). */
export const SPAWNS_MAX_NAMES = 8;
const PLACES_SHOWN = 6;

export interface GenProfile {
  gen: number;
  id: number;
  wcid: number;
  probability: number;
  maxCreate: number;
  /** The profile's own spot (where_Create Specific), when it has one. */
  cell?: number;
  x?: number;
  y?: number;
}

export interface SpawnPlaces {
  /** wcid → its landblock_instance placements. */
  placed: Map<number, ShopPlace[]>;
  /** generator wcid → its landscape encounter spots. */
  encounters: Map<number, ShopPlace[]>;
  /** wcid → name (generators, mostly). */
  names: Map<number, string>;
}

const ids = (xs: Iterable<number>) => [...new Set([...xs].map((n) => Math.trunc(n)).filter((n) => Number.isFinite(n) && n > 0))].join(',') || '0';

/** Every profile of the generators that create any of `wcids` (their whole lists, for the shares). */
export function spawnParentSql(wcids: Iterable<number>): string {
  return `SELECT g.object_Id, g.id, g.weenie_Class_Id, g.probability, g.max_Create, g.obj_Cell_Id, g.origin_X, g.origin_Y FROM weenie_properties_generator g `
    + `WHERE g.object_Id IN (SELECT object_Id FROM weenie_properties_generator WHERE weenie_Class_Id IN (${ids(wcids)})) ORDER BY g.object_Id, g.id LIMIT 20000`;
}

/** The tagged rows for `wcids`: placements ('p'), landscape encounters ('e'), names ('n'). */
export function spawnPlaceSql(wcids: Iterable<number>): string[] {
  const list = ids(wcids);
  return [
    `SELECT 'p', weenie_Class_Id, obj_Cell_Id, origin_X, origin_Y FROM landblock_instance WHERE weenie_Class_Id IN (${list})`,
    `SELECT 'e', weenie_Class_Id, landblock, cell_X, cell_Y FROM encounter WHERE weenie_Class_Id IN (${list})`,
    `SELECT 'n', object_Id, value FROM weenie_properties_string WHERE type = 1 AND object_Id IN (${list})`,
  ];
}

const num = (x: string | undefined) => (x === undefined || x === '' || x === 'NULL' ? undefined : Number(x));

/** `mysql -N --batch` rows of spawnParentSql → profiles. */
export function parseGenProfiles(tsv: string): GenProfile[] {
  const out: GenProfile[] = [];
  for (const line of tsv.split('\n')) {
    if (!line.trim()) continue;
    const [g, id, w, p, max, cell, x, y] = line.split('\t');
    const gen = Number(g), wcid = Number(w);
    if (!Number.isFinite(gen) || !Number.isFinite(wcid)) continue;
    const prof: GenProfile = { gen, id: Number(id), wcid, probability: Number(p), maxCreate: num(max) ?? 1 };
    const c = num(cell);
    if (c) { prof.x = num(x) ?? 0; prof.y = num(y) ?? 0; prof.cell = aceCellOf(c, prof.x, prof.y); }
    out.push(prof);
  }
  return out;
}

/**
 * Rows of spawnPlaceSql → placements, encounter spots and names. An encounter's spot is ACE's: (cell_X × 24, cell_Y × 24).
 * A cell the DB stores as its landblock alone (XXYY0000) is the outdoor cell ACE puts it in (aceCellOf).
 */
export function parseSpawnPlaces(tsv: string): SpawnPlaces {
  const out: SpawnPlaces = { placed: new Map(), encounters: new Map(), names: new Map() };
  const add = (m: Map<number, ShopPlace[]>, w: number, p: ShopPlace) => {
    const l = m.get(w) ?? [];
    if (!l.some((q) => q.cell === p.cell && q.x === p.x && q.y === p.y)) l.push(p);
    m.set(w, l);
  };
  for (const line of tsv.split('\n')) {
    if (!line.trim()) continue;
    const [tag, w, a = '', b, c] = line.split('\t');
    const wcid = Number(w);
    if (!Number.isFinite(wcid)) continue;
    if (tag === 'n') out.names.set(wcid, a.trim());
    else if (tag === 'p') add(out.placed, wcid, { cell: aceCellOf(Number(a), Number(b), Number(c)), x: Number(b), y: Number(c), viaGenerator: false });
    else if (tag === 'e') {
      // Landblock.SpawnEncounters: cell XXYY0001 at the clamped spot, then adjust_to_outside() takes the cell under it.
      const clamp = (v: number) => Math.min(191.5, Math.max(0.5, v * 24));
      const x = clamp(Number(b)), y = clamp(Number(c));
      add(out.encounters, wcid, { cell: aceCellOf((Number(a) << 16) >>> 0, x, y), x, y, viaGenerator: true });
    }
  }
  return out;
}

/** "12%", "0.4%", "always". */
export function shareText(v: number | 'always'): string {
  return v === 'always' ? 'always' : `${v >= 0.1 ? Math.round(v * 100) : Math.max(0.1, Math.round(v * 1000) / 10)}%`;
}

/** Each profile's share of a roll (0..1), or 'always' for −1: cumulative probabilities in id order, as ACE rolls them. */
export function profileShares(profiles: GenProfile[]): Map<number, number | 'always'> {
  const out = new Map<number, number | 'always'>();
  let last = 0, total = 0;
  const diffs: [number, number][] = [];
  for (const p of [...profiles].sort((a, b) => a.id - b.id)) {
    if (p.probability === -1) { out.set(p.id, 'always'); continue; }
    if (last > p.probability) last = 0;
    const d = Math.max(0, p.probability - last);
    diffs.push([p.id, d]);
    total += d;
    last = p.probability;
  }
  for (const [id, d] of diffs) out.set(id, total > 0 ? d / total : 0);
  return out;
}

export interface SpawnSource {
  /** The chain, top generator first, down to the creature: names. */
  chain: string[];
  /** Each generator's share of rolls for the next link (0..1, or 'always'), parallel to chain minus the creature. */
  shares: (number | 'always')[];
  how: 'placed' | 'generator' | 'encounter';
  places: ShopPlace[];
}

/**
 * Every way `creatures` come into the world: placed, or by a generator (followed up to SPAWN_MAX_DEPTH levels) that is
 * itself placed or a landscape encounter.
 */
export function spawnSources(creatures: number[], profiles: GenProfile[], places: SpawnPlaces, nameOf: (wcid: number) => string): SpawnSource[] {
  const byGen = new Map<number, GenProfile[]>();
  for (const p of profiles) byGen.set(p.gen, [...(byGen.get(p.gen) ?? []), p]);
  const shares = new Map<number, Map<number, number | 'always'>>();
  /** A generator's share of rolls for `wcid` (its profiles for it summed): 'always', or 0..1. */
  const shareFor = (gen: number, wcid: number): number | 'always' => {
    let m = shares.get(gen);
    if (!m) { m = profileShares(byGen.get(gen) ?? []); shares.set(gen, m); }
    let sum = 0;
    for (const p of byGen.get(gen) ?? []) {
      if (p.wcid !== wcid) continue;
      const v = m.get(p.id);
      if (v === 'always') return 'always';
      sum += v ?? 0;
    }
    return sum;
  };
  const out: SpawnSource[] = [];
  // The same chain by name merges: versions of one creature (several wcids, one name) add up at the last link.
  const merge = (s: SpawnSource) => {
    const key = (o: SpawnSource) => `${o.how}|${o.chain.join('>')}|${o.shares.slice(0, -1).map(String).join('>')}`;
    const prev = out.find((o) => key(o) === key(s));
    if (!prev) { out.push(s); return; }
    const i = s.shares.length - 1;
    if (i >= 0 && prev.shares[i] !== 'always') prev.shares[i] = s.shares[i] === 'always' ? 'always' : Math.min(1, (prev.shares[i] as number) + s.shares[i]);
    for (const p of s.places) if (!prev.places.some((q) => q.cell === p.cell && q.x === p.x && q.y === p.y)) prev.places.push(p);
  };
  for (const c of creatures) {
    const direct = places.placed.get(c);
    if (direct?.length) merge({ chain: [nameOf(c)], shares: [], how: 'placed', places: [...direct] });
  }
  // Walk up: (wcid, chain below it, shares below it, the profile spots that fix where it appears).
  const walk = (wcid: number, chain: string[], sh: (number | 'always')[], spots: ShopPlace[] | undefined, seen: Set<number>, depth: number) => {
    if (depth > SPAWN_MAX_DEPTH) return;
    const parents = [...new Set(profiles.filter((p) => p.wcid === wcid && !seen.has(p.gen)).map((p) => p.gen))];
    for (const gen of parents) {
      const own = (byGen.get(gen) ?? []).filter((p) => p.wcid === wcid);
      const nChain = [nameOf(gen), ...chain], nSh = [shareFor(gen, wcid), ...sh];
      const fixed = own.filter((p) => p.cell).map((p) => ({ cell: p.cell!, x: p.x ?? 0, y: p.y ?? 0, viaGenerator: true }));
      const nSpots = spots ?? (fixed.length ? fixed : undefined);
      const placed = places.placed.get(gen);
      if (placed?.length) merge({ chain: nChain, shares: nSh, how: 'generator', places: nSpots ? [...nSpots] : placed.map((q) => ({ ...q, viaGenerator: true })) });
      const enc = places.encounters.get(gen);
      if (enc?.length) merge({ chain: nChain, shares: nSh, how: 'encounter', places: nSpots ? [...nSpots] : [...enc] });
      walk(gen, nChain, nSh, nSpots, new Set([...seen, gen]), depth + 1);
    }
  };
  for (const c of creatures) walk(c, [nameOf(c)], [], undefined, new Set(), 1);
  return out;
}

/** `spawns "<name>" near 36.7N 29.1E` → the name and the coordinates (map units; S and W negative). */
export function parseSpawnsQuery(arg: string): { name: string; near?: MapCoords } {
  const m = /^(.*?)\s+near\s+(.+?)\s*$/i.exec(arg.trim());
  // The coordinates as walk_to reads them (mapCoordsText: comma or not, any spacing).
  const near = m && isMapCoordsText(m[2]) ? parseMapCoordsText(m[2]) : null;
  if (!m || !near) return { name: arg.trim() };
  return { name: m[1].trim().replace(/^"(.*)"$/, '$1'), near };
}

const fromYou = fromYouText;

/**
 * Places as text, one per landblock: "37.6N, 29.0E (8 SW of Holtburg) ×4" at the landblock's first spot; a dungeon as
 * its landblock and a cell id to walk_to once inside ("dungeon 0x0185, cell 0x01850148 ×12"). By town then nearest to
 * it, or nearest to `near` first with the distance from there.
 */
export function placesText(ps: ShopPlace[], dat: ShopDatInfo = {}, shown = PLACES_SHOWN, near?: MapCoords): string {
  const byLb = new Map<number, { p: ShopPlace; n: number }>();
  for (const p of ps) {
    const lb = p.cell >>> 16;
    const e = byLb.get(lb);
    if (e) e.n++; else byLb.set(lb, { p, n: 1 });
  }
  const hex = (v: number, w: number) => `0x${(v >>> 0).toString(16).toUpperCase().padStart(w, '0')}`;
  const list = [...byLb.values()].map(({ p, n }) => {
    const at = placeMapCoords(p.cell, p.x, p.y);
    const town = nearestTownOf(at);
    const flags = (p.cell & 0xffff) >= 0x100 ? dat.envCellFlags?.(p.cell) : undefined;
    const underground = flags !== undefined && (flags & 0x1) === 0; // not SeenOutside: a dungeon or cellar
    const t = underground ? `dungeon ${hex(p.cell >>> 16, 4)}, cell ${hex(p.cell, 8)}${town ? ` (under ${town.text})` : ''}` : formatPlace({ ...p, viaGenerator: false }, dat);
    const key = near ? mapDist(near, at).toFixed(2).padStart(8, '0') : `${town ? `${town.name}\t${town.distance.toFixed(1).padStart(5, '0')}` : '\uffff'}\t${t}`;
    return { key, text: `${t}${n > 1 ? ` ×${n}` : ''}${near ? `, ${fromYou(near, at)}` : ''}` };
  }).sort((a, b) => a.key.localeCompare(b.key)).map((x) => x.text);
  return `${list.slice(0, shown).join('; ')}${list.length > shown ? ` (+${list.length - shown} more landblocks)` : ''}`;
}

/** The nearest of a source's places to `near` (map units). */
function nearestOf(s: SpawnSource, near: MapCoords): number {
  return Math.min(...s.places.map((p) => mapDist(near, placeMapCoords(p.cell, p.x, p.y))));
}

/** The answer: for each source, how it comes about and where. */
export function formatSpawns(query: string, pick: LorePick, sources: SpawnSource[], dat: ShopDatInfo = {}, near?: MapCoords, maxLines = SPAWNS_MAX_LINES): string {
  if (!pick.wcids.length) return pick.note ?? `no creature called "${query.trim()}"`;
  const head = pick.note ? [pick.note] : [];
  if (!sources.length) {
    return [...head, `${pick.names.join(', ')}: not placed in this world, and no generator that is placed (or rolled outdoors) makes ${pick.names.length > 1 ? 'them' : 'it'}. It may come from a quest, a summons or an event.`].join('\n');
  }
  const order = { placed: 0, generator: 1, encounter: 2 } as const;
  const sorted = [...sources].sort((a, b) => (near ? nearestOf(a, near) - nearestOf(b, near) : 0) || order[a.how] - order[b.how] || b.places.length - a.places.length || a.chain.join().localeCompare(b.chain.join()));
  const lines = [...head];
  if (sorted.some((s) => s.how !== 'placed')) lines.push('(n%) = the share of that generator\'s rolls that pick the next step; outdoor encounters spawn when the landblock loads (none on a cell with a building).');
  let hidden = 0;
  for (const s of sorted) {
    if (lines.length >= maxLines - 1) { hidden++; continue; }
    const chain = s.chain.map((n, i) => (i < s.shares.length ? `${n} (${shareText(s.shares[i])})` : n)).join(' → ');
    if (s.how === 'placed') lines.push(`placed: ${chain} at ${placesText(s.places, dat, PLACES_SHOWN, near)}`);
    else if (s.how === 'generator') lines.push(`generator: ${chain}, the generator at ${placesText(s.places, dat, PLACES_SHOWN, near)}`);
    else {
      const lbs = new Set(s.places.map((p) => p.cell >>> 16)).size;
      lines.push(`outdoor encounter: ${chain}, on ${s.places.length} spot${s.places.length === 1 ? '' : 's'} in ${lbs} landblock${lbs === 1 ? '' : 's'}: ${placesText(s.places, dat, PLACES_SHOWN, near)}`);
    }
  }
  if (hidden) lines.push(`… ${hidden} more source${hidden === 1 ? '' : 's'} not shown; give more of the name${near ? '' : ', or add "near <your coords>" for the nearest first'}.`);
  else if (!near && sorted.some((s) => new Set(s.places.map((p) => p.cell >>> 16)).size > PLACES_SHOWN)) lines.push('(add "near <your coords>", e.g. spawns "Mite Scion" near 42.1N 33.6E, for the nearest first)');
  return lines.join('\n');
}
