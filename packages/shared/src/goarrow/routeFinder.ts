/**
 * GoArrow's route finder (docs/plugin-specs/goarrow.md §4): portals as entrance → exit pairs, running legs
 * only within one island, recalls / ties / gems / the From point as starts, a backwards Dijkstra from the
 * end that stops at the first start popped, and "Next longer" resuming it for the next start.
 *
 * Our additions, all from the era's world data (GoArrow's curated database did these by hand):
 *  - Islands come from the era's terrain (locations.ts GoRegionMap), not GoArrow's hand-drawn MapRegions.xml.
 *  - Underground portals: a portal inside a dungeon that leads out is reached through ANY landscape entrance
 *    into that dungeon. Its cost is GoArrow's underground rule (two portal costs) plus the straight-line walk
 *    inside the dungeon from where the entrance drops you.
 *  - An optional player level drops portals the server would refuse (ACE Portal MinLevel / MaxLevel).
 *
 * The portal cost: GoArrow's code starts at 0 until its settings load, while the UI shows 0.4. We always use
 * the option's value (default 0.4), so the first route of a session matches every later one.
 */
import { formatGoCoordsFixed, goDistance, type GoCoords } from './coordinates.js';
import { GoLocationType, GoRegionMap, type GoLocation, type GoUndergroundPortal } from './locations.js';

/** Kinds of start location (spec §4.3). Special kinds learn their coordinates in play. */
export type GoStartKind = 'Regular' | 'LifestoneBind' | 'LifestoneTie' | 'PrimaryPortalTie' | 'SecondaryPortalTie' | 'HouseRecall' | 'MansionRecall' | 'AllegianceBindstone';

export interface GoStartLocation {
  name: string;
  kind: GoStartKind;
  coords: GoCoords | null;
  /** Added to every running leg leaving this start (units). */
  runDistance: number;
  enabled: boolean;
  icon: number;
  /** Whose copy of a special start's coordinates is used. */
  savedPer?: 'Character' | 'Account' | 'Monarchy';
}

/** GoArrow's regular start locations in order (spec §4.3), coordinates left to the era's data. */
export const GOARROW_DEFAULT_RECALLS: ReadonlyArray<{ name: string; runDistance: number; enabled: boolean; icon: number }> = [
  { name: 'Abandoned Mines', runDistance: 1.0, enabled: true, icon: 0x06005b1e },
  { name: 'Aerlinthe Recall', runDistance: 0.4, enabled: true, icon: 0x060029e4 },
  { name: 'Aphus Lassel Recall', runDistance: 0.4, enabled: true, icon: 0x060029e5 },
  { name: 'Sancturary Recall', runDistance: 0.4, enabled: true, icon: 0x060029e7 },
  { name: 'Mount Lethe Recall', runDistance: 0.4, enabled: true, icon: 0x060029e6 },
  { name: 'Singularity Caul Recall', runDistance: 0.4, enabled: true, icon: 0x060029e8 },
  { name: 'Glenden Wood Recall', runDistance: 0.4, enabled: false, icon: 0x06006291 },
  { name: "Ulgrim's Recall", runDistance: 0.4, enabled: false, icon: 0x060029e9 },
];

/** The portal gems GoArrow adds, disabled, run distance 0.4 (spec §4.3). */
export const GOARROW_DEFAULT_GEMS: readonly string[] = [
  'Al-Arqas', 'Holtburg', 'Lytelthorpe', 'Nanto', 'Rithwic', 'Samsur', 'Shoushi', 'Xarabydun', 'Yanshi', 'Yaraq', 'Celdiseth', 'Fadsahil', 'Shoyanen',
].map((t) => `Portal Gem: ${t}`);

/** The special start locations (spec §4.3); coordinates start unknown. */
export const GOARROW_SPECIAL_STARTS: ReadonlyArray<Omit<GoStartLocation, 'coords' | 'enabled'>> = [
  { name: 'Lifestone Bind', kind: 'LifestoneBind', runDistance: 1.0, icon: 0x060024e1, savedPer: 'Character' },
  { name: 'Lifestone Tie', kind: 'LifestoneTie', runDistance: 0.4, icon: 0x06002558, savedPer: 'Character' },
  { name: 'Primary Portal Tie', kind: 'PrimaryPortalTie', runDistance: 0.4, icon: 0x0600255f, savedPer: 'Character' },
  { name: 'Secondary Portal Tie', kind: 'SecondaryPortalTie', runDistance: 0.4, icon: 0x06002560, savedPer: 'Character' },
  { name: 'House Recall', kind: 'HouseRecall', runDistance: 1.0, icon: 0x06002181, savedPer: 'Account' },
  { name: 'Mansion Recall', kind: 'MansionRecall', runDistance: 1.0, icon: 0x0600218b, savedPer: 'Monarchy' },
  { name: 'Allegiance Hometown', kind: 'AllegianceBindstone', runDistance: 1.0, icon: 0x0600218c, savedPer: 'Monarchy' },
];

