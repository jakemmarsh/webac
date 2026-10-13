/**
 * GoArrow locations (docs/plugin-specs/goarrow.md §3, §5): the record, the type flags with their UI names
 * and portal.dat icons, search, and the per-era data our generator writes (tools/build-goarrow-locations.ts).
 * GoArrow's bundled Crossroads of Dereth database is never used (it has no data licence, spec §5.1).
 */
import { goDistance, type GoCoords } from './coordinates.js';

/** GoArrow's LocationType flags (spec §3.2). */
export enum GoLocationType {
  Unknown = 0,
  AllegianceHall = 0x1,
  Bindstone = 0x2,
  Dungeon = 0x4,
  Landmark = 0x8,
  Lifestone = 0x10,
  NPC = 0x20,
  Outpost = 0x40,
  Portal = 0x80,
  PortalHub = 0x100,
  SettlementPortal = 0x200,
  Village = 0x400,
  Town = 0x800,
  TownPortal = 0x1000,
  UndergroundPortal = 0x2000,
  Vendor = 0x4000,
  WildernessPortal = 0x8000,
  PortalDevice = 0x8000000,
  Custom = 0x10000000,
  StartPoint = 0x20000000,
  EndPoint = 0x40000000,
}

/** Every portal subtype (the "Any Portal" filter). */
export const GO_ANY_PORTAL = GoLocationType.Portal | GoLocationType.SettlementPortal | GoLocationType.TownPortal
  | GoLocationType.UndergroundPortal | GoLocationType.WildernessPortal;
/** Every bit (the "Any" filter). */
export const GO_ANY_LOCATION = 0x7fffffff;

/** Friendly name and list icon per type (spec §3.2). */
export const GO_LOCATION_TYPE_INFO: ReadonlyMap<number, { name: string; icon: number }> = new Map([
  [GoLocationType.Unknown, { name: 'Unknown', icon: 0x060010e8 }],
  [GoLocationType.AllegianceHall, { name: 'Allegiance Hall', icon: 0x06002019 }],
  [GoLocationType.Bindstone, { name: 'Allegiance Bindstone', icon: 0x0600218c }],
  [GoLocationType.Dungeon, { name: 'Dungeon', icon: 0x0600106b }],
  [GoLocationType.Landmark, { name: 'Landmark', icon: 0x06002b04 }],
  [GoLocationType.Lifestone, { name: 'Lifestone', icon: 0x060024e1 }],
  [GoLocationType.NPC, { name: 'NPC', icon: 0x06001036 }],
  [GoLocationType.Outpost, { name: 'Outpost', icon: 0x060012d3 }],
  [GoLocationType.Portal, { name: 'Portal', icon: 0x060029ed }],
  [GoLocationType.PortalHub, { name: 'Portal Hub', icon: 0x06005b1e }],
  [GoLocationType.SettlementPortal, { name: 'Settlement Portal', icon: 0x060029ed }],
  [GoLocationType.Village, { name: 'Settlement', icon: 0x06002181 }],
  [GoLocationType.Town, { name: 'Town', icon: 0x06002b6c }],
  [GoLocationType.TownPortal, { name: 'Town Portal', icon: 0x060029ed }],
  [GoLocationType.UndergroundPortal, { name: 'Underground Portal', icon: 0x060029ed }],
  [GoLocationType.Vendor, { name: 'Vendor', icon: 0x06001036 }],
  [GoLocationType.WildernessPortal, { name: 'Wilderness Portal', icon: 0x060029ed }],
  [GoLocationType.PortalDevice, { name: 'Portal Device', icon: 0x060030c3 }],
  [GoLocationType.Custom, { name: 'Custom', icon: 0x06001f88 }],
  [GoLocationType.StartPoint, { name: 'Start Point', icon: 0x060018dd }],
  [GoLocationType.EndPoint, { name: 'End Point', icon: 0x060018dc }],
  [GO_ANY_LOCATION, { name: 'Any', icon: 0x060010e8 }],
  [GO_ANY_PORTAL, { name: 'Any Portal', icon: 0x060029ed }],
]);
/** The list "go" icon, the delete icon, the favourite heart and the yellow target of a recent bare coordinate. */
export const GOARROW_GO_ICON = 0x06001f80;
export const GOARROW_DELETE_ICON = 0x0600606e;
export const GOARROW_FAVORITE_ICON = 0x06001e13;
export const GOARROW_RECENT_COORDS_ICON = 0x06005e6b;

