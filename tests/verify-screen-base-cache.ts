/**
 * The screen regression's base-side cache (tools/lib/screen-base-cache.ts, screen-regression.ts --base-cache): the
 * key, what a run must still capture, the store / rebuild round trip on real files, and the pruning.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CACHE_KEEP_BASES, PREWORLD_ONLY_FILTER, PREWORLD_UNIT, cacheDirFor, materializeBase, planBaseCapture, readCacheState, storeBaseCapture, touchAndPrune, variantKey,
} from '../tools/lib/screen-base-cache.ts';

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };
const SHA = 'a'.repeat(40);
const V = { era: '', gpu: false, account: 'acjsregress', extraQuery: '', ui: true };

/** A fake capture directory, as capture-ui-screens.ts writes it: panels at the top, the pre-world flow under preworld/. */
function captured(panels: string[], preworld: string[] = ['login', 'char-create']): string {
  const d = tmp('acjs-cap-');
  mkdirSync(join(d, 'preworld'), { recursive: true });
  for (const p of panels) writeFileSync(join(d, `${p}.png`), `png:${p}`);
  for (const p of preworld) writeFileSync(join(d, 'preworld', `${p}.png`), `png:pre:${p}`);
  writeFileSync(join(d, 'manifest.json'), '{}');
  return d;
}

describe('the cache key', () => {
  it('a variant names the era and renderer; account, page parameters and --ui change its hash', () => {
    expect(variantKey(V)).toMatch(/^eor-sw-[0-9a-f]{10}$/);
    expect(variantKey({ ...V, era: 'ac1999-retail', gpu: true })).toMatch(/^ac1999-retail-gpu-/);
    expect(variantKey({ ...V, account: 'other' })).not.toBe(variantKey(V));
    expect(variantKey({ ...V, extraQuery: 'datSet=x' })).not.toBe(variantKey(V));
    expect(variantKey({ ...V, ui: false })).not.toBe(variantKey(V));
    expect(variantKey({ ...V })).toBe(variantKey(V));
  });
  it('the directory is per full base sha (a ref or short sha is refused: it could move)', () => {
    expect(cacheDirFor('/c', SHA, 'eor-sw-x')).toBe(`/c/${SHA}/eor-sw-x`);
    expect(() => cacheDirFor('/c', 'origin/main', 'v')).toThrow(/full commit sha/);
    expect(() => cacheDirFor('/c', 'abc1234', 'v')).toThrow(/full commit sha/);
  });
});

describe('planBaseCapture', () => {
  const empty = { attempted: new Set<string>(), have: new Set<string>(), preworld: false };
  const full = { attempted: new Set(['inventory', 'hud-overview', PREWORLD_UNIT]), have: new Set(['inventory', 'hud-overview']), preworld: true };
  it('an empty cache captures what was asked', () => {
    expect(planBaseCapture(['inventory'], empty, 'reuse')).toEqual({ capture: true, filters: ['inventory'] });
  });
  it('everything cached: no base capture at all', () => {
    expect(planBaseCapture(['inventory', 'hud-overview'], full, 'reuse')).toEqual({ capture: false, filters: [] });
  });
  it('only the missing captures are taken; panels cached but no pre-world flow → a pre-world-only run', () => {
    expect(planBaseCapture(['inventory', 'map'], full, 'reuse')).toEqual({ capture: true, filters: ['map'] });
    expect(planBaseCapture(['inventory'], { ...full, preworld: false }, 'reuse')).toEqual({ capture: true, filters: [PREWORLD_ONLY_FILTER] });
  });
  it('a capture asked for before that produced nothing is not retried (attempted counts, not just PNGs)', () => {
    const s = { ...full, attempted: new Set([...full.attempted, 'inventory-sidepack']) };
    expect(planBaseCapture(['inventory', 'inventory-sidepack'], s, 'reuse')).toEqual({ capture: false, filters: [] });
  });
  it('refresh always captures; no filters (every capture) can never be served from the cache', () => {
    expect(planBaseCapture(['inventory'], full, 'refresh')).toEqual({ capture: true, filters: ['inventory'] });
    expect(planBaseCapture(null, full, 'reuse')).toEqual({ capture: true, filters: [] });
  });
});

