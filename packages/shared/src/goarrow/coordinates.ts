/**
 * GoArrow coordinates (docs/plugin-specs/goarrow.md §1.2, §6.1). Clean-room: our own code from the spec's
 * facts; only the literal strings and constants come from GoArrow.
 *
 * GoArrow's unit is the map "click" (0.1 = a tenth of a degree as /loc prints it), which its UI calls "km";
 * one unit is 240 m. NS = global Y / 240 − 101.95 (spec §1.2: ((lbY × 8 + y/24) − 1019.5) / 10), the same
 * origin as the agent's parseMapCoords (renderer agent/AgentApi.ts MAP_COORD_ORIGIN) and UtilityBelt's
 * LandblockToNS (tools/build-map-markers.ts cellToNS). ACE's /loc text (shared types.ts formatMapCoord)
 * truncates with its own bias instead, so GoArrow coords are NOT formatted through it.
 */

/** A map position in GoArrow units: north and east positive, south and west negative. */
export interface GoCoords {
  ns: number;
  ew: number;
}

/** Map units → global metres origin (spec §1.2: 1019.5 / 10). */
export const GOARROW_COORD_ORIGIN = 101.95;
/** Metres per GoArrow unit ("km" in its UI). */
export const GOARROW_METERS_PER_UNIT = 240;
/** The arrow repaints when the player moves more than this in NS or EW (spec §1.2). */
export const GOARROW_REPAINT_EPSILON = 0.00075;
/** Unset coordinates (spec §6.1). */
export const GOARROW_COORDS_NONE = '<None>';
/** Unset start-location coordinates (spec §4.3). */
export const GOARROW_COORDS_UNKNOWN = '<Unknown>';
/** The coordinate-entry error (spec §2.2). */
export const GOARROW_INVALID_COORDS_MESSAGE = 'Invalid coordinates. Coordinates must be in the form: 00.0N, 00.0E';

/** A landcell id plus its landblock-local x/y (metres) → GoArrow coords (spec §1.2). */
export function goCoordsFromCell(cell: number, x: number, y: number): GoCoords {
  return {
    ns: ((((cell >>> 16) & 0xff) * 8 + y / 24) - 1019.5) / 10,
    ew: ((((cell >>> 24) & 0xff) * 8 + x / 24) - 1019.5) / 10,
  };
}

/** AC global metres (landblock X × 192 + x, landblock Y × 192 + y) → GoArrow coords. */
export function goCoordsFromGlobal(gx: number, gy: number): GoCoords {
  return { ns: gy / GOARROW_METERS_PER_UNIT - GOARROW_COORD_ORIGIN, ew: gx / GOARROW_METERS_PER_UNIT - GOARROW_COORD_ORIGIN };
}

/** GoArrow coords → AC global metres. */
export function goCoordsToGlobal(c: GoCoords): { x: number; y: number } {
  return { x: (c.ew + GOARROW_COORD_ORIGIN) * GOARROW_METERS_PER_UNIT, y: (c.ns + GOARROW_COORD_ORIGIN) * GOARROW_METERS_PER_UNIT };
}

/**
 * GoArrow coords → the outdoor landcell under them and the landblock-local x/y. Null off the map
 * (landblocks run 0x00–0xFE in each axis).
 */
export function goCoordsToCell(c: GoCoords): { cell: number; x: number; y: number } | null {
  const g = goCoordsToGlobal(c);
  const bx = Math.floor(g.x / 192);
  const by = Math.floor(g.y / 192);
  if (bx < 0 || by < 0 || bx > 0xfe || by > 0xfe) return null;
  const x = g.x - bx * 192;
  const y = g.y - by * 192;
  const cellIndex = Math.min(7, Math.floor(x / 24)) * 8 + Math.min(7, Math.floor(y / 24)) + 1;
  return { cell: ((bx << 24) | (by << 16) | cellIndex) >>> 0, x, y };
}

const NUM = '(\\d{1,3}(?:\\.\\d{1,4})?|\\.\\d{1,4})';
/**
 * GoArrow's coordinate syntax (spec §6.1): a number (0–3 digits, optional 1–4-digit fraction, or a bare
 * fraction), optional spaces, n/s, 0–4 of `; / , space`, the second number, optional spaces, e/w.
 * Searched anywhere in the text, case-insensitive.
 */
export const GOARROW_COORDS_PATTERN = `${NUM}\\s*([ns])[;/, ]{0,4}${NUM}\\s*([ew])`;