/** A location (spec §3.1). A location is a portal for route finding exactly when it has exit coordinates. */
export interface GoLocation {
  /** Database rows: the world's landblock_instance guid (or a fixed id, below); user-made ≥ GOARROW_USER_ID_BASE; temporary < 0. */
  id: number;
  name: string;
  type: GoLocationType;
  coords: GoCoords | null;
  exitCoords?: GoCoords | null;
  /** The dungeon landblock (high 16 bits of a cell id) a dungeon entrance leads into. */
  dungeonId?: number;
  notes: string;
  useInRouteFinding: boolean;
  minLevel?: number;
  maxLevel?: number;
  isFavorite?: boolean;
  isCustomized?: boolean;
  icon?: number;
}

/**
 * A portal inside a dungeon that leads out to the landscape. GoArrow's curated database called these
 * "Underground Portals"; ours come from the world data. Route finding reaches one through any landscape
 * entrance into its dungeon (a GoLocation of type Dungeon with the same dungeonId).
 */
export interface GoUndergroundPortal {
  id: number;
  name: string;
  dungeonId: number;
  exitCoords: GoCoords;
  /** Straight-line distance (units) from the nearest place an entrance drops you to this portal. */
  walk: number;
  useInRouteFinding: boolean;
  minLevel?: number;
  maxLevel?: number;
}

/** User-made locations get ids from here up (GoArrow used 2e9; world guids reach past that). */
export const GOARROW_USER_ID_BASE = 0x80000000;

/** The friendly type name (spec §3.2). */
export function goLocationTypeName(type: number): string {
  return GO_LOCATION_TYPE_INFO.get(type)?.name ?? 'Unknown';
}

/** A location's list icon (spec §3.2): its own override, the heart for a favourite (outside Favorites), else its type's. */
export function goLocationIcon(loc: GoLocation, inFavoritesList = false): number {
  if (loc.icon) return loc.icon;
  if (loc.isFavorite && !inFavoritesList) return GOARROW_FAVORITE_ICON;
  if (loc.type === GoLocationType.Village) {
    if (loc.name.includes('Mansion')) return 0x0600218b;
    if (loc.name.includes('Villa')) return 0x0600218e;
  }
  return GO_LOCATION_TYPE_INFO.get(loc.type)?.icon ?? 0x060010e8;
}

/** The Details tab's type label: friendly type, plus ` (Exit <coords>)` for a portal (spec §2.6). */
export function goLocationTypeLabel(loc: GoLocation, formatCoords: (c: GoCoords) => string): string {
  const name = goLocationTypeName(loc.type);
  return loc.exitCoords ? `${name} (Exit ${formatCoords(loc.exitCoords)})` : name;
}

/** Type filter (spec §3.3): equal, or sharing any bit. */
export function goTypeMatches(type: number, filter: number): boolean {
  return type === filter || (type & filter) !== 0;
}

/** The "Limit to" dropdown, for our generated database (spec §3.3, the Crossroads list). */
export const GOARROW_LIMIT_TO: ReadonlyArray<{ label: string; type: number }> = [
  GO_ANY_LOCATION, GO_ANY_PORTAL,
  GoLocationType.AllegianceHall, GoLocationType.Bindstone, GoLocationType.Dungeon, GoLocationType.Landmark, GoLocationType.Lifestone,
  GoLocationType.NPC, GoLocationType.Outpost, GoLocationType.PortalHub, GoLocationType.SettlementPortal, GoLocationType.Village,
  GoLocationType.Town, GoLocationType.TownPortal, GoLocationType.UndergroundPortal, GoLocationType.Vendor, GoLocationType.WildernessPortal,
  GoLocationType.Custom,
].map((type) => ({ label: goLocationTypeName(type), type }));

