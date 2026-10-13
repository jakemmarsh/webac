/**
 * GoArrow's UI-free core (docs/plugin-specs/goarrow.md; packages/shared/src/goarrow/): coordinates, the
 * arrow's rules, location search, islands, the route finder over a small synthetic world, route text, chat
 * commands, the per-era generator over fixture SQL, and the committed per-era tables.
 */
import { describe, expect, it } from 'vitest';
import {
  findGoCoords, formatGoCoords, formatGoCoordsFixed, formatGoDistance, formatGoRouteDistance, goArrowAngle, goArrowFrame, goArrowInDungeon,
  goArrowMoved, goArrowNameLine, goArrowOutline, goArrowTextLines, goArrowVisible, goBearing, goCoordsFromCell, goCoordsFromGlobal, goCoordsToCell,
  goCoordsToGlobal, goDistance, parseGoCoords, goPickArrowSet, goParseTextSize, goRouteStepClick, goCorpseLocation,
  GoLocationType, GO_ANY_PORTAL, GoRegionMap, goLabelIslands, goSearchLocations, goFindLocationAt, goFindLocationByName, goLocationIcon,
  goLocationTypeLabel, goDecodeEraData, goMatchesFound, GOARROW_SEA_REGION, GOARROW_LIMIT_TO,
  GoRouteSearch, goFindRoute, goRouteCopyText, goRouteStepText, goTemporaryPoint, goDefaultStartLocations, GOARROW_DEFAULT_ROUTE_OPTIONS,
  goParseCommand, goHelpText, goLocSendLine, goCommandNameError, goIsHereArg, GOARROW_HUD_TARGET_ERROR, GOARROW_COORDS_PLACEHOLDER_ERROR,
  type GoCoords, type GoLocation, type GoStartLocation, type GoUndergroundPortal, type GoRoute,
} from '@ac/shared';
import { cellToEW, cellToNS } from '../tools/build-map-markers.ts';
import {
  buildGoArrowEra, parseGoArrowLandblockSql, parseGoArrowSpellSql, parseGoArrowWeenieSql, TOWN_ID_BASE, type GaWorld,
} from '../tools/build-goarrow-locations.ts';
import eolTable from '../packages/renderer/src/ui/goarrow/locations/eol.ts';
import ac1999Table from '../packages/renderer/src/ui/goarrow/locations/ac1999.ts';
import dmTable from '../packages/renderer/src/ui/goarrow/locations/dm.ts';

const close = (a: GoCoords | null, b: GoCoords, eps = 1e-9) => {
  expect(a).not.toBeNull();
  expect(Math.abs(a!.ns - b.ns)).toBeLessThan(eps);
  expect(Math.abs(a!.ew - b.ew)).toBeLessThan(eps);
};

describe('coordinates', () => {
  it('parses every form GoArrow accepts, anywhere in the text', () => {
    close(parseGoCoords('42.1N, 33.6E'), { ns: 42.1, ew: 33.6 });
    close(parseGoCoords('42.1n 33.6e'), { ns: 42.1, ew: 33.6 });
    close(parseGoCoords('.5s;12w'), { ns: -0.5, ew: -12 });
    close(parseGoCoords('meet me at 12.3456 S / 45 W please'), { ns: -12.3456, ew: -45 });
    close(parseGoCoords('0N,0E'), { ns: 0, ew: 0 });
    close(parseGoCoords('1.5N;,/ 2.5E'), { ns: 1.5, ew: 2.5 });
    expect(parseGoCoords('42.1N, 33.6')).toBeNull();
    expect(parseGoCoords('42.1N,;/,, 33.6E')).toBeNull(); // more than four separators
    expect(parseGoCoords('hello')).toBeNull();
  });

  it('finds every coordinate in a chat line', () => {
    const hits = findGoCoords('go 10.7N, 52.3E then 1.1s 2.2w');
    expect(hits.map((h) => h.text)).toEqual(['10.7N, 52.3E', '1.1s 2.2w']);
    expect(hits[0]!.index).toBe(3);
    close(hits[1]!.coords, { ns: -1.1, ew: -2.2 });
  });

  it('formats as GoArrow displays: one decimal, two when either value needs it, <None> when unset', () => {
    expect(formatGoCoords({ ns: 42.1, ew: 33.6 })).toBe('42.1N, 33.6E');
    expect(formatGoCoords({ ns: -0.5, ew: -12 })).toBe('0.5S, 12.0W');
    expect(formatGoCoords({ ns: 42.15, ew: 33.6 })).toBe('42.15N, 33.60E');
    expect(formatGoCoords({ ns: 1.005, ew: 2 })).toBe('1.01N, 2.00E');
    expect(formatGoCoords(null)).toBe('<None>');
    expect(formatGoCoordsFixed({ ns: 42.15, ew: -33.64 })).toBe('42.2N, 33.6W');
    expect(formatGoDistance(1.234)).toBe('1.23');
    expect(formatGoDistance(Infinity)).toBe('Infinity');
    expect(formatGoRouteDistance(4.2)).toBe('4.20 km');
  });

  it('round-trips text, cells and global metres', () => {
    for (const text of ['42.1N, 33.6E', '0.5S, 12.0W', '42.15N, 33.60E', '98.0S, 94.7W']) expect(formatGoCoords(parseGoCoords(text))).toBe(text);
    // An outdoor cell (index = cellX × 8 + cellY + 1), and agreement with UtilityBelt's conversion.
    const c = goCoordsFromCell(0xa9b4001d, 84.0, 107.6);
    expect(c.ns).toBeCloseTo(cellToNS(0xa9b4001d, 107.6), 12);
    expect(c.ew).toBeCloseTo(cellToEW(0xa9b4001d, 84.0), 12);
    const cell = goCoordsToCell(c)!;
    expect(cell.cell).toBe(0xa9b4001d >>> 0);
    expect(cell.x).toBeCloseTo(84.0, 6);
    expect(cell.y).toBeCloseTo(107.6, 6);
    close(goCoordsFromGlobal(goCoordsToGlobal(c).x, goCoordsToGlobal(c).y), c, 1e-9);
    // The map's centre: global 101.95 units from the corner.
    close(goCoordsFromGlobal(101.95 * 240, 101.95 * 240), { ns: 0, ew: 0 });
    expect(goCoordsToCell({ ns: 200, ew: 0 })).toBeNull();
  });

  it('measures distance and compass bearing in GoArrow units', () => {
    expect(goDistance({ ns: 0, ew: 0 }, { ns: 3, ew: 4 })).toBe(5);
    expect(goDistance(null, { ns: 0, ew: 0 })).toBe(Infinity);
    expect(goBearing({ ns: 0, ew: 0 }, { ns: 1, ew: 0 })).toBeCloseTo(0);
    expect(goBearing({ ns: 0, ew: 0 }, { ns: 0, ew: 1 })).toBeCloseTo(Math.PI / 2);
    expect(goBearing({ ns: 0, ew: 0 }, { ns: 0, ew: -1 })).toBeCloseTo(Math.PI * 1.5);
  });
});

