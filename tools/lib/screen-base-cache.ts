/**
 * The screen regression's base-side cache (the live gate's fast tier, 2026-11-07).
 *
 * The base side of tools/screen-regression.ts is the live web build. It doesn't change between deploys, yet every
 * run used to rebuild its worktree, start its Vite and capture every panel again (~7 min an era). With
 * `--base-cache <dir>` the base captures are kept per (base sha, variant, capture) and reused while the base is
 * unchanged; only captures not yet in the cache are taken. A variant is the era plus whatever else changes the
 * pixels (GPU or SwiftShader, the account, extra page parameters, --ui). tools/live-gate.sh keeps the cache in
 * the clone's git dir (<git common dir>/acjs-screen-cache), shared by every worktree and never tracked.
 *
 * Layout: <dir>/<base sha>/<variant>/<capture>.png, preworld/<name>.png, and attempted.json (every capture name
 * a base run was asked for, so one the base can't produce, e.g. a panel its character can't open, is not retried
 * on every run). The pre-world flow is captured by every run and cached as one unit (attempted name "preworld").
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The attempted-name entry that stands for the whole pre-world flow. */
export const PREWORLD_UNIT = 'preworld';
/** A capture filter that matches no panel: the base run then captures the pre-world flow alone. */
export const PREWORLD_ONLY_FILTER = '__preworld-only__';
/** Base shas kept in the cache (the newest by use); older ones are pruned. */
export const CACHE_KEEP_BASES = 4;

export interface VariantInput { era: string; gpu: boolean; account: string; extraQuery: string; ui: boolean }

/** The variant directory name: readable era + renderer, then a short hash of the rest. */
export function variantKey(v: VariantInput): string {
  const h = createHash('sha256').update(JSON.stringify([v.account, v.extraQuery, v.ui])).digest('hex').slice(0, 10);
  return `${v.era || 'eor'}-${v.gpu ? 'gpu' : 'sw'}-${h}`;
}

export function cacheDirFor(root: string, baseSha: string, variant: string): string {
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error(`base-cache needs a full commit sha, got "${baseSha}"`);
  return join(root, baseSha, variant);
}

/** What the cache holds for one (base, variant): capture names attempted, and which have a PNG. */
export interface CacheState { attempted: Set<string>; have: Set<string>; preworld: boolean }

export function readCacheState(dir: string): CacheState {
  const attempted = new Set<string>();
  try { for (const n of JSON.parse(readFileSync(join(dir, 'attempted.json'), 'utf8')) as string[]) attempted.add(n); } catch { /* none yet */ }
  const have = new Set<string>();
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.png')) have.add(f.slice(0, -4));
  const pre = join(dir, 'preworld');
  const preworld = attempted.has(PREWORLD_UNIT) && existsSync(pre) && readdirSync(pre).some((f) => f.endsWith('.png'));
  return { attempted, have, preworld };
}

/**
 * Whether the base side must be captured, and with which panel filters. `requested` null = every capture (no
 * filters): the cache can't say it holds "everything", so the base is captured in full (and stored).
 */
export function planBaseCapture(requested: readonly string[] | null, state: CacheState, mode: 'reuse' | 'refresh'): { capture: boolean; filters: string[] } {
  if (mode === 'refresh' || requested === null) return { capture: true, filters: requested ? [...requested] : [] };
  const missing = requested.filter((n) => !state.attempted.has(n));
  if (!missing.length && state.preworld) return { capture: false, filters: [] };
  // The pre-world flow comes with every base run; a run for it alone filters every panel out.
  return { capture: true, filters: missing.length ? missing : [PREWORLD_ONLY_FILTER] };
}

/** Store a fresh base capture directory into the cache: its PNGs, and the names it was asked for. */
export function storeBaseCapture(dir: string, capturedDir: string, askedFor: readonly string[]): void {
  mkdirSync(join(dir, 'preworld'), { recursive: true });
  const state = readCacheState(dir);
  for (const n of askedFor) if (n !== PREWORLD_ONLY_FILTER) { state.attempted.add(n); rmSync(join(dir, `${n}.png`), { force: true }); }
  if (existsSync(capturedDir)) for (const f of readdirSync(capturedDir)) if (f.endsWith('.png') && !f.startsWith('_')) copyFileSync(join(capturedDir, f), join(dir, f));
  const pre = join(capturedDir, 'preworld');
  if (existsSync(pre) && readdirSync(pre).some((f) => f.endsWith('.png'))) {
    rmSync(join(dir, 'preworld'), { recursive: true, force: true });
    mkdirSync(join(dir, 'preworld'), { recursive: true });
    for (const f of readdirSync(pre)) if (f.endsWith('.png') && !f.startsWith('_')) copyFileSync(join(pre, f), join(dir, 'preworld', f));
    state.attempted.add(PREWORLD_UNIT);
  }
  writeFileSync(join(dir, 'attempted.json'), `${JSON.stringify([...state.attempted].sort())}\n`);
}

/** Fill a base output directory from the cache: the requested panels it holds and the whole pre-world flow. */
export function materializeBase(dir: string, outDir: string, requested: readonly string[]): string[] {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'preworld'), { recursive: true });
  const copied: string[] = [];
  for (const n of requested) {
    const f = join(dir, `${n}.png`);
    if (existsSync(f)) { copyFileSync(f, join(outDir, `${n}.png`)); copied.push(n); }
  }
  const pre = join(dir, 'preworld');
  if (existsSync(pre)) for (const f of readdirSync(pre)) if (f.endsWith('.png')) { copyFileSync(join(pre, f), join(outDir, 'preworld', f)); copied.push(`preworld/${f.slice(0, -4)}`); }
  return copied;
}

/** Mark a base sha as used now (its directory's mtime), then drop all but the newest `keep` base shas. */
export function touchAndPrune(root: string, baseSha: string, keep = CACHE_KEEP_BASES): string[] {
  const now = new Date();
  const mine = join(root, baseSha);
  if (existsSync(mine)) utimesSync(mine, now, now);
  if (!existsSync(root)) return [];
  const bases = readdirSync(root).filter((d) => /^[0-9a-f]{40}$/.test(d))
    .map((d) => ({ d, t: statSync(join(root, d)).mtimeMs })).sort((a, b) => b.t - a.t);
  const dropped = bases.slice(keep).map((b) => b.d);
  for (const d of dropped) rmSync(join(root, d), { recursive: true, force: true });
  return dropped;
}