/** The alphabetical index bucket (spec §3.3): `#` unless the name starts with a letter. */
export function goLetterBucket(name: string): string {
  const c = name.charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
}

/** Index order: `#` then A–Z, each case-insensitive by name, then id. */
export function goCompareLocations(a: GoLocation, b: GoLocation): number {
  const ba = goLetterBucket(a.name);
  const bb = goLetterBucket(b.name);
  if (ba !== bb) return ba === '#' ? -1 : bb === '#' ? 1 : ba < bb ? -1 : 1;
  const na = a.name.toLowerCase();
  const nb = b.name.toLowerCase();
  if (na !== nb) return na < nb ? -1 : 1;
  return a.id - b.id;
}

export type GoSearchIn = 'Name' | 'Descr' | 'Both';
export interface GoSearchQuery {
  text?: string | null;
  searchIn?: GoSearchIn;
  near?: { coords: GoCoords; radius: number } | null;
  type?: number;
}

/** Search (spec §3.3): text and/or nearby (their intersection), the type filter, index order. */
export function goSearchLocations(locations: Iterable<GoLocation>, q: GoSearchQuery): GoLocation[] {
  const text = q.text?.toLowerCase() ?? null;
  const type = q.type ?? GO_ANY_LOCATION;
  const out: GoLocation[] = [];
  for (const loc of locations) {
    if (!goTypeMatches(loc.type, type)) continue;
    if (text !== null) {
      const hay = q.searchIn === 'Descr' ? loc.notes : q.searchIn === 'Both' ? loc.name + loc.notes : loc.name;
      if (!hay.toLowerCase().includes(text)) continue;
    }
    if (q.near && !(goDistance(q.near.coords, loc.coords) <= q.near.radius)) continue;
    out.push(loc);
  }
  return out.sort(goCompareLocations);
}
export const GOARROW_INVALID_RADIUS_MESSAGE = 'Invalid search radius; must be a number greater than 0';
export const GOARROW_INVALID_NEARBY_MESSAGE = 'Invalid coordinates for nearby search';
export const GOARROW_NO_SEARCH_MESSAGE = 'You must select either a Text or Nearby search';
/** The results footer: `#,0 - ` then `matches found`. */
export const goMatchesFound = (n: number): string => `${n.toLocaleString('en-US')} - matches found`;

/** Exact-name lookup for chat commands (spec §3.3): case-insensitive, first in index order. */
export function goFindLocationByName(locations: Iterable<GoLocation>, name: string): GoLocation | null {
  const want = name.trim().toLowerCase();
  let best: GoLocation | null = null;
  for (const loc of locations) if (loc.name.toLowerCase() === want && (!best || goCompareLocations(loc, best) < 0)) best = loc;
  return best;
}

/** How close entered coordinates must be to name a known location (spec §1.6). */
export const GOARROW_COORDS_MATCH_RADIUS = 0.049;

/** The known location at `coords` (spec §1.6): within 0.049; a Portal Hub wins, else the first in index order. */
export function goFindLocationAt(locations: Iterable<GoLocation>, coords: GoCoords): GoLocation | null {
  const hits = [...locations].filter((l) => goDistance(l.coords, coords) <= GOARROW_COORDS_MATCH_RADIUS).sort(goCompareLocations);
  return hits.find((l) => l.type === GoLocationType.PortalHub) ?? hits[0] ?? null;
}

// ── islands ──

/** Region id of landblocks that are open sea (every vertex water: players can't enter, WaterMap.ts). */
export const GOARROW_SEA_REGION = 255;

/**
 * Which island each landblock belongs to (spec §4.1 "regions", regenerated from the era's own terrain, §5.2).
 * 0 = the mainland (the largest landmass); other ids are islands; 255 = open sea.
 */