function toCoords(m: RegExpExecArray): GoCoords {
  const ns = Number(m[1]!.startsWith('.') ? `0${m[1]}` : m[1]);
  const ew = Number(m[3]!.startsWith('.') ? `0${m[3]}` : m[3]);
  return { ns: /s/i.test(m[2]!) ? -ns : ns, ew: /w/i.test(m[4]!) ? -ew : ew };
}

/** The first coordinates anywhere in `text`, or null. */
export function parseGoCoords(text: string): GoCoords | null {
  const m = new RegExp(GOARROW_COORDS_PATTERN, 'i').exec(text);
  return m ? toCoords(m) : null;
}

/** Every coordinate match in `text` (chat links, spec §6.5): position, length and value. */
export function findGoCoords(text: string): Array<{ index: number; length: number; text: string; coords: GoCoords }> {
  const out: Array<{ index: number; length: number; text: string; coords: GoCoords }> = [];
  const re = new RegExp(GOARROW_COORDS_PATTERN, 'gi');
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ index: m.index, length: m[0].length, text: m[0], coords: toCoords(m) });
  return out;
}

/** .NET-style fixed formatting: rounds half away from zero, on the magnitude. */
function fixedAbs(v: number, decimals: number): string {
  const p = 10 ** decimals;
  return (Math.round(Math.abs(v) * p + 1e-9) / p).toFixed(decimals);
}

/** Whether `v` has more than one decimal place (to 1e-6, so float noise doesn't count). */
function hasHundredths(v: number): boolean {
  return Math.abs(v * 10 - Math.round(v * 10)) > 1e-6;
}

/** `12.3N, 45.6E` with a fixed number of decimals (the lists' and Copy's `0.0` format, spec §2.6). */
export function formatGoCoordsFixed(c: GoCoords, decimals = 1): string {
  return `${fixedAbs(c.ns, decimals)}${c.ns >= 0 ? 'N' : 'S'}, ${fixedAbs(c.ew, decimals)}${c.ew >= 0 ? 'E' : 'W'}`;
}

/**
 * GoArrow's coordinate text (spec §6.1): `12.3N, 45.6E`, with two decimals when either value has more than
 * one; `<None>` when unset.
 */
export function formatGoCoords(c: GoCoords | null | undefined): string {
  if (!c) return GOARROW_COORDS_NONE;
  return formatGoCoordsFixed(c, hasHundredths(c.ns) || hasHundredths(c.ew) ? 2 : 1);
}

/** Straight-line distance in units. Infinite when either end is unknown (spec §1.3). */
export function goDistance(a: GoCoords | null | undefined, b: GoCoords | null | undefined): number {
  if (!a || !b) return Infinity;
  return Math.hypot(a.ns - b.ns, a.ew - b.ew);
}

/** The arrow's distance line: `0.00` with no unit (spec §1.3). .NET Framework prints infinity as `Infinity`. */
export function formatGoDistance(d: number): string {
  if (!Number.isFinite(d)) return 'Infinity';
  return fixedAbs(d, 2);
}

/** A route's total, as the Route tab's footer shows it: `12.34 km` (spec §4.2). */
export function formatGoRouteDistance(d: number): string {
  return `${fixedAbs(d, 2)} km`;
}

const TWO_PI = Math.PI * 2;
const wrap = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI;

/** Compass bearing from `from` to `to` in radians: 0 = north, clockwise, in [0, 2π) (spec §1.2). */
export function goBearing(from: GoCoords, to: GoCoords): number {
  return wrap(Math.atan2(to.ew - from.ew, to.ns - from.ns));
}

/**
 * The arrow's angle: the bearing minus the CHARACTER's heading (radians, 0 = north, clockwise), wrapped
 * into [0, 2π). The camera never enters into it (spec §1.2).
 */
export function goArrowAngle(bearing: number, headingRadians: number): number {
  return wrap(bearing - headingRadians);
}

/** The frame of an N-frame arrow set for an angle: floor(angle / 2π × N) mod N, no half-step rounding. */
export function goArrowFrame(angle: number, frameCount: number): number {
  if (frameCount <= 1) return 0;
  return Math.floor((wrap(angle) / TWO_PI) * frameCount) % frameCount;
}

/** Whether the player has moved enough for the arrow to repaint (spec §1.2). */
export function goArrowMoved(prev: GoCoords, next: GoCoords): boolean {
  return Math.abs(prev.ns - next.ns) > GOARROW_REPAINT_EPSILON || Math.abs(prev.ew - next.ew) > GOARROW_REPAINT_EPSILON;
}

/** `player − location`, the lists' "Relative Coordinates" (spec §2.6). */
export function goRelativeCoords(player: GoCoords, location: GoCoords): GoCoords {
  return { ns: player.ns - location.ns, ew: player.ew - location.ew };
}