/**
 * The start-location list a new profile gets (spec §4.3): GoArrow's recalls and gems that this era has
 * (`eraStarts`, from the generated data; a recall into a dungeon keeps its row with unknown coordinates),
 * then the special kinds, enabled, with unknown coordinates.
 */
export function goDefaultStartLocations(eraStarts: ReadonlyMap<string, GoCoords | null>): GoStartLocation[] {
  const out: GoStartLocation[] = [];
  for (const r of GOARROW_DEFAULT_RECALLS) {
    if (eraStarts.has(r.name)) out.push({ ...r, kind: 'Regular', coords: eraStarts.get(r.name) ?? null });
  }
  for (const g of GOARROW_DEFAULT_GEMS) {
    if (eraStarts.has(g)) out.push({ name: g, kind: 'Regular', coords: eraStarts.get(g) ?? null, runDistance: 0.4, enabled: false, icon: 0x060029ed });
  }
  for (const s of GOARROW_SPECIAL_STARTS) out.push({ ...s, coords: null, enabled: true });
  return out;
}

/** A mansion portal device (spec §4.4): usable when detected (coords known) and enabled. */
export interface GoPortalDevice {
  name: string;
  coords: GoCoords | null;
  enabled: boolean;
  destinations: ReadonlyArray<{ name: string; coords: GoCoords }>;
  icon?: number;
}

export interface GoRouteOptions {
  /** "Treat using a portal equivalent to running" (units). */
  portalWeight: number;
  /** "Maximum running distance between portals" (units). */
  maxRunDistance: number;
  /** The walk between a mansion's devices: Mansion Recall's run distance (spec §4.3). */
  mansionRunDistance: number;
  /** Drops portals whose level range excludes this level; undefined uses every portal (GoArrow's behaviour). */
  playerLevel?: number;
  /** Underground portals farther than this (units) from where an entrance drops you are not used. */
  maxDungeonWalk: number;
}

export const GOARROW_DEFAULT_ROUTE_OPTIONS: Readonly<GoRouteOptions> = Object.freeze({
  portalWeight: 0.4,
  maxRunDistance: 50,
  mansionRunDistance: 1.0,
  maxDungeonWalk: 0.5,
});

/** One row of a route (spec §4.5): the location, and the coordinates the row and the arrow use. */
export interface GoRouteStep {
  location: GoLocation;
  coords: GoCoords;
  kind: 'start' | 'portal' | 'underground' | 'device' | 'end';
}

export interface GoRoute {
  steps: GoRouteStep[];
  /** Total cost in units (running distance plus portal costs). */
  distance: number;
}

export const GOARROW_NO_ROUTE_LABEL = 'No route found';
export const GOARROW_NO_ROUTE_MESSAGE = 'Unable to find a route.  Try turning on more start locations or increasing the maximum run distance between portals.';
export const GOARROW_NO_MORE_ROUTES_MESSAGE = "Can't find any more routes.";
export const GOARROW_INVALID_END_MESSAGE = 'Invalid end point coordinates';

type VKind = 'entrance' | 'exit' | 'hub';
interface Vertex {
  kind: VKind;
  coords: GoCoords | null;
  region: number;
  /** Which location (or start / device / underground portal) this vertex belongs to. */
  owner: number;
  /** A start vertex's extra run. */
  extra: number;
  start?: { location: GoLocation };
  end?: boolean;
  /** Backward edges into this vertex: [from vertex, weight, step kind of the from-side]. */
  incoming: Array<[number, number]>;
  step?: { location: GoLocation; kind: GoRouteStep['kind'] };
  /** A hub's dungeon id. */
  dungeonId?: number;
  /** An underground exit's portal. */
  underground?: GoUndergroundPortal;
}

function levelOk(o: { minLevel?: number; maxLevel?: number }, level: number | undefined): boolean {
  if (level === undefined) return true;
  if ((o.minLevel ?? 0) > level) return false;
  if ((o.maxLevel ?? 0) > 0 && level > o.maxLevel!) return false;
  return true;
}

/** A temporary start / end location (spec §4.2): ids below 0. */
export function goTemporaryPoint(kind: 'start' | 'end', coords: GoCoords): GoLocation {
  return kind === 'start'
    ? { id: -2, name: 'Start Point', type: GoLocationType.StartPoint, coords, notes: '', useInRouteFinding: false }
    : { id: -3, name: 'End Point', type: GoLocationType.EndPoint, coords, notes: '', useInRouteFinding: false };
}

function startLocationAsLocation(s: GoStartLocation, i: number): GoLocation {
  return { id: -100 - i, name: s.name, type: GoLocationType.Custom, coords: s.coords, notes: '', useInRouteFinding: false, icon: s.icon };
}