export class GoRegionMap {
  constructor(private readonly ids: Uint8Array) {
    if (ids.length !== 65536) throw new Error('GoRegionMap needs 256×256 landblocks');
  }

  /** From the generator's run-length text: `id*run` tokens separated by `,`, landblocks in (x << 8 | y) order. */
  static decode(rle: string): GoRegionMap {
    const ids = new Uint8Array(65536).fill(GOARROW_SEA_REGION);
    let i = 0;
    for (const tok of rle.split(',')) {
      if (!tok) continue;
      const [id, run] = tok.split('*');
      const n = run === undefined ? 1 : parseInt(run, 36);
      ids.fill(parseInt(id!, 36), i, i + n);
      i += n;
    }
    return new GoRegionMap(ids);
  }

  /** The run-length text `decode` reads. */
  static encode(ids: Uint8Array): string {
    const out: string[] = [];
    for (let i = 0; i < ids.length;) {
      let j = i;
      while (j < ids.length && ids[j] === ids[i]) j++;
      out.push(j - i === 1 ? ids[i]!.toString(36) : `${ids[i]!.toString(36)}*${(j - i).toString(36)}`);
      i = j;
    }
    return out.join(',');
  }

  /** The region of the landblock under `c` (sea off the map). */
  regionAt(c: GoCoords): number {
    const bx = Math.floor((c.ew * 10 + 1019.5) / 8);
    const by = Math.floor((c.ns * 10 + 1019.5) / 8);
    if (bx < 0 || by < 0 || bx > 255 || by > 255) return GOARROW_SEA_REGION;
    return this.ids[(bx << 8) | by]!;
  }

  /** Every landblock in one region (a whole-world map, for tests). */
  static uniform(id = 0): GoRegionMap {
    return new GoRegionMap(new Uint8Array(65536).fill(id));
  }
}

/**
 * Label each landblock with its island (4-connected land; a landblock is sea when `isSea`). The largest
 * island is 0, the rest numbered by size from 1 (ties by first landblock); more than 254 islands share 254.
 */
export function goLabelIslands(isSea: (bx: number, by: number) => boolean): Uint8Array {
  const comp = new Int32Array(65536).fill(-1);
  const sizes: Array<{ c: number; size: number; first: number }> = [];
  for (let start = 0; start < 65536; start++) {
    if (comp[start] !== -1 || isSea(start >> 8, start & 0xff)) continue;
    const c = sizes.length;
    let size = 0;
    const stack = [start];
    comp[start] = c;
    while (stack.length) {
      const k = stack.pop()!;
      size++;
      const x = k >> 8;
      const y = k & 0xff;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
        if (nx < 0 || ny < 0 || nx > 255 || ny > 255) continue;
        const nk = (nx << 8) | ny;
        if (comp[nk] !== -1 || isSea(nx, ny)) continue;
        comp[nk] = c;
        stack.push(nk);
      }
    }
    sizes.push({ c, size, first: start });
  }
  const order = [...sizes].sort((a, b) => b.size - a.size || a.first - b.first);
  const idOf = new Map(order.map((s, i) => [s.c, Math.min(i, 254)]));
  const ids = new Uint8Array(65536).fill(GOARROW_SEA_REGION);
  for (let k = 0; k < 65536; k++) if (comp[k]! >= 0) ids[k] = idOf.get(comp[k]!)!;
  return ids;
}

// ── era data ──

/**
 * The generator's per-era file (tools/build-goarrow-locations.ts), JSON:
 *   l: [id, type, name, ns, ew, exitNs|null, exitEw|null, dungeonId, minLevel, maxLevel, flags][]  (flags 1 = not for route finding)
 *   u: [id, name, dungeonId, exitNs, exitEw, walk, minLevel, maxLevel, flags][]                    (underground portals)
 *   s: [start-location name, ns|null, ew|null][]                                                    (recalls and gems this era has)
 *   p: [device name, [destination name, ns, ew][]][]                                                (mansion portal devices)
 *   d: [dungeon landblock hex, name][]
 *   r: GoRegionMap run-length text
 */
