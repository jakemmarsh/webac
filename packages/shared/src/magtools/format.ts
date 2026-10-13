/**
 * Number formatting the way Mag-Tools' .NET code prints it (docs/plugin-specs/magtools.md):
 * `N1` / `N2` / `#,##0` / `n0` are en-US grouped with fixed decimals; `Math.Round` is
 * banker's rounding (.NET's default MidpointRounding.ToEven); a bare `double.ToString()`
 * is the shortest form ("5.5", "5", "-2.3").
 */
import { roundHalfToEven } from '../util/round.js';

const fmtCache = new Map<number, Intl.NumberFormat>();
function nf(decimals: number): Intl.NumberFormat {
  let f = fmtCache.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: true });
    fmtCache.set(decimals, f);
  }
  return f;
}

/** .NET `ToString("N<d>")` (and `#,##0` / `{0:n0}` for d = 0). */
export function mtN(v: number, decimals = 0): string {
  return nf(decimals).format(v);
}

/** .NET `Math.Round(v)` (to even). */
export function mtRound(v: number): number {
  return roundHalfToEven(v);
}

/** .NET `Math.Round(v, digits)` (to even), with a guard for binary noise (0.15 * 100 = 15.000000000000002). */
export function mtRoundTo(v: number, digits: number): number {
  const p = 10 ** digits;
  const scaled = Number((v * p).toPrecision(12));
  return roundHalfToEven(scaled) / p;
}

/** A .NET double's default `ToString()`: the shortest round-trip form, no grouping. */
export function mtDouble(v: number): string {
  if (Object.is(v, -0)) return '0';
  return String(Number(v.toPrecision(15)));
}

/**
 * Mag-Tools' number shortener for its tracker lists (spec §5.2): `#,##0` up to the cap, past it the
 * value in thousands / millions / billions (`#,##0` + k / M / G) at the first unit that fits the cap's width.
 */
export function mtShortNumber(n: number, cap: number): string {
  if (n <= cap) return mtN(n, 0);
  const width = mtN(cap, 0).length;
  const k = mtN(n / 1000, 0);
  if (k.length <= width) return `${k}k`;
  const m = mtN(n / 1_000_000, 0);
  if (m.length <= width) return `${m}M`;
  return `${mtN(n / 1_000_000_000, 0)}G`;
}

/** `{hours}h{minutes:00}m`: whole hours (TotalHours, truncated) and the minutes part (spec §5.1). */
export function mtHoursMinutes(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

/** Every Mag-Tools chat line starts with this (Shared/Debug.cs, spec §1). */
export const MT_PREFIX = '<{Mag-Tools}>: ';
/** A Mag-Tools chat line. */
export function mtLine(message: string): string {
  return MT_PREFIX + message;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const two = (n: number): string => String(n).padStart(2, '0');

/** .NET `ToString("ddd HH:mm")` in local time (the corpse list's Time, spec §5.3): `Sat 14:05`. */
export function mtDayTime(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** .NET `ToString("yy/MM/dd HH:mm")` in local time (the player list and chat logger Time, spec §5.4, §6.1). */
export function mtDateTime(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getFullYear() % 100)}/${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** .NET `ToString("yyMMddHHmmss")` in local time (a chat log file line's stamp, spec §4). */
export function mtFileStamp(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getFullYear() % 100)}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

/**
 * Mag-Tools' coordinates for a landblock (cell id) and its local x/y (Shared/Util.cs, spec §5.4):
 * NS = ((lbY − 0x7F) × 192 + y − 84) / 240, EW the same with lbX; the same origin as GoArrow's.
 */
export function mtCoords(cell: number, x: number, y: number): { ns: number; ew: number } {
  return {
    ns: ((((cell >>> 16) & 0xff) - 0x7f) * 192 + y - 84) / 240,
    ew: ((((cell >>> 24) & 0xff) - 0x7f) * 192 + x - 84) / 240,
  };
}

/** Decal's CoordsObject text, `12.3N, 45.6E` (one decimal, as our map readouts print it). */
export function mtCoordsText(cell: number, x: number, y: number): string {
  const c = mtCoords(cell, x, y);
  const f = (v: number) => Math.abs(v).toFixed(1);
  return `${f(c.ns)}${c.ns >= 0 ? 'N' : 'S'}, ${f(c.ew)}${c.ew >= 0 ? 'E' : 'W'}`;
}

/** A small text store (one value per key the host picks: per character, per server). */
export interface MtTextStore {
  get(): string | null;
  set(value: string): void;
  remove(): void;
}
