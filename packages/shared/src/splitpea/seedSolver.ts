/**
 * Splitpea's taper solver (reference/plugin-specs/splitpea.md, "The maths it rests on").
 *
 * The 1999 formula personalisation (RandomizeVersion1, magic/SpellFormula.ts) writes tapers 2 and 3 as
 * (mul · ⌊seed / div⌋) mod 12 + Red Taper, where `seed` is ONE integer per account in 0 … 0x13D572. Every
 * taper the player has found is a constraint on that integer; the seeds that satisfy all of them are the
 * accounts' keys still possible, and a taper nobody found is settled when every one of them agrees.
 *
 * Honest by construction: the solver is handed only (mul, div, taper) constraints. It never sees an
 * account name or hash (that would be Spiltbeans, the cracked-code tool its author withdrew).
 *
 * Cost (measured in tests/verify-splitpea.ts): the first constraint scans all 1,299,827 seeds once;
 * each later one filters the seeds left (narrowing reuses the list), and removing one rescans.
 */
import { LOWEST_TAPER_ID, TAPER_COLOR_COUNT, VERSION1_SEED_MODULUS } from '../magic/SpellFormula.js';

/** A found taper: the term of its slot (version1Tapers) and the taper component it was. */
export interface TaperConstraint { mul: number; div: number; taper: number }

/** Taper component ids from Red Taper (63) on; the constraint's taper minus this is its colour index. */
const RED_TAPER = LOWEST_TAPER_ID;

const keyOf = (c: TaperConstraint): string => `${c.mul}/${c.div}=${c.taper}`;
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Seeds 0 … VERSION1_SEED_MODULUS-1 that satisfy every constraint. */
function scanAll(cs: readonly TaperConstraint[]): Uint32Array {
  const n = cs.length;
  const mul = cs.map((c) => c.mul);
  const div = cs.map((c) => c.div);
  const want = cs.map((c) => c.taper - RED_TAPER);
  const out = new Uint32Array(VERSION1_SEED_MODULUS);
  let k = 0;
  for (let s = 0; s < VERSION1_SEED_MODULUS; s++) {
    let ok = true;
    for (let i = 0; i < n; i++) {
      if ((mul[i] * Math.floor(s / div[i])) % TAPER_COLOR_COUNT !== want[i]) { ok = false; break; }
    }
    if (ok) out[k++] = s;
  }
  return out.slice(0, k);
}

/** Keep the seeds in `cands` that satisfy `cs` (a new array; `cands` is untouched). */
function filter(cands: Uint32Array, cs: readonly TaperConstraint[]): Uint32Array {
  const out = new Uint32Array(cands.length);
  let k = 0;
  outer: for (let j = 0; j < cands.length; j++) {
    const s = cands[j];
    for (const c of cs) if ((c.mul * Math.floor(s / c.div)) % TAPER_COLOR_COUNT !== c.taper - RED_TAPER) continue outer;
    out[k++] = s;
  }
  return out.slice(0, k);
}

export class SeedSolver {
  private list: TaperConstraint[] = [];
  /** The seeds left; null while there is no constraint (every seed). */
  private cands: Uint32Array | null = null;
  /** Colour masks per term, for the seeds left now. */
  private masks = new Map<string, number>();
  /** Scans over every seed so far (the first constraint, and each rebuild after a removal). */
  fullScans = 0;
  /** Narrowings that reused the seeds left. */
  narrowings = 0;

  get constraints(): readonly TaperConstraint[] { return this.list; }
  /** How many seeds (account keys) are still possible. */
  get count(): number { return this.cands ? this.cands.length : VERSION1_SEED_MODULUS; }
  /** The seeds left (a copy), or null for every seed. */
  candidates(): Uint32Array | null { return this.cands ? this.cands.slice() : null; }

  /**
   * Make `next` the constraints. A superset of the current ones narrows the seeds left by the added
   * ones; anything else (a removal or a change) rebuilds from every seed.
   */
  set(next: readonly TaperConstraint[]): void {
    const uniq = new Map<string, TaperConstraint>();
    for (const c of next) uniq.set(keyOf(c), { mul: c.mul, div: c.div, taper: c.taper });
    const have = new Set(this.list.map(keyOf));
    const isSuperset = [...have].every((k) => uniq.has(k));
    const added = [...uniq.entries()].filter(([k]) => !have.has(k)).map(([, c]) => c);
    if (isSuperset && added.length === 0) return;
    this.masks.clear();
    if (isSuperset) {
      if (this.cands) { this.cands = filter(this.cands, added); this.narrowings++; }
      else { this.cands = scanAll(added); this.fullScans++; }
      this.list = [...this.list, ...added];
      return;
    }
    this.list = [...uniq.values()];
    if (this.list.length === 0) { this.cands = null; return; }
    this.cands = scanAll(this.list);
    this.fullScans++;
  }

  /**
   * The taper colours (bit i = Red Taper + i) the term (mul, div) gives over the seeds left. 0 when no
   * seed is left (the found tapers disagree).
   */
  colours(t: { mul: number; div: number }): number {
    const key = `${t.mul}/${t.div}`;
    const memo = this.masks.get(key);
    if (memo !== undefined) return memo;
    // (mul · q) mod 12 only reaches the multiples of gcd(mul, 12): stop once all of those are seen.
    const g = gcd(((t.mul % TAPER_COLOR_COUNT) + TAPER_COLOR_COUNT) % TAPER_COLOR_COUNT, TAPER_COLOR_COUNT) || TAPER_COLOR_COUNT;
    let full = 0;
    for (let v = 0; v < TAPER_COLOR_COUNT; v += g) full |= 1 << v;
    let m = 0;
    const cands = this.cands;
    if (cands) {
      for (let j = 0; j < cands.length && m !== full; j++) m |= 1 << ((t.mul * Math.floor(cands[j] / t.div)) % TAPER_COLOR_COUNT);
    } else {
      for (let s = 0; s < VERSION1_SEED_MODULUS && m !== full; s++) m |= 1 << ((t.mul * Math.floor(s / t.div)) % TAPER_COLOR_COUNT);
    }
    this.masks.set(key, m);
    return m;
  }
}

/** The taper component ids in a colour mask, Red Taper first. */
export function coloursToTapers(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < TAPER_COLOR_COUNT; i++) if (mask & (1 << i)) out.push(RED_TAPER + i);
  return out;
}