describe('arrow HUD rules', () => {
  it('turns with the character heading and picks frames by floor', () => {
    const east = goBearing({ ns: 0, ew: 0 }, { ns: 0, ew: 1 });
    expect(goArrowFrame(goArrowAngle(east, 0), 180)).toBe(45); // index 45 of Chrome's 180: a quarter turn clockwise
    expect(goArrowFrame(goArrowAngle(east, Math.PI / 2), 180)).toBe(0); // facing east: dead ahead
    expect(goArrowFrame(goArrowAngle(0, Math.PI / 2), 90)).toBe(67); // north while facing east: to the left
    expect(goArrowFrame((2 * Math.PI) * (1.999 / 180), 180)).toBe(1);
    expect(goArrowFrame(1, 1)).toBe(0);
    expect(goArrowMoved({ ns: 0, ew: 0 }, { ns: 0.0007, ew: 0 })).toBe(false);
    expect(goArrowMoved({ ns: 0, ew: 0 }, { ns: 0.0008, ew: 0 })).toBe(true);
  });

  it('builds the name, coordinates and distance lines', () => {
    const route = { kind: 'route' as const, names: ['Start', 'Mid', 'End'], coords: [{ ns: 1, ew: 1 }, { ns: 2, ew: 2 }, { ns: 3, ew: 3 }], index: 0 };
    expect(goArrowNameLine(route)).toBe('Start  ►');
    expect(goArrowNameLine({ ...route, index: 1 })).toBe('◄  Mid  ►');
    expect(goArrowNameLine({ ...route, index: 2 })).toBe('◄  End');
    expect(goArrowNameLine({ kind: 'object', name: 'Drudge', coords: null, inRange: false })).toBe('Drudge (out of range)');
    expect(goArrowNameLine({ kind: 'coords', coords: { ns: 1, ew: 1 } })).toBeNull();
    const lines = goArrowTextLines({ kind: 'location', name: 'Holtburg', coords: { ns: 42.1, ew: 33.6 } }, { ns: 42.1, ew: 30.6 }, { showDestination: true, showDistance: true });
    expect(lines).toEqual({ name: 'Holtburg', coords: '42.1N, 33.6E', distance: '3.00' });
    expect(goArrowTextLines(null, null, { showDestination: false, showDistance: true })).toEqual({ name: null, coords: null, distance: 'Infinity' });
    expect(goRouteStepClick(5, 100)).toBe(-1);
    expect(goRouteStepClick(95, 100)).toBe(1);
    expect(goRouteStepClick(50, 100)).toBe(0);
  });

  it('hides in dungeons (not building interiors) unless "Show arrow indoors"', () => {
    expect(goArrowInDungeon(0xa9b40019, false)).toBe(false);
    expect(goArrowInDungeon(0xa9b40105, true)).toBe(false);
    expect(goArrowInDungeon(0x01c90105, false)).toBe(true);
    expect(goArrowVisible({ enabled: true, hasImage: true, inDungeon: true, showIndoors: false })).toBe(false);
    expect(goArrowVisible({ enabled: true, hasImage: true, inDungeon: true, showIndoors: true })).toBe(true);
    expect(goArrowVisible({ enabled: true, hasImage: false, inDungeon: false, showIndoors: false })).toBe(false);
  });

  it('outlines, sets, text size and corpse text', () => {
    expect(goArrowOutline(0x000000)).toEqual({ solid: [255, 255, 255, 230], light: [255, 255, 255, 128] });
    expect(goArrowOutline(0x010101).solid).toEqual([0, 0, 0, 255]);
    expect(goPickArrowSet('red glass', ['Chrome', 'Red Glass'])).toBe('Red Glass');
    expect(goPickArrowSet('Gone', ['Simple', 'Chrome'])).toBe('Chrome');
    expect(goPickArrowSet('Gone', ['Simple'])).toBe('Simple');
    expect(goPickArrowSet(null, [])).toBeNull();
    expect(goParseTextSize('14')).toEqual({ size: 14 });
    expect(goParseTextSize('30')).toEqual({ error: 'Text size must be between 8 and 28' });
    expect(goParseTextSize('x')).toEqual({ error: 'Text size must be a number' });
    const corpse = goCorpseLocation({ name: 'Bob', shortTime: '3:04 PM', date: '10/12/2026', time: '3:04:05 PM', deathMessage: 'You died.', dungeon: 'Hell', coords: { ns: 1, ew: 2 } });
    expect(corpse.name).toBe('Corpse of Bob [3:04 PM] in Hell');
    expect(corpse.notes).toBe('Corpse of Bob\n10/12/2026 3:04:05 PM\nYou died.\nIn Dungeon: Hell');
    expect(corpse.icon).toBe(0x06001070);
  });
});

