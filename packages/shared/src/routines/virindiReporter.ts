/**
 * Virindi Reporter's numbers, rebuilt from its behaviour (MIT, VirindiPlugins
 * 2010–2011; facts only, reference/plugin-specs/reporter-statushud.md §A):
 * experience and luminance earned since the last reset, per hour over the
 * whole run and over the last five minutes, and the time to the next level.
 *
 * - Reset runs at login and on the window's Reset button. It takes one sample
 *   at once, then one a minute into two six-slot rings (XP and luminance). The
 *   five-minute rate is 12 × (newest − oldest slot), valid once the oldest
 *   XP slot holds a sample, i.e. five minutes after a reset.
 * - Luminance earned is the plain difference of AvailableLuminance, so
 *   spending it can make it negative (Reporter's own rule).
 * - The next level's experience comes from the era's XpTable. Past the
 *   table's end, Reporter's own formula, ceil(((L + 5)^5 − 6^5) / 9).
 *
 * Pure: time and the character's numbers are read through the injected
 * functions, so tests drive them.
 */
import { formatDotNet } from './vtankExpr.js';

export interface ReporterReads {
  /** TotalExperience (PropertyInt64 1); null before it has arrived. */
  xp(): number | null;
  /** AvailableLuminance (PropertyInt64 6); 0 where the era has none. */
  lum(): number;
  level(): number;
  /** The total experience a level needs (the era's XpTable), null past its end. */
  levelXp(level: number): number | null;
  now(): number;
}

export interface ReporterRate {
  ms: number;
  xp: number;
  xpPerHour: number;
  lum: number;
  lumPerHour: number;
  xp5PerHour: number;
  lum5PerHour: number;
  /** The five-minute rates hold a full five minutes. */
  fiveValid: boolean;
  /** The level after the current one, the experience still needed for it, and the time at the run's rate (null: never). */
  nextLevel: number;
  needed: number;
  etaMs: number | null;
}

const SAMPLE_MS = 60_000;
const SLOTS = 6;
/** The longest span .NET's TimeSpan holds; Reporter threw past it. Ours says INFINITY. */
const MAX_ETA_MS = 922_337_203_685;

/** Reporter's experience for a level: ceil(((level + 5)^5 − 6^5) / 9). */
export function reporterXpForLevel(level: number): number {
  return Math.ceil((Math.pow(level + 5, 5) - Math.pow(6, 5)) / 9);
}