/**
 * One route search (Find Route), resumable for "Next longer". Build it with the world, the starts and the
 * From / To points, then call `next()` repeatedly: each call returns the next-cheapest route, each from a
 * different start, or null when none remain.
 */
export class GoRouteSearch {
  private readonly v: Vertex[] = [];
  private readonly dist: Float64Array;
  private readonly nextHop: Int32Array;
  private readonly done: Uint8Array;
  private readonly entrancesByDungeon = new Map<number, number[]>();
  private readonly exits: number[] = [];
  private readonly regions: GoRegionMap;

  constructor(world: {
    locations: Iterable<GoLocation>;
    underground?: Iterable<GoUndergroundPortal>;
    regions: GoRegionMap;
  }, starts: readonly GoStartLocation[], devices: readonly GoPortalDevice[], from: GoLocation | null, to: GoLocation, options: Partial<GoRouteOptions> = {}) {
    const o: GoRouteOptions = { ...GOARROW_DEFAULT_ROUTE_OPTIONS, ...options };
    this.regions = world.regions;
    const region = (c: GoCoords | null) => (c ? this.regions.regionAt(c) : -1);
    const add = (x: Omit<Vertex, 'incoming' | 'region' | 'extra'> & { extra?: number }): number => {
      this.v.push({ extra: 0, ...x, region: region(x.coords), incoming: [] });
      return this.v.length - 1;
    };
    let owner = 0;

    // Portals: entrance → exit.
    const undergroundDungeons = new Set<number>();
    const ug = [...(world.underground ?? [])].filter((u) => u.useInRouteFinding && u.walk <= o.maxDungeonWalk && levelOk(u, o.playerLevel));
    for (const u of ug) undergroundDungeons.add(u.dungeonId);
    for (const loc of world.locations) {
      if (!loc.coords || !loc.useInRouteFinding || !levelOk(loc, o.playerLevel)) continue;
      if (loc.exitCoords) {
        const own = ++owner;
        const kind: GoRouteStep['kind'] = loc.type === GoLocationType.UndergroundPortal ? 'underground' : 'portal';
        const en = add({ kind: 'entrance', coords: loc.coords, owner: own, step: { location: loc, kind } });
        const ex = add({ kind: 'exit', coords: loc.exitCoords, owner: own });
        const w = loc.type === GoLocationType.UndergroundPortal ? 2 * o.portalWeight : o.portalWeight;
        this.v[ex]!.incoming.push([en, w]);
        this.exits.push(ex);
      } else if (loc.type === GoLocationType.Dungeon && loc.dungeonId !== undefined && undergroundDungeons.has(loc.dungeonId)) {
        const en = add({ kind: 'entrance', coords: loc.coords, owner: ++owner, step: { location: loc, kind: 'portal' } });
        const list = this.entrancesByDungeon.get(loc.dungeonId) ?? [];
        list.push(en);
        this.entrancesByDungeon.set(loc.dungeonId, list);
      }
    }
    // Underground portals: dungeon entrances → hub → the portal's exit.
    const hubs = new Map<number, number>();
    for (const [dungeonId, ens] of this.entrancesByDungeon) {
      const hub = add({ kind: 'hub', coords: null, owner: ++owner, dungeonId });
      for (const en of ens) this.v[hub]!.incoming.push([en, o.portalWeight]);
      hubs.set(dungeonId, hub);
    }
    for (const u of ug) {
      const hub = hubs.get(u.dungeonId);
      if (hub === undefined) continue;
      const ex = add({ kind: 'exit', coords: u.exitCoords, owner: ++owner, underground: u });
      this.v[ex]!.incoming.push([hub, o.portalWeight + u.walk]);
      this.exits.push(ex);
    }
    // Portal devices: each destination an entrance/exit pair (spec §4.4).
    for (const d of devices) {
      if (!d.enabled || !d.coords) continue;
      const n = d.destinations.length;
      const w = n * (o.portalWeight + o.mansionRunDistance) - o.mansionRunDistance;
      for (const dest of d.destinations) {
        const own = ++owner;
        const loc: GoLocation = { id: -50, name: `${d.name}: ${dest.name}`, type: GoLocationType.PortalDevice, coords: d.coords, exitCoords: dest.coords, notes: '', useInRouteFinding: true, ...(d.icon ? { icon: d.icon } : {}) };
        const en = add({ kind: 'entrance', coords: d.coords, owner: own, step: { location: loc, kind: 'device' } });
        const ex = add({ kind: 'exit', coords: dest.coords, owner: own });
        this.v[ex]!.incoming.push([en, w]);
        this.exits.push(ex);
      }
    }
    // Starts: exit-type vertices with no incoming edges.
    starts.forEach((s, i) => {
      if (!s.enabled || !s.coords) return;
      this.exits.push(add({ kind: 'exit', coords: s.coords, owner: ++owner, extra: s.runDistance, start: { location: startLocationAsLocation(s, i) } }));
    });
    if (from?.coords) this.exits.push(add({ kind: 'exit', coords: from.coords, owner: ++owner, start: { location: from } }));
    // The end: an entrance-type vertex.
    const end = add({ kind: 'entrance', coords: to.coords, owner: ++owner, end: true, step: { location: to, kind: 'end' } });

    this.maxRun = o.maxRunDistance;
    this.dist = new Float64Array(this.v.length).fill(Infinity);
    this.nextHop = new Int32Array(this.v.length).fill(-1);
    this.done = new Uint8Array(this.v.length);
    if (to.coords) this.dist[end] = 0;
  }