// ── a small synthetic world ──

/** The centre of landblock (bx, by) in GoArrow coords. */
const lb = (bx: number, by: number): GoCoords => ({ ns: (by * 8 + 4 - 1019.5) / 10, ew: (bx * 8 + 4 - 1019.5) / 10 });
const inBox = (x: number, y: number, x0: number, x1: number, y0: number, y1: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
/** Mainland x 100–150, y 100–150; an island x 190–200, y 100–150 (32 units of open sea between). */
const regions = new GoRegionMap(goLabelIslands((x, y) => !inBox(x, y, 100, 150, 100, 150) && !inBox(x, y, 190, 200, 100, 150)));

let nextId = 1;
const loc = (name: string, type: GoLocationType, coords: GoCoords, extra: Partial<GoLocation> = {}): GoLocation =>
  ({ id: nextId++, name, type, coords, notes: '', useInRouteFinding: true, ...extra });
const start = (name: string, coords: GoCoords | null, enabled = true, runDistance = 0.4): GoStartLocation =>
  ({ name, kind: 'Regular', coords, runDistance, enabled, icon: 0 });

describe('islands', () => {
  it('labels the largest landmass 0, islands from 1, sea 255, and round-trips its text', () => {
    expect(regions.regionAt(lb(120, 120))).toBe(0);
    expect(regions.regionAt(lb(195, 120))).toBe(1);
    expect(regions.regionAt(lb(170, 120))).toBe(GOARROW_SEA_REGION);
    expect(regions.regionAt({ ns: 500, ew: 0 })).toBe(GOARROW_SEA_REGION);
    const ids = goLabelIslands((x, y) => !inBox(x, y, 100, 150, 100, 150) && !inBox(x, y, 190, 200, 100, 150));
    const again = GoRegionMap.decode(GoRegionMap.encode(ids));
    for (const [x, y] of [[100, 100], [150, 150], [151, 150], [195, 101], [0, 0], [255, 255]] as const) expect(again.regionAt(lb(x, y))).toBe(regions.regionAt(lb(x, y)));
  });
});

describe('route finder', () => {
  const portal = loc('Portal to the Isle', GoLocationType.Portal, lb(141, 120), { exitCoords: lb(192, 120) });
  const from = goTemporaryPoint('start', lb(140, 120));
  const to = goTemporaryPoint('end', lb(196, 121));

  it('never runs between islands, even within the maximum run', () => {
    const near = goTemporaryPoint('start', lb(150, 120));
    const across = goTemporaryPoint('end', lb(190, 120)); // 32 units: under the 50 maximum
    expect(goDistance(near.coords, across.coords)).toBeLessThan(50);
    expect(goFindRoute({ locations: [], regions }, [], [], near, across)).toBeNull();
    // On one landmass the same run is a route.
    const sameIsland = goFindRoute({ locations: [], regions: GoRegionMap.uniform(0) }, [], [], near, across)!;
    expect(sameIsland.steps.map((s) => s.kind)).toEqual(['start', 'end']);
    expect(sameIsland.distance).toBeCloseTo(32, 9);
  });

  it('takes a portal as an entrance → exit hop at the portal cost', () => {
    const route = goFindRoute({ locations: [portal], regions }, [], [], from, to)!;
    expect(route.steps.map((s) => s.location.name)).toEqual(['Start Point', 'Portal to the Isle', 'End Point']);
    expect(route.steps[1]!.coords).toEqual(portal.coords);
    expect(route.distance).toBeCloseTo(0.8 + 0.4 + Math.hypot(3.2, 0.8), 9);
    expect(route.steps.map(goRouteStepText)).toEqual([
      `Start Point [${formatGoCoordsFixed(from.coords!)}]`, `Portal to the Isle [${formatGoCoordsFixed(portal.coords!)}]`, `End Point [${formatGoCoordsFixed(to.coords!)}]`,
    ]);
    expect(goRouteStepText(route.steps[0]!)).toMatch(/^Start Point \[\d+\.\d[NS], \d+\.\d[EW]\]$/);
    // The option, not GoArrow's pre-settings 0, prices the portal.
    expect(GOARROW_DEFAULT_ROUTE_OPTIONS.portalWeight).toBe(0.4);
    const pricey = goFindRoute({ locations: [portal], regions }, [], [], from, to, { portalWeight: 3 })!;
    expect(pricey.distance - route.distance).toBeCloseTo(2.6, 9);
  });

  it('honours the maximum run, portal levels and "Use in route finding"', () => {
    expect(goFindRoute({ locations: [portal], regions }, [], [], from, to, { maxRunDistance: 1 })).toBeNull();
    const high = { ...portal, minLevel: 50 };
    expect(goFindRoute({ locations: [high], regions }, [], [], from, to, { playerLevel: 10 })).toBeNull();
    expect(goFindRoute({ locations: [high], regions }, [], [], from, to, { playerLevel: 60 })).not.toBeNull();
    expect(goFindRoute({ locations: [high], regions }, [], [], from, to)).not.toBeNull();
    expect(goFindRoute({ locations: [{ ...portal, useInRouteFinding: false }], regions }, [], [], from, to)).toBeNull();
  });

  it('starts from the cheapest recall, and "Next longer" gives the next start, then none', () => {
    const starts = [start('Isle Recall', lb(195, 120)), start('Off Recall', lb(195, 121), false), start('Unknown Tie', null)];
    const search = new GoRouteSearch({ locations: [portal], regions }, starts, [], from, to);
    const first = search.next()!;
    expect(first.steps.map((s) => s.location.name)).toEqual(['Isle Recall', 'End Point']);
    expect(first.distance).toBeCloseTo(0.4 + Math.hypot(0.8, 0.8), 9); // the start's run distance is added
    const second = search.next()!;
    expect(second.steps[0]!.location.name).toBe('Start Point');
    expect(second.distance).toBeGreaterThan(first.distance);
    expect(search.next()).toBeNull();
    // With no From point only the start locations are used.
    expect(goFindRoute({ locations: [portal], regions }, starts, [], null, to)!.steps[0]!.location.name).toBe('Isle Recall');
  });

  it('goes underground: any entrance into a dungeon reaches its way-out portals', () => {
    const entrance = loc('Town Network Portal', GoLocationType.Dungeon, lb(130, 130), { dungeonId: 0x0007 });
    const ug: GoUndergroundPortal = { id: 99, name: 'Portal to the Isle Shore', dungeonId: 0x0007, exitCoords: lb(198, 140), walk: 0.2, useInRouteFinding: true };
    const f = goTemporaryPoint('start', lb(129, 130));
    const t = goTemporaryPoint('end', lb(198, 141));
    const route = goFindRoute({ locations: [portal, entrance], underground: [ug], regions }, [], [], f, t)!;
    expect(route.steps.map((s) => [s.kind, s.location.name])).toEqual([
      ['start', 'Start Point'], ['portal', 'Town Network Portal'], ['underground', 'Portal to the Isle Shore'], ['end', 'End Point'],
    ]);
    expect(route.steps[2]!.coords).toEqual(entrance.coords); // the inside portal is shown at the entrance that leads to it
    expect(route.distance).toBeCloseTo(0.8 + 0.4 + 0.4 + 0.2 + 0.8, 9);
    // Beyond the dungeon-walk limit the underground portal isn't used.
    const viaPortal = goFindRoute({ locations: [portal, entrance], underground: [ug], regions }, [], [], f, t, { maxDungeonWalk: 0.1 })!;
    expect(viaPortal.steps.map((s) => s.location.name)).toContain('Portal to the Isle');
  });

  it('charges an Underground Portal location double, and prices mansion devices per GoArrow', () => {
    const under = loc('Underpass', GoLocationType.UndergroundPortal, lb(141, 120), { exitCoords: lb(192, 120) });
    const r = goFindRoute({ locations: [under], regions }, [], [], from, to)!;
    expect(r.distance).toBeCloseTo(0.8 + 0.8 + Math.hypot(3.2, 0.8), 9);
    const device = { name: 'Isle Device', coords: lb(140, 121), enabled: true, destinations: [{ name: 'Isle', coords: lb(196, 120) }, { name: 'Far', coords: lb(110, 110) }] };
    const d = goFindRoute({ locations: [], regions }, [], [device], from, to, { mansionRunDistance: 1 })!;
    expect(d.steps.map((s) => s.kind)).toEqual(['start', 'device', 'end']);
    expect(d.steps[1]!.location.name).toBe('Isle Device: Isle');
    expect(d.distance).toBeCloseTo(0.8 + (2 * (0.4 + 1) - 1) + 0.8, 9);
    expect(goFindRoute({ locations: [], regions }, [], [{ ...device, coords: null }], from, to)).toBeNull();
    expect(goFindRoute({ locations: [], regions }, [], [{ ...device, enabled: false }], from, to)).toBeNull();
  });

  it('builds the default start list from what the era has', () => {
    const list = goDefaultStartLocations(new Map([['Aerlinthe Recall', { ns: 84.1, ew: 47.2 }], ["Ulgrim's Recall", null], ['Portal Gem: Holtburg', { ns: 42.1, ew: 33.6 }]]));
    expect(list.map((s) => [s.name, s.enabled])).toEqual([
      ['Aerlinthe Recall', true], ["Ulgrim's Recall", false], ['Portal Gem: Holtburg', false],
      ['Lifestone Bind', true], ['Lifestone Tie', true], ['Primary Portal Tie', true], ['Secondary Portal Tie', true],
      ['House Recall', true], ['Mansion Recall', true], ['Allegiance Hometown', true],
    ]);
    expect(list[0]!.runDistance).toBe(0.4);
    expect(list.find((s) => s.name === 'Lifestone Bind')!.coords).toBeNull();
  });

  it('copies a route as Name [coords] >> …, 225 characters at a time', () => {
    const route = goFindRoute({ locations: [portal], regions }, [], [], from, to)!;
    expect(goRouteCopyText(route)).toEqual({ text: route.steps.map(goRouteStepText).join(' >> '), next: null });
    const long: GoRoute = { distance: 1, steps: Array.from({ length: 12 }, (_, i) => ({ kind: 'portal' as const, coords: { ns: i, ew: i }, location: loc(`A rather long portal name number ${i}`, GoLocationType.Portal, { ns: i, ew: i }) })) };
    const parts: string[] = [];
    let at: number | null = 0;
    while (at !== null) {
      const c = goRouteCopyText(long, at);
      expect(c.text.length).toBeLessThanOrEqual(225);
      if (c.next !== null) expect(c.text.endsWith(' >>')).toBe(true);
      parts.push(c.next !== null ? c.text.slice(0, -3) : c.text);
      at = c.next;
    }
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(' >> ')).toBe(long.steps.map(goRouteStepText).join(' >> '));
  });
});