export interface GoArrowEraFile {
  v: 1;
  l: Array<[number, number, string, number, number, number | null, number | null, number, number, number, number]>;
  u: Array<[number, string, number, number, number, number, number, number, number]>;
  s: Array<[string, number | null, number | null]>;
  p: Array<[string, Array<[string, number, number]>]>;
  d: Array<[string, string]>;
  r: string;
}

export interface GoArrowEraData {
  locations: GoLocation[];
  underground: GoUndergroundPortal[];
  /** Recall and gem start points by GoArrow's start-location name; null coords = the era has it but it lands in a dungeon. */
  starts: Map<string, GoCoords | null>;
  devices: Array<{ name: string; destinations: Array<{ name: string; coords: GoCoords }> }>;
  dungeonNames: Map<number, string>;
  regions: GoRegionMap;
}

/** Our own description text for a generated location (never Crossroads text, spec §5.2). */
export function goGeneratedNotes(o: { type: number; exitCoords?: GoCoords | null; dungeonName?: string | null; minLevel?: number; maxLevel?: number; useInRouteFinding: boolean },
  formatCoords: (c: GoCoords) => string): string {
  const lines: string[] = [];
  if (o.exitCoords) lines.push(`Destination: ${formatCoords(o.exitCoords)}`);
  if (o.type === GoLocationType.Dungeon) lines.push(o.dungeonName ? `Leads into ${o.dungeonName}` : 'Leads into a dungeon');
  const min = o.minLevel ?? 0;
  const max = o.maxLevel ?? 0;
  if (min > 0 || max > 0) lines.push(`Restrictions: ${max > 0 ? `Level ${min}-${max}` : `Level ${min}+`}`);
  if (!o.useInRouteFinding && o.type !== GoLocationType.Dungeon && o.exitCoords) lines.push('Not used in route finding (restricted)');
  return lines.join('\n');
}

/** Decode a generated era file. */
export function goDecodeEraData(json: string | GoArrowEraFile, formatCoords: (c: GoCoords) => string): GoArrowEraData {
  const f: GoArrowEraFile = typeof json === 'string' ? JSON.parse(json) : json;
  const dungeonNames = new Map(f.d.map(([lb, n]) => [parseInt(lb, 16), n]));
  const locations = f.l.map(([id, type, name, ns, ew, xns, xew, dungeonId, minLevel, maxLevel, flags]): GoLocation => {
    const exitCoords = xns === null || xew === null ? null : { ns: xns, ew: xew };
    const loc: GoLocation = { id, name, type, coords: { ns, ew }, exitCoords, notes: '', useInRouteFinding: (flags & 1) === 0 };
    if (dungeonId) loc.dungeonId = dungeonId;
    if (minLevel) loc.minLevel = minLevel;
    if (maxLevel) loc.maxLevel = maxLevel;
    loc.notes = goGeneratedNotes({ ...loc, dungeonName: dungeonId ? dungeonNames.get(dungeonId) : null }, formatCoords);
    return loc;
  });
  const underground = f.u.map(([id, name, dungeonId, ns, ew, walk, minLevel, maxLevel, flags]): GoUndergroundPortal => ({
    id, name, dungeonId, exitCoords: { ns, ew }, walk, useInRouteFinding: (flags & 1) === 0,
    ...(minLevel ? { minLevel } : {}), ...(maxLevel ? { maxLevel } : {}),
  }));
  return {
    locations,
    underground,
    starts: new Map(f.s.map(([n, ns, ew]) => [n, ns === null || ew === null ? null : { ns, ew }])),
    devices: f.p.map(([name, dests]) => ({ name, destinations: dests.map(([n, ns, ew]) => ({ name: n, coords: { ns, ew } })) })),
    dungeonNames,
    regions: GoRegionMap.decode(f.r),
  };
}