  private readonly maxRun: number;

  /** The next-cheapest route from a start not yet used, or null (spec §4.2). */
  next(): GoRoute | null {
    for (;;) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < this.v.length; i++) if (!this.done[i] && this.dist[i]! < best) { best = this.dist[i]!; u = i; }
      if (u < 0) return null;
      this.done[u] = 1;
      const vu = this.v[u]!;
      if (vu.start) return this.readBack(u);
      const relax = (w: number, weight: number) => {
        if (this.done[w]) return;
        const d = best + weight;
        if (d < this.dist[w]!) { this.dist[w] = d; this.nextHop[w] = u; }
      };
      for (const [w, weight] of vu.incoming) relax(w, weight);
      if (vu.kind === 'entrance') {
        // Running legs: from every exit in the same region within the maximum run.
        for (const w of this.exits) {
          const vw = this.v[w]!;
          if (vw.owner === vu.owner || vw.region !== vu.region) continue;
          const d = goDistance(vw.coords, vu.coords) + vw.extra;
          if (d < this.maxRun) relax(w, d);
        }
      }
    }
  }

  private readBack(start: number): GoRoute {
    const vs = this.v[start]!;
    const steps: GoRouteStep[] = [{ location: vs.start!.location, coords: vs.coords!, kind: 'start' }];
    let lastEntrance: GoCoords | null = null;
    for (let u = this.nextHop[start]!; u >= 0; u = this.nextHop[u]!) {
      const vu = this.v[u]!;
      if (vu.kind === 'entrance' && vu.step) {
        steps.push({ location: vu.step.location, coords: vu.coords!, kind: vu.step.kind });
        lastEntrance = vu.coords;
      } else if (vu.kind === 'exit' && vu.underground && lastEntrance) {
        // The portal to take inside the dungeon: shown at the entrance that leads to it.
        const ugp = vu.underground;
        steps.push({
          location: { id: ugp.id, name: ugp.name, type: GoLocationType.UndergroundPortal, coords: lastEntrance, exitCoords: ugp.exitCoords, dungeonId: ugp.dungeonId, notes: '', useInRouteFinding: true },
          coords: lastEntrance,
          kind: 'underground',
        });
      }
    }
    return { steps, distance: this.dist[start]! };
  }
}

/** Find the cheapest route (spec §4.2); null when there is none. Use GoRouteSearch for "Next longer". */
export function goFindRoute(...args: ConstructorParameters<typeof GoRouteSearch>): GoRoute | null {
  return new GoRouteSearch(...args).next();
}

// ── what a route shows ──

/** A route row's text: `Name [coords]`, coords in `0.0` format (spec §4.5). */
export function goRouteStepText(step: GoRouteStep): string {
  return `${step.location.name} [${formatGoCoordsFixed(step.coords, 1)}]`;
}

/** The Copy button's limit (spec §4.5). */
export const GOARROW_ROUTE_COPY_LIMIT = 225;
export const GOARROW_ROUTE_COPY_PARTIAL_MESSAGE = 'The route was too long to fit into a tell, so only part of it was copied. Click Copy again to copy the next part.';
export const GOARROW_ROUTE_COPY_EMPTY_MESSAGE = 'There is no route to copy';

/**
 * The Copy text from step `from` (spec §4.5): `Name [coords] >> Name [coords] >> …`, at most 225 characters.
 * When cut it ends with ` >>` and `next` is where the next Copy continues; `next` is null once it all fit.
 */
export function goRouteCopyText(route: GoRoute, from = 0): { text: string; next: number | null } {
  const parts = route.steps.map(goRouteStepText);
  let text = '';
  let i = from;
  for (; i < parts.length; i++) {
    const piece = text ? `${text} >> ${parts[i]}` : parts[i]!;
    const tail = i < parts.length - 1 ? ' >>' : '';
    if (text && piece.length + tail.length > GOARROW_ROUTE_COPY_LIMIT) break;
    text = piece;
  }
  if (i < parts.length) return { text: `${text} >>`, next: i };
  return { text, next: null };
}