describe('location search', () => {
  const hub = loc('Hub', GoLocationType.PortalHub, { ns: 10, ew: 10 });
  const db: GoLocation[] = [
    loc('zebra Inn', GoLocationType.Vendor, { ns: 10.02, ew: 10 }, { notes: 'sells hats' }),
    hub,
    loc('Alpha Portal', GoLocationType.TownPortal, { ns: 0, ew: 0 }, { exitCoords: { ns: 5, ew: 5 } }),
    loc('12 Oaks', GoLocationType.Landmark, { ns: 1, ew: 1 }),
    loc('apple Grove', GoLocationType.Landmark, { ns: 50, ew: 50 }, { notes: 'zebra crossing' }),
  ];
  it('matches text in Name / Descr / Both, nearby, types, in index order', () => {
    expect(goSearchLocations(db, { text: 'ZEBRA' }).map((l) => l.name)).toEqual(['zebra Inn']);
    expect(goSearchLocations(db, { text: 'zebra', searchIn: 'Descr' }).map((l) => l.name)).toEqual(['apple Grove']);
    expect(goSearchLocations(db, { text: 'zebra', searchIn: 'Both' }).map((l) => l.name)).toEqual(['apple Grove', 'zebra Inn']);
    expect(goSearchLocations(db, {}).map((l) => l.name)).toEqual(['12 Oaks', 'Alpha Portal', 'apple Grove', 'Hub', 'zebra Inn']);
    expect(goSearchLocations(db, { near: { coords: { ns: 0, ew: 0 }, radius: 2 } }).map((l) => l.name)).toEqual(['12 Oaks', 'Alpha Portal']);
    expect(goSearchLocations(db, { text: 'a', near: { coords: { ns: 0, ew: 0 }, radius: 2 } }).map((l) => l.name)).toEqual(['12 Oaks', 'Alpha Portal']);
    expect(goSearchLocations(db, { type: GO_ANY_PORTAL }).map((l) => l.name)).toEqual(['Alpha Portal']);
    expect(goMatchesFound(1234)).toBe('1,234 - matches found');
    expect(GOARROW_LIMIT_TO.map((t) => t.label).slice(0, 4)).toEqual(['Any', 'Any Portal', 'Allegiance Hall', 'Allegiance Bindstone']);
  });
  it('names coordinates by the nearest known location (a Portal Hub wins) and finds exact names', () => {
    expect(goFindLocationAt(db, { ns: 10.01, ew: 10 })).toBe(hub);
    expect(goFindLocationAt(db, { ns: 20, ew: 20 })).toBeNull();
    expect(goFindLocationByName(db, 'ALPHA PORTAL')!.name).toBe('Alpha Portal');
    expect(goFindLocationByName(db, 'Alpha')).toBeNull();
    expect(goLocationTypeLabel(db[2]!, formatGoCoords)).toBe('Town Portal (Exit 5.0N, 5.0E)');
    expect(goLocationIcon({ ...db[0]!, isFavorite: true })).toBe(0x06001e13);
    expect(goLocationIcon({ ...db[0]!, isFavorite: true }, true)).toBe(0x06001036);
    expect(goLocationIcon(loc("Bob's Mansion", GoLocationType.Village, { ns: 0, ew: 0 }))).toBe(0x0600218b);
  });
});

