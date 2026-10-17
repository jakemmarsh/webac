/**
 * The retail map's town notes (gmMapUI s_rgLocations, HudTooltips.MAP_NOTE_LOCATIONS) as map coordinates, and the
 * nearest town to a spot: what the stream tools' world-query names places by ("42.4N, 32.2E inside a building
 * (Holtburg)"), and what a walk_to target may name a place by ("Holtburg lifestone").
 */
import { MAP_NOTE_LOCATIONS } from '../ui/HudTooltips.js';
import { MAP_MARKER_AREA, PLACE_MARKER_BIAS, PLACE_MARKER_FLIP, PLACE_MARKER_SCALE, PLACE_MARKER_STEP, type MapCoords } from '../ui/MapMarkers.js';

/** Each town note's rect centre turned back into map coordinates (placeMarkerOnMap inverted). */
export const MAP_TOWNS: readonly { name: string; coords: MapCoords }[] = MAP_NOTE_LOCATIONS.map((l) => {
  const a = MAP_MARKER_AREA;
  const px = l.x + l.width / 2, py = l.y + l.height / 2;
  const ew = ((px - a.x0) / ((a.x1 - a.x0 + 1) * -PLACE_MARKER_STEP) - PLACE_MARKER_BIAS) / PLACE_MARKER_SCALE;
  const ns = (PLACE_MARKER_FLIP - (py - a.y0) / ((a.y1 - a.y0 + 1) * -PLACE_MARKER_STEP) - PLACE_MARKER_BIAS) / PLACE_MARKER_SCALE;
  return { name: l.name, coords: { ew, ns } };
});

/** Within this many map units (0.1 = 24 m) of a town's note a place is "in" it. */
export const IN_TOWN_UNITS = 3;

/** The nearest town on the map within 15 map units: its name, the distance, and the text ("Holtburg" within 3, else "5 SW of Holtburg"). */
export function nearestTownOf(c: MapCoords): { name: string; distance: number; text: string } | undefined {
  let best: { name: string; d: number; dn: number; de: number } | undefined;
  for (const t of MAP_TOWNS) {
    const dn = c.ns - t.coords.ns, de = c.ew - t.coords.ew;
    const d = Math.hypot(dn, de);
    if (!best || d < best.d) best = { name: t.name, d, dn, de };
  }
  if (!best || best.d > 15) return undefined;
  if (best.d <= IN_TOWN_UNITS) return { name: best.name, distance: best.d, text: best.name };
  const dir = `${Math.abs(best.dn) > best.d * 0.38 ? (best.dn > 0 ? 'N' : 'S') : ''}${Math.abs(best.de) > best.d * 0.38 ? (best.de > 0 ? 'E' : 'W') : ''}`;
  return { name: best.name, distance: best.d, text: `${Math.round(best.d)} ${dir} of ${best.name}` };
}

/**
 * A town named in a place's name as a player says it: "Holtburg lifestone", "the lifestone in Holtburg", "Holtburg's
 * Life Stone". The town (its note's name) and the rest of the words; null when no town's name is in it as whole words,
 * or nothing else is left.
 */
export function townInName(query: string): { town: string; rest: string } | null {
  const q = query.trim();
  let best: { town: string; rest: string } | null = null;
  for (const t of MAP_TOWNS) {
    const esc = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(^|\\s)${esc}(?:'s)?(?=\\s|$)`, 'i').exec(q);
    if (!m) continue;
    const rest = (q.slice(0, m.index) + ' ' + q.slice(m.index + m[0].length))
      .replace(/\b(in|at|of|near|by)\s*$/i, '').replace(/^\s*(the)\b/i, '').replace(/\s+/g, ' ').trim();
    if (!rest || (best && best.town.length >= t.name.length)) continue;
    best = { town: t.name, rest };
  }
  return best;
}