/** A span as Reporter writes it: "HH:MM:SS", or "{days} days, HH:MM:SS" from a day up ("1 days" too). */
export function reporterDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const days = Math.floor(total / 86_400_000);
  const h = Math.floor((total % 86_400_000) / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const hms = [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
  return days > 0 ? `${days} days, ${hms}` : hms;
}

/** .NET N0: thousands separators, no decimals, half away from zero. */
export function reporterN0(n: number): string {
  const r = Math.sign(n) * Math.round(Math.abs(n));
  return formatDotNet(r === 0 ? 0 : r, 'N0');
}

export class ReporterXp {
  private startAt = 0;
  private startXp = 0;
  private startLum = 0;
  private samples = 0;
  private xpRing: number[] = new Array<number>(SLOTS).fill(-1);
  private lumRing: number[] = new Array<number>(SLOTS).fill(-1);
  private pointer = 0;
  started = false;

  constructor(private readonly reads: ReporterReads) {}

  /** Reset: start now from the current numbers, rings cleared, one sample at once. */
  reset(): void {
    const xp = this.reads.xp();
    if (xp === null) return;
    this.started = true;
    this.startAt = this.reads.now();
    this.startXp = xp;
    this.startLum = this.reads.lum();
    this.xpRing.fill(-1);
    this.lumRing.fill(-1);
    this.pointer = 0;
    this.samples = 0;
    this.sample();
  }

  private sample(): void {
    this.pointer = (this.pointer + 1) % SLOTS;
    this.xpRing[this.pointer] = this.reads.xp() ?? 0;
    this.lumRing[this.pointer] = this.reads.lum();
    this.samples++;
  }

  /** The minute samples that came due since the last call (one per minute from the reset). Call it often; it does nothing in between. */
  tick(): void {
    if (!this.started) return;
    const due = Math.floor((this.reads.now() - this.startAt) / SAMPLE_MS) + 1;
    while (this.samples < due) this.sample();
  }

  rate(): ReporterRate {
    const level = this.reads.level();
    const nextLevel = level + 1;
    const xpNow = this.reads.xp() ?? 0;
    const target = this.reads.levelXp(nextLevel) ?? reporterXpForLevel(nextLevel);
    const needed = target - xpNow;
    if (!this.started) return { ms: 0, xp: 0, xpPerHour: 0, lum: 0, lumPerHour: 0, xp5PerHour: 0, lum5PerHour: 0, fiveValid: false, nextLevel, needed, etaMs: null };
    this.tick();
    const ms = this.reads.now() - this.startAt;
    const hours = ms / 3_600_000;
    const xp = xpNow - this.startXp;
    const lum = this.reads.lum() - this.startLum;
    const oldest = (this.pointer + 1) % SLOTS;
    const fiveValid = this.xpRing[oldest]! !== -1;
    const xpPerHour = hours > 0 ? xp / hours : 0;
    const etaHours = xpPerHour > 0 ? needed / xpPerHour : null;
    const etaMs = etaHours === null ? null : Math.round(etaHours * 3_600_000);
    return {
      ms, xp, xpPerHour,
      lum, lumPerHour: hours > 0 ? lum / hours : 0,
      xp5PerHour: 12 * (this.xpRing[this.pointer]! - this.xpRing[oldest]!),
      lum5PerHour: 12 * (this.lumRing[this.pointer]! - this.lumRing[oldest]!),
      fiveValid, nextLevel, needed,
      etaMs: etaMs !== null && etaMs <= MAX_ETA_MS ? etaMs : null,
    };
  }

  /** The Report buttons' line (Reporter's GetReport). */
  report(): string {
    const r = this.rate();
    let s = `You've made ${reporterN0(r.xp)} XP in ${reporterDuration(r.ms)} for ${reporterN0(r.xpPerHour)} XP/hour`;
    if (r.fiveValid) s += ` (5min ${reporterN0(r.xp5PerHour)} XP/hour)`;
    s += `. ${reporterN0(r.needed)} XP to reach level ${r.nextLevel}, ETA ${r.etaMs === null ? 'INFINITY' : reporterDuration(r.etaMs)}.`;
    if (r.lum > 0) {
      s += ` Lum ${reporterN0(r.lum)} LP for ${reporterN0(r.lumPerHour)} LP/h`;
      if (r.fiveValid) s += `, 5min ${reporterN0(r.lum5PerHour)} LP/h`;
      s += '.';
    }
    return s;
  }

  /** What Reporter writes to the Status HUD under "VReporter", in its order. */
  hudEntries(): Array<[string, string]> {
    const r = this.rate();
    return [
      ['XP Earned', reporterN0(r.xp)],
      ['Luminance Earned', reporterN0(r.lum)],
      ['XP/Hour', `${reporterN0(r.xpPerHour)} xp/h`],
      ['Lum/Hour', `${reporterN0(r.lumPerHour)} lum/h`],
      ['XP/Hour (5min)', r.fiveValid ? `${reporterN0(r.xp5PerHour)} xp/h` : '---'],
      ['Lum/Hour (5min)', r.fiveValid ? `${reporterN0(r.lum5PerHour)} lum/h` : '---'],
      ['Runtime since XP reset', reporterDuration(r.ms)],
      ['Level ETA', r.etaMs === null ? 'INFINITY' : reporterDuration(r.etaMs)],
    ];
  }
}

/** The plugin name Reporter files its Status HUD entries under. */
export const REPORTER_HUD_PLUGIN = 'VReporter';