describe('chat commands', () => {
  const names = { main: 'goarrow', loc: 'loc', dest: null, find: 'find' };
  it('parses subcommands, HUD targets and aliases', () => {
    expect(goParseCommand('/goarrow', names)).toEqual({ kind: 'help', topic: 'main' });
    expect(goParseCommand('@GoArrow help dest', names)).toEqual({ kind: 'help', topic: 'loc' });
    expect(goParseCommand('/goarrow show all', names)).toEqual({ kind: 'hud', action: 'show', target: 'all' });
    expect(goParseCommand('/goarrow toggle', names)).toEqual({ kind: 'hud', action: 'toggle', target: 'arrow' });
    expect(goParseCommand('/goarrow hide dungeon map', names)).toEqual({ kind: 'hud', action: 'hide', target: 'dungeon' });
    expect(goParseCommand('/goarrow on bogus', names)).toEqual({ kind: 'error', message: GOARROW_HUD_TARGET_ERROR });
    expect(goParseCommand('/goarrow dereth off', names)).toEqual({ kind: 'hud', action: 'hide', target: 'dereth' });
    expect(goParseCommand('/goarrow map', names)).toEqual({ kind: 'hud', action: 'toggle', target: 'map' });
    expect(goParseCommand('/goarrow to 42.1N, 33.6E', names)).toEqual({ kind: 'to', arg: '42.1N, 33.6E' });
    expect(goParseCommand('/goarrow from here', names)).toEqual({ kind: 'start', arg: 'here' });
    expect(goParseCommand('/goarrow to [coords]', names)).toEqual({ kind: 'error', message: GOARROW_COORDS_PLACEHOLDER_ERROR });
    expect(goParseCommand('/goarrow attach', names)).toEqual({ kind: 'tag' });
    expect(goParseCommand('/goarrow unlock', names)).toEqual({ kind: 'lock', locked: false });
    expect(goParseCommand('/goarrow frob', names)).toEqual({ kind: 'error', message: 'Invalid command: frob. Type /goarrow help for a list of available commands' });
    expect(goParseCommand('/loc f', names)).toEqual({ kind: 'loc', arg: 'f' });
    expect(goParseCommand('/loc', names)).toBeNull(); // aliases need the trailing space
    expect(goParseCommand('/find drudge', names)).toEqual({ kind: 'find', text: 'drudge' });
    expect(goParseCommand('/goarrowx', names)).toBeNull();
    expect(goParseCommand('hello', names)).toBeNull();
    expect(goIsHereArg('"here"')).toBe(true);
  });
  it('prints the help text and builds loc / dest lines', () => {
    const help = goHelpText(names);
    expect(help[0]).toBe("You're using GoArrow v2.5.0.0. Here are the commands available:");
    expect(help).toContain('    /loc (target)  -  Same as /goarrow loc (target)');
    expect(help).toContain('    /find (name)  -  Same as /goarrow find (name)');
    expect(help.at(-1)).toBe('    /goarrow help loc  -  Show help for the /goarrow loc and /goarrow dest commands');
    expect(goLocSendLine('say', '1.0N, 2.0E')).toBe('/say 1.0N, 2.0E');
    expect(goLocSendLine("t Digero, I'm at", '1.0N, 2.0E')).toBe("/t Digero, I'm at 1.0N, 2.0E");
    expect(goLocSendLine('/t Digero', '1.0N, 2.0E')).toBe('/t Digero, 1.0N, 2.0E');
    expect(goLocSendLine('a Come to %c for the quest', '1.0N, 2.0E')).toBe('/a Come to 1.0N, 2.0E for the quest');
    expect(goCommandNameError('main', 'loc', names)).toBe('The main chat command cannot be the same as another goarrow chat command.');
    expect(goCommandNameError('loc', 'find', names)).toBe("The '/goarrow loc' command alias cannot be the same as another goarrow chat command.");
    expect(goCommandNameError('loc', 'coords', names)).toBeNull();
  });
});