describe('store → read → rebuild, on files', () => {
  it('a stored capture is read back, and the base dir is rebuilt from it with only the asked panels plus the pre-world flow', () => {
    const root = tmp('acjs-cache-');
    const dir = cacheDirFor(root, SHA, variantKey(V));
    storeBaseCapture(dir, captured(['inventory', 'hud-overview']), ['inventory', 'hud-overview', 'inventory-sidepack']);
    const st = readCacheState(dir);
    expect([...st.have].sort()).toEqual(['hud-overview', 'inventory']);
    expect([...st.attempted].sort()).toEqual(['hud-overview', 'inventory', 'inventory-sidepack', PREWORLD_UNIT]);
    expect(st.preworld).toBe(true);
    const out = join(tmp('acjs-out-'), 'base');
    const copied = materializeBase(dir, out, ['inventory', 'inventory-sidepack']);
    expect(copied.sort()).toEqual(['inventory', 'preworld/char-create', 'preworld/login']);
    expect(readFileSync(join(out, 'inventory.png'), 'utf8')).toBe('png:inventory');
    expect(existsSync(join(out, 'hud-overview.png'))).toBe(false); // not asked for this run
    expect(readdirSync(join(out, 'preworld')).sort()).toEqual(['char-create.png', 'login.png']);
  });
  it('a later partial store adds to the cache; a re-capture replaces a stale entry; a pre-world-only run adds no panel name', () => {
    const root = tmp('acjs-cache-');
    const dir = cacheDirFor(root, SHA, variantKey(V));
    storeBaseCapture(dir, captured(['inventory']), ['inventory']);
    storeBaseCapture(dir, captured(['map'], ['login']), ['map']);
    expect([...readCacheState(dir).have].sort()).toEqual(['inventory', 'map']);
    expect(readdirSync(join(dir, 'preworld'))).toEqual(['login.png']); // the newest pre-world flow, whole
    const fresh = captured([]);
    writeFileSync(join(fresh, 'inventory.png'), 'png:inventory-v2');
    storeBaseCapture(dir, fresh, ['inventory']);
    expect(readFileSync(join(dir, 'inventory.png'), 'utf8')).toBe('png:inventory-v2');
    storeBaseCapture(dir, captured([]), [PREWORLD_ONLY_FILTER]);
    expect(readCacheState(dir).attempted.has(PREWORLD_ONLY_FILTER)).toBe(false);
  });
  it('a panel asked for again that now produces nothing loses its stale PNG', () => {
    const root = tmp('acjs-cache-');
    const dir = cacheDirFor(root, SHA, variantKey(V));
    storeBaseCapture(dir, captured(['inventory-sidepack']), ['inventory-sidepack']);
    storeBaseCapture(dir, captured([]), ['inventory-sidepack']);
    expect(readCacheState(dir).have.has('inventory-sidepack')).toBe(false);
  });
});

describe('touchAndPrune', () => {
  it('keeps the newest bases by use and drops the rest; non-sha entries are left alone', () => {
    const root = tmp('acjs-cache-');
    const shas = Array.from({ length: CACHE_KEEP_BASES + 2 }, (_, i) => String(i).repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, 'a'));
    shas.forEach((s, i) => {
      mkdirSync(join(root, s, 'v'), { recursive: true });
      const t = new Date(Date.UTC(2026, 0, 1 + i));
      utimesSync(join(root, s), t, t);
    });
    mkdirSync(join(root, 'notes'));
    // Using the oldest marks it newest: it survives, the next two oldest go.
    const dropped = touchAndPrune(root, shas[0]);
    expect(dropped.sort()).toEqual([shas[1], shas[2]].sort());
    expect(existsSync(join(root, shas[0]))).toBe(true);
    expect(existsSync(join(root, 'notes'))).toBe(true);
    expect(readdirSync(root).filter((d) => d !== 'notes')).toHaveLength(CACHE_KEEP_BASES);
  });
});