describe('per-era generator (fixture SQL)', () => {
  const weenie = (id: number, type: number, name: string, more = '') => `INSERT INTO \`weenie\` (\`class_Id\`, \`class_Name\`, \`type\`, \`last_Modified\`)
VALUES (${id}, 'x${id}', ${type}, '2005-02-09 10:00:00') /* t */;

INSERT INTO \`weenie_properties_string\` (\`object_Id\`, \`type\`, \`value\`)
VALUES (${id},   1, '${name.replace(/'/g, "''")}') /* Name */;
${more}`;
  const pos = (id: number, cell: number, x: number, y: number, z = 0) => `INSERT INTO \`weenie_properties_position\` (\`object_Id\`, \`position_Type\`, \`obj_Cell_Id\`, \`origin_X\`, \`origin_Y\`, \`origin_Z\`, \`angles_W\`, \`angles_X\`, \`angles_Y\`, \`angles_Z\`)
VALUES (${id}, 2, 0x${cell.toString(16).toUpperCase()}, ${x}, ${y}, ${z}, 1, 0, 0, 0) /* Destination */;`;
  const ints = (id: number, rows: Array<[number, number]>) => `INSERT INTO \`weenie_properties_int\` (\`object_Id\`, \`type\`, \`value\`)
VALUES ${rows.map(([k, v]) => `(${id}, ${k}, ${v}) /* p */`).join('\n     , ')};`;
  // Cells: 0xA9B4xxxx outdoor; 0x01C90100 a dungeon; 0xA9B40150 a building (SeenOutside).
  const seenOutside = (cell: number): boolean | null => ((cell & 0xffff) < 0x100 ? null : (cell >>> 16) === 0x01c9 ? false : true);
  const lbSql = (rows: Array<[number, number, number, number, number, number]>) => rows.map(([g, w, c, x, y, z]) => `INSERT INTO \`landblock_instance\` (\`guid\`, \`weenie_Class_Id\`, \`obj_Cell_Id\`, \`origin_X\`, \`origin_Y\`, \`origin_Z\`, \`angles_W\`, \`angles_X\`, \`angles_Y\`, \`angles_Z\`, \`is_Link_Child\`, \`last_Modified\`)
VALUES (0x${g.toString(16).toUpperCase()}, ${w}, 0x${c.toString(16).toUpperCase()}, ${x}, ${y}, ${z}, 1, 0, 0, 0, False, '2005-02-09 10:00:00'); /* x */`).join('\n\n');
  const spellSql = (id: number, name: string, cell: number, x: number, y: number, z: number) => `INSERT INTO \`spell\` (\`id\`, \`name\`, \`position_Obj_Cell_ID\`, \`position_Origin_X\`, \`position_Origin_Y\`, \`position_Origin_Z\`, \`position_Angles_W\`, \`position_Angles_X\`, \`position_Angles_Y\`, \`position_Angles_Z\`, \`last_Modified\`)
VALUES (${id}, '${name.replace(/'/g, "''")}', 0x${cell.toString(16).toUpperCase()}, ${x}, ${y}, ${z}, 1, 0, 0, 0, '2005-02-09 10:00:00');`;

  const sources = [
    weenie(1, 7, 'Portal to Rithwic', pos(1, 0xa9b40020, 10, 20)),
    weenie(2, 7, 'Mine Portal', pos(2, 0x01c90100, 0, 0)),
    weenie(3, 7, 'Surface', pos(3, 0xa9b4003a, 50, 60)),
    weenie(4, 7, 'Quest Portal', `${pos(4, 0xa9b40020, 1, 1)}\n\nINSERT INTO \`weenie_properties_string\` (\`object_Id\`, \`type\`, \`value\`)\nVALUES (4,  37, 'SomeQuest') /* QuestRestriction */;\n\n${ints(4, [[86, 20], [87, 40]])}`),
    weenie(5, 25, 'Life Stone'),
    weenie(6, 10, 'Town Crier', `${ints(6, [[1, 16]])}\n\nINSERT INTO \`weenie_properties_bool\` (\`object_Id\`, \`type\`, \`value\`)\nVALUES (6,  19, False) /* Attackable */;`),
    weenie(7, 10, 'Drudge', ints(7, [[1, 16]])),
    weenie(8, 12, "Ogan's Shop"),
    weenie(9, 7, 'Portal to Holtburg', pos(9, 0xa9b40019, 84, 107.6)),
    weenie(10, 0, 'Holtburg Portal Gem', `INSERT INTO \`weenie_properties_d_i_d\` (\`object_Id\`, \`type\`, \`value\`)\nVALUES (10,   1, 0x02000921) /* Setup */\n     , (10,  31,          9) /* LinkedPortalOne */;`),
    weenie(11, 0, 'Citadels Portal Device', `INSERT INTO \`weenie_properties_emote_action\` (\`emote_Id\`, \`order\`, \`type\`, \`delay\`, \`extent\`, \`motion\`, \`message\`, \`test_String\`, \`min\`, \`max\`, \`min_64\`, \`max_64\`, \`min_Dbl\`, \`max_Dbl\`, \`stat\`, \`display\`, \`amount\`, \`amount_64\`, \`hero_X_P_64\`, \`percent\`, \`spell_Id\`, \`wealth_Rating\`)
VALUES (@parent_id,  0,  19 /* CastSpellInstant */, 0, 1, NULL, 'Hi, (there)', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 501 /* Citadel */, NULL);`),
  ];
  const world: GaWorld = {
    weenies: sources.map((s) => parseGoArrowWeenieSql(s)!),
    placements: parseGoArrowLandblockSql(lbSql([
      [0x7a9b4001, 1, 0xa9b40019, 80, 100, 0], // landscape portal
      [0x7a9b4002, 2, 0xa9b4001a, 90, 100, 0], // dungeon entrance
      [0x701c9001, 3, 0x01c90101, 3, 4, 0], // way out inside the dungeon (5 m from the landing)
      [0x7a9b4003, 4, 0xa9b40150, 5, 5, 0], // a quest-restricted portal in a building
      [0x7a9b4004, 5, 0xa9b40019, 82, 104, 0],
      [0x7a9b4005, 6, 0xa9b40019, 83, 105, 0],
      [0x7a9b4006, 7, 0xa9b40019, 84, 106, 0], // a monster: not an NPC
      [0x7a9b4007, 8, 0x01c90102, 0, 0, 0], // a vendor inside the dungeon: not listed
    ])),
    spells: [
      parseGoArrowSpellSql(spellSql(2941, "Ulgrim's Recall", 0xa9b40019, 84, 107.6, 0))!,
      parseGoArrowSpellSql(spellSql(2942, 'Free Ride to the Abandoned Mine', 0x01c90100, 1, 1, 0))!,
      parseGoArrowSpellSql(spellSql(501, 'Citadel', 0xa9b40021, 0, 0, 0))!,
    ],
  };

  it('parses ACE-layout weenie, landblock and spell SQL', () => {
    const p = world.weenies[0]!;
    expect([p.wcid, p.type, p.name, p.dest]).toEqual([1, 7, 'Portal to Rithwic', { cell: 0xa9b40020, x: 10, y: 20, z: 0 }]);
    expect(world.weenies[3]!.strs.get(37)).toBe('SomeQuest');
    expect(world.weenies[3]!.ints.get(86)).toBe(20);
    expect(world.weenies[5]!.bools.get(19)).toBe(false);
    expect(world.weenies[7]!.name).toBe("Ogan's Shop");
    expect(world.weenies[9]!.dids.get(31)).toBe(9);
    expect(world.weenies[10]!.castSpells).toEqual([501]);
    expect(world.placements[0]).toEqual({ guid: 0x7a9b4001, wcid: 1, pos: { cell: 0xa9b40019, x: 80, y: 100, z: 0 } });
    expect(world.spells[1]!.name).toBe('Free Ride to the Abandoned Mine');
    expect(parseGoArrowSpellSql(spellSql(1, 'x', 0, 0, 0, 0).replace('0x0', 'NULL'))).toBeNull();
  });

  it('builds locations, underground portals, starts and devices from the world', () => {
    const t = buildGoArrowEra(world, seenOutside);
    const byId = new Map(t.l.map((r) => [r[0], r]));
    const at = (cell: number, x: number, y: number) => { const c = goCoordsFromCell(cell, x, y); return [Math.round(c.ns * 100) / 100, Math.round(c.ew * 100) / 100]; };
    expect(byId.get(0x7a9b4001)).toEqual([0x7a9b4001, GoLocationType.Portal, 'Portal to Rithwic', ...at(0xa9b40019, 80, 100), ...at(0xa9b40020, 10, 20), 0, 0, 0, 0]);
    expect(byId.get(0x7a9b4002)!.slice(1, 3)).toEqual([GoLocationType.Dungeon, 'Mine Portal']);
    expect(byId.get(0x7a9b4002)![7]).toBe(0x01c9);
    expect(byId.get(0x7a9b4003)!.slice(8)).toEqual([20, 40, 1]); // levels kept, not for routing
    expect(byId.get(0x7a9b4004)![1]).toBe(GoLocationType.Lifestone);
    expect(byId.get(0x7a9b4005)![1]).toBe(GoLocationType.NPC);
    expect(byId.has(0x7a9b4006)).toBe(false);
    expect(byId.has(0x7a9b4007)).toBe(false);
    // Holtburg (UB's list) is kept: people within 2.0 of it.
    const holtburg = t.l.find((r) => r[2] === 'Holtburg')!;
    expect(holtburg[1]).toBe(GoLocationType.Town);
    expect(holtburg[0]).toBeGreaterThanOrEqual(TOWN_ID_BASE);
    expect(t.u).toEqual([[0x701c9001, 'Surface', 0x01c9, ...at(0xa9b4003a, 50, 60), Math.round((5 / 240) * 1000) / 1000, 0, 0, 0]]);
    // Ulgrim's lands on the landscape; the Abandoned Mine lands in a dungeon and starts at its nearest way out.
    expect(t.s).toEqual([['Abandoned Mines', ...at(0xa9b4003a, 50, 60)], ["Ulgrim's Recall", ...at(0xa9b40019, 84, 107.6)], ['Portal Gem: Holtburg', ...at(0xa9b40019, 84, 107.6)]]);
    expect(t.p).toEqual([['Citadels Portal Device', [['Citadel', ...at(0xa9b40021, 0, 0)]]]]);
    expect(t.d).toEqual([['01C9', 'Mine']]);
    // And it decodes into routable data.
    const data = goDecodeEraData({ ...t, r: GoRegionMap.encode(new Uint8Array(65536)) }, formatGoCoords);
    expect(data.locations.find((l) => l.id === 0x7a9b4002)!.notes).toBe('Leads into Mine');
    expect(data.locations.find((l) => l.id === 0x7a9b4003)!.notes).toContain('Restrictions: Level 20-40');
    expect(data.starts.get('Abandoned Mines')).not.toBeNull();
  });
});

describe('the committed per-era tables', () => {
  const eras = { eol: goDecodeEraData(eolTable, formatGoCoords), ac1999: goDecodeEraData(ac1999Table, formatGoCoords), dm: goDecodeEraData(dmTable, formatGoCoords) };

  it('each era has its own portals, lifestones, vendors and islands', () => {
    for (const d of Object.values(eras)) {
      expect(d.locations.filter((l) => l.type === GoLocationType.Portal && l.exitCoords).length).toBeGreaterThan(50);
      expect(d.locations.some((l) => l.type === GoLocationType.Lifestone)).toBe(true);
      expect(d.locations.some((l) => l.type === GoLocationType.Vendor)).toBe(true);
      expect(d.regions.regionAt(parseGoCoords('42.1N, 33.6E')!)).toBe(0); // Holtburg: the mainland
    }
    // Aerlinthe is an island; the Halaetan Isles are apart from the mainland.
    expect(eras.eol.regions.regionAt(parseGoCoords('84.1N, 47.2E')!)).not.toBe(0);
    expect(eras.eol.regions.regionAt(parseGoCoords('40.7N, 83.1W')!)).not.toBe(0);
    // Recall start points follow the era: none in 1999; end of retail matches GoArrow's own defaults closely.
    expect(eras.ac1999.starts.size).toBe(0);
    const aer = eras.eol.starts.get('Aerlinthe Recall')!;
    expect(goDistance(aer, { ns: 84.1, ew: 47.2 })).toBeLessThan(0.1);
    expect(goDistance(eras.eol.starts.get('Abandoned Mines')!, { ns: 34.9, ew: 54.6 })).toBeLessThan(0.2);
    expect(eras.eol.underground.some((u) => eras.eol.dungeonNames.get(u.dungeonId) === 'Town Network')).toBe(true);
  });

  it('finds an end-of-retail route from Holtburg to Nanto (farther than any run) through portals', () => {
    const d = eras.eol;
    const from = goTemporaryPoint('start', parseGoCoords('42.1N, 33.6E')!);
    const to = goTemporaryPoint('end', parseGoCoords('52.6S, 81.9E')!);
    expect(goDistance(from.coords, to.coords)).toBeGreaterThan(GOARROW_DEFAULT_ROUTE_OPTIONS.maxRunDistance);
    const route = goFindRoute({ locations: d.locations, underground: d.underground, regions: d.regions }, [], [], from, to)!;
    expect(route).not.toBeNull();
    expect(route.steps.length).toBeGreaterThan(2);
    expect(route.distance).toBeLessThan(goDistance(from.coords, to.coords));
  });
});
